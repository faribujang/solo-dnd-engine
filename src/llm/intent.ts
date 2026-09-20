import type { GameState } from "../schema/state.js";
import type { Action } from "../engine/turn.js";
import { Intent, CONFIDENCE_FLOOR } from "./contracts.js";
import type { LLMClient } from "./client.js";
import { itemsAt, itemsOwnedBy, npcsPresent, pc, visibleExits } from "../state/selectors.js";
import { canFastTravel, reachable } from "../engine/pathfind.js";
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

      // People say where they are going, not which compass point it is on. The model puts
      // that in `direction` sometimes and `target_name` other times, and which one it
      // picked is not the player's problem — so try both.
      const said = placeWord(intent.direction) || placeWord(intent.target_name);

      const exact = exits.find((x) => x.dir.toLowerCase() === said);
      if (exact) return { ok: true, intent, action: { type: "move", dir: exact.dir } };

      // Named the destination rather than the way to it. Match either direction, so both
      // "the green" and "green" find "The Green".
      const byName = said.length > 2 ? exits.find((x) => nameMatches(s.locations[x.to]?.name, said)) : undefined;
      if (byName) return { ok: true, intent, action: { type: "move", dir: byName.dir } };

      /**
       * Somewhere they have BEEN, but not through a door in this room.
       *
       * `travel` already existed, with a cost, a route and an affordance — and no way to
       * reach it except by tapping the button, because this mapper only ever produced
       * `move`. Naming a place two rooms away therefore failed forever, and failed with a
       * list of compass directions, which reads as the game refusing a legal move. It is
       * the most common thing anyone types.
       */
      const gate = canFastTravel(s);
      const far = said.length > 2
        ? reachable(s, loc.id).find((r) => nameMatches(s.locations[r.id]?.name, said))
        : undefined;
      if (far) {
        if (!gate.ok) return { ok: false, intent, clarify: gate.reason };
        return { ok: true, intent, action: { type: "travel", location_id: far.id } };
      }

      /**
       * "Go to Hob Tanner and ask him about the pitch."
       *
       * Crossing a room to somebody is not travel, and answering it with "that is not a
       * location" is the game correcting the player's English rather than understanding
       * it. If what they named is a person standing here, they meant to go and talk to
       * them, and that is one action.
       */
      const person = said.length > 2 ? (findEntity(said) ?? findAnyone(s, said)) : null;
      if (person && s.entities[person]?.location_id === loc.id) {
        return {
          ok: true, intent,
          action: { type: "talk", target_id: person, ...(intent.topic ? { topic: intent.topic } : {}) },
        };
      }
      // Named somebody real who is somewhere else: say where, rather than "no such place".
      if (person) {
        const them = s.entities[person]!;
        const where = s.locations[them.location_id];
        const known = where && (where.discovered || where.visited_count > 0);
        return {
          ok: false, intent,
          clarify: known
            ? `${them.name} is not here — you last knew them to be at ${where.name}.`
            : `${them.name} is not here, and you do not know where they are.`,
        };
      }

      // Only now is it genuinely unclear — and the question names PLACES, because "north,
      // out, down" is not something anyone can answer about a village they are standing in.
      const here = exits
        .map((x) => { const d = s.locations[x.to]; return d ? `${d.name} (${x.dir})` : x.dir; });
      const known = gate.ok
        ? reachable(s, loc.id).slice(0, 6).map((r) => `${s.locations[r.id]!.name} (${r.path.minutes} min)`)
        : [];
      const lines = [
        here.length ? `From here: ${here.join(", ")}.` : "There is no way out of here.",
        known.length ? `Further off, that you know: ${known.join(", ")}.` : "",
      ].filter(Boolean);
      return { ok: false, intent, clarify: `Where to? ${lines.join(" ")}` };
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
      /**
       * LEANING ON SOMEBODY IS A CHECK, NOT A CHAT.
       *
       * `dialogue_intent` was parsed and then thrown away, so "persuade Sibby to take the
       * high ridge" produced an ordinary conversation with no roll — ever. The player
       * types the name of a skill, watches nothing happen, and reasonably concludes the
       * game does not have one.
       *
       * Persuading, lying and threatening are attempts that can FAIL, and an attempt that
       * cannot fail is not an attempt. Asking and chatting are not: those stay talk.
       */
      const SOCIAL_SKILL = {
        persuade: "persuasion",
        deceive: "deception",
        intimidate: "intimidation",
      } as const;
      const leaning = intent.dialogue_intent
        ? SOCIAL_SKILL[intent.dialogue_intent as keyof typeof SOCIAL_SKILL]
        : undefined;

      if (leaning) {
        return {
          ok: true, intent,
          action: {
            type: "skill_check",
            skill: leaning,
            band: intent.difficulty_band ?? "medium",
            target_id: id,
            ...(intent.topic ? { tag: intent.topic.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40) } : {}),
          },
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
      /**
       * Zones are a COMBAT concept. Out of a fight there is no such thing as crossing
       * one, so a player saying "go to the bakehouse" who lands here was misread — and
       * the reply they got, "Move where? Zones here: by the well, the moot stone", is
       * indistinguishable from the game refusing to let them walk across a village.
       *
       * The model cannot be relied on for this and does not have to be: whether a fight
       * is happening is something code knows exactly.
       */
      if (!s.combat) return toAction(s, { ...intent, action: "move" });

      const zones = loc.zones;
      const n = intent.direction?.toLowerCase() ?? intent.target_name?.toLowerCase() ?? "";
      const z = zones.find((x) => x.id === n || x.name.toLowerCase().includes(n) && n.length > 2);
      if (!z) {
        // Naming somewhere outside the fight is the usual way to land here, and a bare
        // list of zones does not explain why the village is suddenly out of reach.
        const named = placeWord(intent.direction) || placeWord(intent.target_name);
        const elsewhere = named.length > 2 && !zones.some((x) => nameMatches(x.name, named));
        return {
          ok: false, intent,
          clarify: elsewhere
            ? `You are in a fight — you cannot walk to ${named} from inside it. Here you can cross to: ${zones.map((x) => x.name).join(", ") || "nowhere"}. To leave altogether, flee.`
            : `Move where? Zones here: ${zones.map((x) => x.name).join(", ") || "none"}.`,
        };
      }
      return { ok: true, intent, action: { type: "move_zone", zone_id: z.id } };
    }

    case "montage": {
      // The topic is whatever they said they were after; an empty one is an idle morning,
      // which is legal and still costs the hours.
      const topic = (intent.topic ?? intent.target_name ?? "").trim();
      return {
        ok: true, intent,
        action: {
          type: "montage",
          kind: intent.montage_kind ?? "ask_around",
          topic,
          band: intent.difficulty_band ?? "medium",
        },
      };
    }

    case "wait":
      // The clamp lives in the resolver (MAX_WAIT_MINUTES) so it holds for every entry
      // point, not just for text a model read. This only supplies a sensible default.
      return { ok: true, intent, action: { type: "wait", minutes: Math.max(1, intent.minutes ?? 10) } };

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
  "",
  "CHOOSING THE ACTION. The names below are not self-explanatory, and picking the wrong one",
  "reads to a player as the game not understanding plain English:",
  "- A QUESTION ABOUT THE GAME is `ask`, never an action. It costs no time and changes",
  "  nothing. Set `question` to one of: options, surroundings, who, reach, condition, know,",
  "  carrying, doing, time.",
  "    \"what can I do\" / \"what are my options\" / \"what should I do\" / \"help\"  -> ask, options",
  "    \"what's here\" / \"look around\" / \"describe the room\"                    -> ask, surroundings",
  "    \"who is here\"                                                          -> ask, who",
  "    \"where can I go\" / \"what are the exits\"                               -> ask, reach",
  "    \"what am I carrying\" / \"what's in my pack\"                            -> ask, carrying",
  "    \"how hurt am I\"                                                        -> ask, condition",
  "    \"what was I doing\" / \"what am I meant to be doing\"                    -> ask, doing",
  "  `inventory` is NOT how you answer a question. Use ask/carrying.",
  "- GOING SOMEWHERE is `move`, and put the place the player named in `direction` exactly as",
  "  they said it — \"the bakehouse\", not a compass point. The engine resolves the name, and",
  "  it can also travel to somewhere further off that they already know.",
  "- `move_zone` is ONLY for crossing a zone inside a fight. If no fight is happening it is",
  "  always wrong; use `move`.",
  "- `end_turn`, `dash`, `disengage`, `dodge` and `flee` are also combat-only.",
  "- TRYING TO MOVE SOMEBODY is a check, and you mark it with `dialogue_intent`:",
  "    persuade / deceive / intimidate — talking them into something they were not going",
  "    to do. These ROLL. Set `difficulty_band` from how hard a sell it is.",
  "    inquire / chat — asking, listening, passing the time. These do not roll.",
  "  \"persuade Sibby to take the ridge\", \"lie about where we were\", \"threaten him\" are",
  "  all the first kind. \"ask Sibby what she sees\" is the second.",
  "- SPENDING HOURS on something open-ended is `montage`, not a single check. Use it",
  "  whenever the player describes a stretch of time or a plural target rather than one",
  "  act on one person: \"ask around about the surveyor\", \"spend the morning searching\",",
  "  \"watch the tollgate all afternoon\", \"work the forge and listen\". Put what they are",
  "  after in `topic`, and set `montage_kind` to ask_around, search, watch or work.",
  "  A montage takes hours of game time, so do NOT use it for a single question to a",
  "  single person — that is `talk`.",
].join("\n");

