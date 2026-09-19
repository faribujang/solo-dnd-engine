import type { Effect } from "../schema/dsl.js";
import type { GameState } from "../schema/state.js";
import { NARRATOR_ALLOWED_EFFECTS } from "../schema/dsl.js";
import { canAdmit } from "../rules/cast.js";

/** New named people one turn may invent. A scene introduces someone; it does not cast. */
const MAX_NEW_LOCALS_PER_TURN = 1;

/** Named people one place can hold before it stops being a place and becomes a crowd. */
const MAX_NAMED_IN_ONE_PLACE = 14;
import { ATTITUDE_CLAMP_PER_TURN } from "../schema/relationship.js";
import { NarratorProposal } from "./contracts.js";
import type { Narration } from "./contracts.js";

/**
 * Step 6: COMMIT PROPOSALS.
 *
 * The narrator's output arrives here as a wish list. Nothing it asked for reaches state
 * until this file agrees. Anything unrecognised, out of range, or naming something that
 * does not exist is dropped and written to rejects.jsonl — never applied, never silently
 * accepted, and never quietly "fixed" into something adjacent that the model didn't ask for.
 *
 * Read rejects.jsonl often. It is the single best debugging signal in the system: it tells
 * you exactly where the model is trying to reach past its authority.
 */

export interface Reject {
  turn: number;
  kind: "proposal" | "attitude" | "fact" | "opinion" | "narration";
  reason: string;
  /** What the model actually asked for. */
  payload: unknown;
}

export interface ValidatedNarration {
  effects: Effect[];
  /** Attitude changes, already clamped, expressed as effects. */
  narration: string;
  suggestedActions: string[];
  rejects: Reject[];
  /** Ids the narrator named that resolved successfully, for the debug view. */
  resolved: Record<string, string>;
}

const MAX_NARRATOR_MINUTES = 60;
const MAX_FACTS_PER_TURN = 4;
const MAX_PROPOSALS_PER_TURN = 6;

