import type { GameState } from "../schema/state.js";
import type { Action } from "../engine/turn.js";
import { Intent, CONFIDENCE_FLOOR } from "./contracts.js";
import type { LLMClient } from "./client.js";
import { itemsAt, itemsOwnedBy, npcsPresent, pc, visibleExits } from "../state/selectors.js";
import { SKILL_ABILITY } from "../rules/checks.js";
import type { QuestionKind } from "../engine/questions.js";

/**
 * Step 1: INTENT PARSE.
 *
 * Free text in, a structured proposal out. The model's job here is translation, not
 * adjudication: it may say "this is a Stealth attempt of medium difficulty", and it may
 * never say whether the attempt worked or what DC it faced.
 */

export type IntentResult =
  | { ok: true; action: Action; intent: Intent }
  | { ok: false; clarify: string; intent: Intent | null }
  /** A question, not an action. Costs nothing and produces no event. */
  | { ok: false; question: QuestionKind; subject: string | null; intent: Intent };

export async function parseIntent(
  llm: LLMClient,
  s: GameState,
  playerText: string,
): Promise<IntentResult> {
  const res = await llm.complete({
    role: "intent",
    system: SYSTEM,
    user: renderIntentPrompt(s, playerText),
    schema: Intent,
    schemaName: "Intent",
    maxTokens: 500,
    temperature: 0,
  });

  return toAction(s, res.value);
}

/**
 * Turn a parsed intent into a legal Action, resolving the loose names the model used into
 * real ids. Anything that cannot be resolved becomes a question for the player rather than
 * a guess — a wrong guess costs a turn and, worse, teaches the player the game is arbitrary.
 */