/**
 * What the player actually named, with the words that carry no information removed.
 *
 * "go to the bakehouse", "to The Bakehouse", "the bakehouse" and "bakehouse" are one
 * request. Stripping them here means every caller compares the same thing.
 */
/**
 * Somebody by name, anywhere in the world the player could know about.
 *
 * `findEntity` deliberately searches only the room — for targeting, that is correct, since
 * you cannot stab somebody two villages away. But "go to Hob Tanner" is not targeting, it
 * is asking where he is, and answering "that is not a location" teaches the player that
 * the game does not know its own cast. Restricted to people already met, so this cannot
 * become a way to ask the engine where anyone is.
 */
function findAnyone(s: GameState, said: string): string | null {
  const me = s.meta.pc_id;
  const met = new Set<string>();
  for (const key of Object.keys(s.relationships)) {
    const [a, b] = key.split("->");
    if (a === me && b) met.add(b);
    if (b === me && a) met.add(a);
  }

  const n = said.toLowerCase().trim();
  if (n.length < 3) return null;
  for (const id of [...met].sort()) {
    const e = s.entities[id];
    if (!e || !e.alive || e.kind === "monster") continue;
    const forms = [e.id.toLowerCase(), e.name.toLowerCase(), ...e.aliases.map((a) => a.toLowerCase())];
    if (forms.some((f) => f === n || n.includes(f) || (f.includes(n) && n.length >= 4))) return e.id;
  }
  return null;
}