export function validateNarration(
  s: GameState,
  n: Narration,
  ctx: { presentEntityIds: readonly string[]; locationId: string },
): ValidatedNarration {
  const rejects: Reject[] = [];
  const effects: Effect[] = [];
  const resolved: Record<string, string> = {};
  const turn = s.meta.turn;

  const reject = (kind: Reject["kind"], reason: string, payload: unknown) =>
    rejects.push({ turn, kind, reason, payload });

  /** Resolve whatever the model called something into a real entity id, or nothing. */
  const entityId = (name: string): string | null => {
    if (!name) return null;
    if (s.entities[name]) return name;
    const n = name.toLowerCase().trim();
    if (n === "you" || n === "the player" || n === "pc") return s.meta.pc_id;
    const hit = Object.values(s.entities).find(
      (e) =>
        e.name.toLowerCase() === n ||
        e.aliases.some((a) => a.toLowerCase() === n) ||
        e.name.toLowerCase().split(" ")[0] === n,
    );
    if (hit) resolved[name] = hit.id;
    return hit?.id ?? null;
  };

  // ------------------------------------------------------------- narration
  let narration = n.narration.trim();
  if (narration === "") {
    reject("narration", "empty narration", n.narration);
    narration = "…";
  }
  // A narrator that starts inventing dice has lost the plot; strip it rather than ship it.
  if (/\b(you roll|rolls? a \d+|DC \d+|d20)\b/i.test(narration)) {
    reject("narration", "narration referred to dice or a DC, which is the engine's business", narration);
  }

  // ----------------------------------------------------------------- facts
  for (const f of n.facts.slice(0, MAX_FACTS_PER_TURN)) {
    if (f.text.trim().length < 4) {
      reject("fact", "fact text too short to be meaningful", f);
      continue;
    }
    const subjects = f.subjects.map(entityId).filter((x): x is string => x !== null);
    effects.push({
      t: "add_fact",
      text: f.text.trim(),
      subjects,
      importance: Math.min(4, f.importance) as 1 | 2 | 3 | 4,   // only authors get importance 5
      secret: f.secret,
      known_by: [s.meta.pc_id],
    });
  }
  if (n.facts.length > MAX_FACTS_PER_TURN) {
    reject("fact", `more than ${MAX_FACTS_PER_TURN} facts in one turn; kept the first ${MAX_FACTS_PER_TURN}`, n.facts.length);
  }

  // ------------------------------------------------------------- attitudes
  for (const a of n.attitude_deltas) {
    const subject = entityId(a.subject);
    const object = entityId(a.object);
    if (!subject || !object) {
      reject("attitude", `could not resolve ${!subject ? `subject "${a.subject}"` : `object "${a.object}"`}`, a);
      continue;
    }
    if (!ctx.presentEntityIds.includes(subject)) {
      reject("attitude", `${subject} is not present; absent characters do not form opinions this turn`, a);
      continue;
    }

    const dims: Record<string, number> = {};
    let clampedAny = false;
    for (const [dim, raw] of Object.entries(a.dims)) {
      if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
      const bounded = Math.max(-ATTITUDE_CLAMP_PER_TURN, Math.min(ATTITUDE_CLAMP_PER_TURN, Math.trunc(raw)));
      if (bounded !== Math.trunc(raw)) clampedAny = true;
      if (bounded !== 0) dims[dim] = bounded;
    }
    if (clampedAny) {
      reject("attitude", `delta exceeded ±${ATTITUDE_CLAMP_PER_TURN} for one turn and was clamped`, a);
    }
    if (Object.keys(dims).length === 0) continue;

    effects.push({ t: "adjust_attitude", subject, object, dims, reason: a.reason || "the moment just past" });
  }

  // --------------------------------------------------------------- opinions
  for (const o of n.opinion_updates) {
    const subject = entityId(o.subject);
    const object = entityId(o.object);
    if (!subject || !object) { reject("opinion", "unresolved subject or object", o); continue; }
    if (!ctx.presentEntityIds.includes(subject)) {
      reject("opinion", `${subject} is not present`, o);
      continue;
    }
    if (o.opinion.trim().length < 10) { reject("opinion", "opinion too short", o); continue; }
    const key = `${subject}->${object}`;
    if (!s.relationships[key]) {
      reject("opinion", `no relationship edge ${key} to write an opinion onto`, o);
      continue;
    }
    effects.push({ t: "set_opinion", subject, object, opinion: o.opinion.trim() });
  }

  // How many people this turn has already invented. See the `introduce_local` case.
  let newLocals = 0;

  // -------------------------------------------------------------- proposals
  for (const raw of n.proposals.slice(0, MAX_PROPOSALS_PER_TURN)) {
    if (!(NARRATOR_ALLOWED_EFFECTS as readonly string[]).includes(raw.t)) {
      reject("proposal", `effect "${raw.t}" is engine-only and may never come from the narrator`, raw);
      continue;
    }

    // Shape second: the tag is allowed, but the payload still has to be the one that tag
    // promises. A malformed proposal is refused exactly like a forbidden one — recorded,
    // and costing the turn nothing but itself.
    const shaped = NarratorProposal.safeParse(raw);
    if (!shaped.success) {
      reject("proposal", `"${raw.t}" is malformed: ${shaped.error.issues.map((i: { path: (string|number)[]; message: string }) => `${i.path.join(".")} ${i.message}`).join("; ")}`, raw);
      continue;
    }
    const p = shaped.data;

    switch (p.t) {
      /**
       * A new named local. Two gates, and both of them are about the world staying
       * coherent rather than about the model behaving.
       *
       * The CAP, because a DM that can mint people without limit will, and a world with
       * four hundred names in it has no names in it. The DUPLICATE check, because the
       * failure this feature exists to fix is the innkeeper being a different person
       * every scene — and re-introducing somebody already standing there is that same
       * bug wearing a hat.
       */
      case "introduce_local": {
        /**
         * The global cap is the wrong defence on its own.
         *
         * A narrator minting three people a turn reaches 250 in eighty-four turns, and by
         * the time the cap bites there are two hundred and fifty-four people standing on
         * a village green. The world is already ruined; the cap just stops it getting
         * worse. So: at most ONE new person per turn, and a room that is already crowded
         * takes no more. Both are about the world staying legible, not about the model
         * behaving.
         */
        if (newLocals >= MAX_NEW_LOCALS_PER_TURN) {
          reject("proposal", `only ${MAX_NEW_LOCALS_PER_TURN} new person per turn; ${p.name} can wait for the next scene`, p);
          break;
        }
        const crowdHere = Object.values(s.entities).filter(
          (e) => e.alive && e.location_id === p.location_id && e.kind !== "monster").length;
        if (crowdHere >= MAX_NAMED_IN_ONE_PLACE) {
          reject("proposal", `${s.locations[p.location_id]?.name ?? p.location_id} already has ${crowdHere} named people in it`, p);
          break;
        }

        const admit = canAdmit(s, "local");
        if (!admit.ok) { reject("proposal", `cannot introduce ${p.name}: ${admit.reason}`, p); break; }
        if (!s.locations[p.location_id]) { reject("proposal", `unknown location ${p.location_id}`, p); break; }
        const wanted = p.name.trim().toLowerCase();
        const clash = Object.values(s.entities).find(
          (e) => e.alive && (e.name.toLowerCase() === wanted || e.aliases.some((a) => a.toLowerCase() === wanted)),
        );
        if (clash) { reject("proposal", `${p.name} already exists (${clash.id}) — speak to them instead of introducing them again`, p); break; }
        effects.push({
          t: "introduce_local",
          name: p.name.trim(),
          descriptor: p.descriptor.trim(),
          pronouns: p.pronouns,
          location_id: p.location_id,
          voice: (p.voice ?? "").trim().slice(0, 200),
          trait: (p.trait ?? "").trim().slice(0, 200),
        });
        newLocals += 1;
        break;
      }

      case "set_flag":
        if (!/^[a-z][a-z0-9_]{2,63}$/.test(p.key)) {
          reject("proposal", `flag key "${p.key}" is not a safe snake_case identifier`, p);
          break;
        }
        effects.push({ t: "set_flag", key: p.key, value: p.value });
        break;

      case "add_lead": {
        const q = s.quests[p.quest_id];
        if (!q) { reject("proposal", `unknown quest ${p.quest_id}`, p); break; }
        if (p.points_to_location_id && !s.locations[p.points_to_location_id]) {
          reject("proposal", `lead points at unknown location ${p.points_to_location_id}`, p);
          break;
        }
        effects.push({
          t: "add_lead", quest_id: p.quest_id, text: p.text,
          points_to_location_id: p.points_to_location_id, source_entity_id: null,
        });
        break;
      }

      case "reveal_location":
        if (!s.locations[p.location_id]) { reject("proposal", `unknown location ${p.location_id}`, p); break; }
        effects.push({ t: "reveal_location", location_id: p.location_id });
        break;

      case "reveal_exit": {
        const loc = s.locations[p.location_id];
        if (!loc) { reject("proposal", `unknown location ${p.location_id}`, p); break; }
        if (!loc.exits.some((x) => x.dir === p.dir)) {
          reject("proposal", `${p.location_id} has no exit "${p.dir}" to reveal`, p);
          break;
        }
        effects.push({ t: "reveal_exit", location_id: p.location_id, dir: p.dir });
        break;
      }

      case "teach_fact": {
        const e = entityId(p.entity_id);
        if (!e) { reject("proposal", `unknown entity ${p.entity_id}`, p); break; }
        if (!s.facts.some((f) => f.id === p.fact_id)) {
          reject("proposal", `unknown fact ${p.fact_id}`, p);
          break;
        }
        effects.push({ t: "teach_fact", entity_id: e, fact_id: p.fact_id });
        break;
      }

      case "move_entity": {
        const e = entityId(p.entity_id);
        if (!e) { reject("proposal", `unknown entity ${p.entity_id}`, p); break; }
        if (e === s.meta.pc_id) {
          reject("proposal", "the narrator may not move the player character", p);
          break;
        }
        if (!s.locations[p.location_id]) { reject("proposal", `unknown location ${p.location_id}`, p); break; }
        effects.push({ t: "move_entity", entity_id: e, location_id: p.location_id });
        break;
      }

      case "advance_time":
        if (p.minutes > MAX_NARRATOR_MINUTES) {
          reject("proposal", `narrator tried to advance ${p.minutes} minutes; cap is ${MAX_NARRATOR_MINUTES}`, p);
          break;
        }
        effects.push({ t: "advance_time", minutes: p.minutes });
        break;
    }
  }

  if (n.proposals.length > MAX_PROPOSALS_PER_TURN) {
    reject("proposal", `more than ${MAX_PROPOSALS_PER_TURN} proposals in one turn; kept the first ${MAX_PROPOSALS_PER_TURN}`, n.proposals.length);
  }

  return {
    effects,
    narration,
    suggestedActions: n.suggested_actions.slice(0, 4),
    rejects,
    resolved,
  };
}