export function toAction(s: GameState, intent: Intent): IntentResult {
  const player = pc(s);
  const loc = s.locations[player.location_id]!;

  if (intent.action === "unclear" || intent.confidence < CONFIDENCE_FLOOR) {
    return {
      ok: false,
      intent,
      clarify: intent.action === "unclear"
        ? "I did not follow that. What are you trying to do?"
        : `Did you mean to ${intent.action.replace("_", " ")}? Say it another way and I will follow.`,
    };
  }

  /**
   * Resolve a loose name to someone present.
   *
   * A model hands back whatever the player typed, which is usually a phrase rather than a
   * name — "thorne about the bell", "the old innkeeper", "him". So this widens in stages
   * instead of demanding an exact string, and gives up only when nothing overlaps at all.
   */
  const findEntity = (name: string | null): string | null => {
    const here = npcsPresent(s, loc.id);
    if (here.length === 0) return null;
    if (!name) return null;

    const n = name.toLowerCase().trim();
    const forms = (e: (typeof here)[number]) => [
      e.id.toLowerCase(), e.name.toLowerCase(), ...e.aliases.map((a) => a.toLowerCase()),
    ];

    // 1. Exact, against id, full name or alias.
    const exact = here.find((e) => forms(e).includes(n));
    if (exact) return exact.id;

    // 2. The phrase contains a name, or a name contains the phrase. Catches both
    //    "thorne about the bell" and "black".
    const overlap = here.find((e) =>
      forms(e).some((f) => n.includes(f) || (f.includes(n) && n.length >= 3)));
    if (overlap) return overlap.id;

    // 3. Any substantial word in common. Catches "the innkeeper thorne".
    const words = new Set(n.split(/[^a-z']+/).filter((w) => w.length >= 3));
    const byWord = here.find((e) =>
      forms(e).some((f) => f.split(/[^a-z']+/).some((w) => w.length >= 3 && words.has(w))));
    if (byWord) return byWord.id;

    return null;
  };

  /**
   * The only other living soul in the room — but ONLY when the player named nobody, or
   * used a pronoun.
   *
   * If they named someone and that name did not resolve, falling through to "whoever is
   * standing here" is dangerous: "attack the bonepicker" would swing at the guard instead,
   * and an attack on the wrong person cannot be taken back. A name that misses is a
   * question, never a substitution.
   */
  const PRONOUNS = new Set(["it", "him", "her", "them", "they", "he", "she", "that", "this", "again"]);
  const soleOther = (named: string | null): string | null => {
    const n = named?.toLowerCase().trim() ?? "";
    const isVague = n === "" || n.split(/\s+/).every((w) => PRONOUNS.has(w));
    if (!isVague) return null;
    // A pronoun continues a fight; it does not start one. "Hit it again" with no fight on
    // and one bystander in the room is a question, not an assault.
    if (!s.combat) return null;
    const here = npcsPresent(s, loc.id).filter((e) => s.combat!.order.some((x) => x.entity_id === e.id && x.side === "enemy" && !x.fled));
    return here.length === 1 ? here[0]!.id : null;
  };

  switch (intent.action) {
    case "ask": {
      // Asking is free. It never becomes an action, never advances the turn, and never
      // reaches the resolver.
      const named = intent.target_name ? findEntity(intent.target_name) : null;
      return { ok: false, intent, question: intent.question ?? "surroundings", subject: named };
    }

    case "look":
      return { ok: true, intent, action: { type: "look" } };

    case "inventory":
    case "meta":
      return { ok: false, intent, clarify: "__meta__" };

    case "move": {
      const exits = visibleExits(s, loc);
      const dir = intent.direction?.toLowerCase().trim() ?? "";
      const exact = exits.find((x) => x.dir.toLowerCase() === dir);
      if (exact) return { ok: true, intent, action: { type: "move", dir: exact.dir } };

      // The model may have named the destination rather than the direction.
      const byName = exits.find((x) => {
        const dest = s.locations[x.to];
        return dest ? dest.name.toLowerCase().includes(dir) && dir.length > 2 : false;
      });
      if (byName) return { ok: true, intent, action: { type: "move", dir: byName.dir } };

      return {
        ok: false, intent,
        clarify: `Which way? From here you can go: ${exits.map((x) => x.dir).join(", ") || "nowhere"}.`,
      };
    }

    case "attack": {
      // "hit it again" carries no usable name. When there is exactly one other person in
      // the room and the player has said "attack", the referent is not in doubt.
      const id = findEntity(intent.target_name) ?? soleOther(intent.target_name);
      if (!id) {
        const here = npcsPresent(s, loc.id).map((e) => e.name);
        return {
          ok: false, intent,
          clarify: here.length ? `Attack whom? Here: ${here.join(", ")}.` : "There is nobody here to attack.",
        };
      }
      return { ok: true, intent, action: { type: "attack", target_id: id } };
    }

    case "talk": {
      const id = findEntity(intent.target_name);
      if (!id) {
        const here = npcsPresent(s, loc.id).map((e) => e.name);
        return {
          ok: false, intent,
          clarify: here.length ? `Speak to whom? Here: ${here.join(", ")}.` : "There is nobody here to talk to.",
        };
      }
      return {
        ok: true, intent,
        action: { type: "talk", target_id: id, ...(intent.topic ? { topic: intent.topic } : {}) },
      };
    }

    case "take": {
      const here = itemsAt(s, loc.id);
      const n = intent.item_name?.toLowerCase().trim() ?? "";
      const hit = here.find(
        (i) => i.id === intent.item_name || (s.item_defs[i.def_id]?.name.toLowerCase().includes(n) && n.length > 1),
      );
      if (!hit) {
        return {
          ok: false, intent,
          clarify: here.length
            ? `Take what? Lying here: ${here.map((i) => s.item_defs[i.def_id]?.name).join(", ")}.`
            : "There is nothing here to pick up.",
        };
      }
      return { ok: true, intent, action: { type: "take", item_instance_id: hit.id } };
    }

    case "give": {
      const target = findEntity(intent.target_name);
      const n = intent.item_name?.toLowerCase().trim() ?? "";
      const held = itemsOwnedBy(s, player.id).find(
        (i) => s.item_defs[i.def_id]?.name.toLowerCase().includes(n) && n.length > 1,
      );
      if (!target || !held) {
        return { ok: false, intent, clarify: "Give what, and to whom?" };
      }
      return { ok: true, intent, action: { type: "give", target_id: target, item_instance_id: held.id } };
    }

    case "rest":
      return { ok: true, intent, action: { type: "rest", kind: intent.rest_kind ?? "short" } };

    case "end_turn": return { ok: true, intent, action: { type: "end_turn" } };
    case "dash": return { ok: true, intent, action: { type: "dash" } };
    case "disengage": return { ok: true, intent, action: { type: "disengage" } };
    case "dodge": return { ok: true, intent, action: { type: "dodge" } };
    case "flee": return { ok: true, intent, action: { type: "flee" } };
    case "move_zone": {
      const zones = loc.zones;
      const n = intent.direction?.toLowerCase() ?? intent.target_name?.toLowerCase() ?? "";
      const z = zones.find((x) => x.id === n || x.name.toLowerCase().includes(n) && n.length > 2);
      if (!z) return { ok: false, intent, clarify: `Move where? Zones here: ${zones.map((x) => x.name).join(", ") || "none"}.` };
      return { ok: true, intent, action: { type: "move_zone", zone_id: z.id } };
    }

    case "wait":
      // Cap what a single "wait" can burn, so a typo does not skip a deadline.
      return { ok: true, intent, action: { type: "wait", minutes: Math.min(720, Math.max(1, intent.minutes ?? 10)) } };

    case "trade":
    case "use_item":
    case "cast":
      // Honest about the boundary rather than silently doing something else. These arrive
      // in phase 4 with the combat and inventory systems.
      return {
        ok: false, intent,
        clarify: `${intent.action.replace("_", " ")} is not implemented yet — try something else for now.`,
      };

    case "skill_check": {
      const skill = intent.skill;
      if (!skill) {
        return { ok: false, intent, clarify: "What are you trying to do, exactly?" };
      }
      const target = findEntity(intent.target_name);
      // The model proposes a band; if it declined to, assume the middle rather than the
      // easiest. An unspecified attempt should not default to a free win.
      const band = intent.difficulty_band ?? "medium";
      return {
        ok: true, intent,
        action: {
          type: "skill_check", skill, band,
          ...(target ? { target_id: target } : {}),
          ...(intent.tag ? { tag: intent.tag } : {}),
        },
      };
    }
  }
}

const SYSTEM = [
  "You translate a player's free text into one structured action for a D&D 5e engine.",
  "",
  "You are a TRANSLATOR, not a referee:",
  "- Never decide whether an action succeeds. That is the engine's job.",
  "- Never invent a DC. Propose a difficulty BAND and nothing more.",
  "- Choose the band from the fiction: routine is easy, contested is medium, long odds are",
  "  hard. Do not soften a band because you want the player to succeed.",
  "- If the player names a target, put their exact words in target_name. Do not guess ids.",
  "- `tag` names what the attempt is FOR in one snake_case word: search, listen, sneak,",
  "  read_ledger. Use an existing tag from the scene if one fits.",
  "- If you cannot tell what they mean, answer `unclear` with low confidence. Guessing wrong",
  "  costs the player a turn and teaches them the game is arbitrary.",
].join("\n");

function renderIntentPrompt(s: GameState, playerText: string): string {
  const player = pc(s);
  const loc = s.locations[player.location_id]!;
  const here = npcsPresent(s, loc.id);
  const loose = itemsAt(s, loc.id);
  const held = itemsOwnedBy(s, player.id);

  return [
    `## LOCATION`,
    `${loc.name}. ${loc.short_desc}`,
    `Exits: ${visibleExits(s, loc).map((x) => x.dir).join(", ") || "none"}`,
    ``,
    `## PRESENT`,
    here.length ? here.map((e) => `${e.name} (${e.aliases.join(", ") || "no aliases"})`).join("\n") : "nobody",
    ``,
    `## ITEMS HERE`,
    loose.map((i) => s.item_defs[i.def_id]?.name).join(", ") || "nothing",
    ``,
    `## CARRIED`,
    held.map((i) => s.item_defs[i.def_id]?.name).join(", ") || "nothing",
    ``,
    `## SKILLS AVAILABLE`,
    Object.keys(SKILL_ABILITY).join(", "),
    ``,
    `PLAYER SAID: ${playerText}`,
  ].join("\n");
}