function placeWord(raw: string | null | undefined): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/^\s*(go|walk|head|move|travel|run|ride)\s+/, "")
    .replace(/^\s*(to|towards|toward|into|in|over to|back to|for)\s+/, "")
    .replace(/^\s*the\s+/, "")
    .replace(/[.!?,]+$/, "")
    .trim();
}

/** Whether a place name and what the player said are the same place. */
function nameMatches(name: string | undefined, said: string): boolean {
  if (!name || said.length < 3) return false;
  const n = name.toLowerCase().replace(/^the\s+/, "");
  return n === said || n.includes(said) || said.includes(n);
}

function renderIntentPrompt(s: GameState, playerText: string): string {
  const player = pc(s);
  const loc = s.locations[player.location_id]!;
  const here = npcsPresent(s, loc.id);
  const loose = itemsAt(s, loc.id);
  const held = itemsOwnedBy(s, player.id);

  return [
    // Half the action vocabulary is combat-only, and the model was never told which mode
    // the game is in.
    s.combat ? `## A FIGHT IS HAPPENING. Combat verbs and zones are available.`
             : `## NO FIGHT. Combat verbs and zones are NOT available; walking is \`move\`.`,
    ``,
    `## LOCATION`,
    `${loc.name}. ${loc.short_desc}`,
    // Directions alone are useless to a model asked to interpret "go to the bakehouse".
    `Exits: ${visibleExits(s, loc).map((x) => `${x.dir} -> ${s.locations[x.to]?.name ?? "?"}`).join(", ") || "none"}`,
    `Places you already know, further off: ${reachable(s, loc.id).slice(0, 8).map((r) => s.locations[r.id]!.name).join(", ") || "none"}`,
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
