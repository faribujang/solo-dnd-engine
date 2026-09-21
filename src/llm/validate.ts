import type { Effect } from "../schema/dsl.js";
import type { GameState } from "../schema/state.js";
import { NARRATOR_ALLOWED_EFFECTS } from "../schema/dsl.js";
import { canAdmit } from "../rules/cast.js";
import { MAX_NEW_THREADS_PER_TURN, MAX_OPEN_THREADS } from "../schema/thread.js";

/**
 * New named people one turn may invent. A scene introduces someone; it does not cast.
 *
 * One was too tight in practice. A tollhouse with a syndicate guard on the door AND a
 * clerk behind the counter is one ordinary beat, and under a cap of one the second of
 * them was rejected — so the prose described two people and the player could only speak
 * to one. Two per turn still reaches the 250 cap slowly, and the crowd check below is
 * what actually keeps a green from filling up.
 */
const MAX_NEW_LOCALS_PER_TURN = 2;

/** New places one turn may invent. A scene opens a door; it does not draw a county. */
const MAX_NEW_PLACES_PER_TURN = 1;

/** Past this, a room is a junction rather than a room, and the map stops reading. */
const MAX_EXITS_FROM_ONE_PLACE = 10;

/** Named people one place can hold before it stops being a place and becomes a crowd. */
const MAX_NAMED_IN_ONE_PLACE = 14;

/** Things one scene may put into somebody's hands. */
const MAX_GIFTS_PER_TURN = 2;

/** An item definition by id, or by the id a model guessed from its name. */
function findDef(s: GameState, guess: string): string | null {
  const raw = (guess || "").toLowerCase().trim();
  if (!raw) return null;
  const words = raw.replace(/^item_def_/, "").replace(/_/g, " ");
  const hits = Object.values(s.item_defs).filter((d) => {
    const name = d.name.toLowerCase();
    return d.id.toLowerCase() === raw || name === words || name.includes(words) || words.includes(name);
  });
  return hits.length === 1 ? hits[0]!.id : null;
}
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
  /**
   * Who did the narrator mean?
   *
   * Models guess ids from names, constantly and reasonably: `npc_jory_finch` for
   * `cmp_jory`, `pc_jackson` for `pc_main`. Every one of those was rejected, which meant
   * attitude and opinion updates were silently failing for dozens of turns in a row — the
   * prose said somebody warmed to you and the ledger never moved.
   *
   * A guessed id is a NAME with a prefix and underscores, so it is read as one. This is
   * not the model being sloppy; it is us having asked for the one thing it cannot know.
   */
  const entityId = (name: string): string | null => {
    if (!name) return null;
    if (s.entities[name]) return name;

    const raw = name.toLowerCase().trim();
    if (raw === "you" || raw === "the player" || raw === "pc") return s.meta.pc_id;

    // `npc_jory_finch` and `pc_jackson` are names wearing an id's clothes.
    const asWords = raw.replace(/^(npc|pc|cmp|mon|ent)_/, "").replace(/_/g, " ").trim();
    // Any `pc_*` is the lead, whatever the model called them.
    if (raw.startsWith("pc_")) return s.meta.pc_id;

    const forms = (e: { name: string; aliases: string[] }) => [
      e.name.toLowerCase(),
      ...e.aliases.map((a) => a.toLowerCase()),
      e.name.toLowerCase().split(" ")[0] ?? "",
    ];

    for (const candidate of [raw, asWords]) {
      if (!candidate) continue;
      const hit = Object.values(s.entities).find((e) => forms(e).includes(candidate));
      if (hit) { resolved[name] = hit.id; return hit.id; }
    }

    // Last resort: a surname or a partial, as long as it is unambiguous. Ambiguity is a
    // refusal, because guessing between two people is worse than asking again.
    for (const candidate of [raw, asWords]) {
      if (!candidate || candidate.length < 3) continue;
      const hits = Object.values(s.entities).filter((e) =>
        forms(e).some((f) => f.length >= 3 && (f.includes(candidate) || candidate.includes(f))));
      if (hits.length === 1) { resolved[name] = hits[0]!.id; return hits[0]!.id; }
    }
    return null;
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

  // How many places this turn has already invented. See the `introduce_place` case.
  let newPlaces = 0;
  // How many people this turn has already invented. See the `introduce_local` case.
  let newLocals = 0;
  let newThreads = 0;
  let gifts = 0;

  // ───────────────────────────────────────────────────────────── threads
  // Same gates as the `open_thread` proposal, because they are the same thing arriving
  // through the door the model actually uses.
  if (n.new_thread && n.new_thread.text.trim()) {
    const open = Object.values(s.threads).filter((t) => t.status === "open").length;
    if (open >= MAX_OPEN_THREADS) {
      reject("proposal", `${open} threads already hanging; finish something first`, n.new_thread);
    } else {
      effects.push({
        t: "open_thread",
        text: n.new_thread.text.trim().slice(0, 240),
        subject_ids: n.new_thread.subject_ids.filter((id) => s.entities[id] || s.world.factions[id]),
        location_id: null,
        from_entity_id: n.new_thread.from_entity_id && s.entities[n.new_thread.from_entity_id]
          ? n.new_thread.from_entity_id : null,
      });
      newThreads += 1;
    }
  }

  if (n.settled_thread) {
    const th = s.threads[n.settled_thread.thread_id];
    if (!th) reject("proposal", `no thread ${n.settled_thread.thread_id}`, n.settled_thread);
    else if (th.status !== "open") reject("proposal", `thread is already ${th.status}`, n.settled_thread);
    else {
      effects.push({
        t: "resolve_thread",
        thread_id: n.settled_thread.thread_id,
        as: n.settled_thread.as,
        outcome: (n.settled_thread.outcome ?? "").slice(0, 240),
      });
    }
  }

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
          reject("proposal", `only ${MAX_NEW_LOCALS_PER_TURN} new people per turn; ${p.name} can wait for the next scene`, p);
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

      /**
       * A new place, hung off the room the player is standing in.
       *
       * Capped at one per turn for the same reason as people: a narrator that can mint
       * geography will, and a map with a hundred invented rooms is not a map. The caller
       * counts them in `newPlaces`.
       */
      case "introduce_place": {
        if (newPlaces >= MAX_NEW_PLACES_PER_TURN) {
          reject("proposal", `only ${MAX_NEW_PLACES_PER_TURN} new place per turn; ${p.name} can wait`, p);
          break;
        }
        const here = s.locations[s.entities[s.meta.pc_id]!.location_id];
        if (!here) { reject("proposal", "nowhere to hang it off", p); break; }
        if (here.exits.length >= MAX_EXITS_FROM_ONE_PLACE) {
          reject("proposal", `${here.name} already has ${here.exits.length} ways out of it`, p);
          break;
        }
        effects.push({
          t: "introduce_place",
          name: p.name.trim(),
          short_desc: p.short_desc.trim(),
          dir: p.dir.trim(),
          back: (p.back ?? "back").trim(),
          light: p.light,
        });
        newPlaces += 1;
        break;
      }

      /**
       * Picking up an obligation. Two gates, both about the Journal staying readable:
       * one new thread per turn, and a ceiling on how many can hang at once. A world
       * with forty open promises in it is a to-do list, not a story.
       */
      case "open_thread": {
        if (newThreads >= MAX_NEW_THREADS_PER_TURN) {
          reject("proposal", `one new thread per turn; "${p.text.slice(0, 40)}" can wait`, p);
          break;
        }
        const open = Object.values(s.threads).filter((t) => t.status === "open").length;
        if (open >= MAX_OPEN_THREADS) {
          reject("proposal", `${open} threads already hanging; finish something first`, p);
          break;
        }
        // Only people and places that exist. A promise about nobody is not a promise.
        const subjects = p.subject_ids.filter((id) => s.entities[id] || s.world.factions[id]);
        const where = p.location_id && s.locations[p.location_id] ? p.location_id : null;
        const from = p.from_entity_id && s.entities[p.from_entity_id] ? p.from_entity_id : null;
        effects.push({ t: "open_thread", text: p.text.trim(), subject_ids: subjects, location_id: where, from_entity_id: from });
        newThreads += 1;
        break;
      }

      case "resolve_thread": {
        const th = s.threads[p.thread_id];
        if (!th) { reject("proposal", `no thread ${p.thread_id}`, p); break; }
        if (th.status !== "open") { reject("proposal", `thread ${p.thread_id} is already ${th.status}`, p); break; }
        effects.push({ t: "resolve_thread", thread_id: p.thread_id, as: p.as, outcome: (p.outcome ?? "").slice(0, 240) });
        break;
      }

      /**
       * Somebody hands the player a real thing.
       *
       * Three gates: the item has to be one the campaign defines, the recipient has to be
       * here, and two per turn. The DM may not invent a sword — but "Cotter puts a loaf
       * and a waterskin in your hands" should put a loaf and a waterskin in the player's
       * hands, and until now it put nothing anywhere.
       */
      case "give_item": {
        if (gifts >= MAX_GIFTS_PER_TURN) { reject("proposal", "two handed-over items per turn is the limit", p); break; }
        // The item must already exist. Resolve a guessed id the same way people are
        // resolved, because "item_def_bow" for "item_def_hunting_bow" is the same mistake.
        const defId = s.item_defs[p.item_def_id] ? p.item_def_id : findDef(s, p.item_def_id);
        const def = defId ? s.item_defs[defId] : undefined;
        if (!def || !defId) { reject("proposal", `no such item as ${p.item_def_id}`, p); break; }
        /**
         * Banning weapons was the wrong line, and it banned the exact scene that exposed
         * the problem: a smith unwrapping eleven-year-old Accord steel and putting a bow
         * in your hands. A DM handing over gear the campaign already defines is not
         * inventing a mechanical outcome — the stats were authored by a person.
         *
         * What an author does control is `gift_ok`: set it false on the artefact that is
         * supposed to be fought for.
         */
        if (def.gift_ok === false) {
          reject("proposal", `${def.name} is not something to be handed over`, p);
          break;
        }
        if (!ctx.presentEntityIds.includes(p.entity_id)) { reject("proposal", `${p.entity_id} is not here to receive anything`, p); break; }
        effects.push({ t: "give_item", entity_id: p.entity_id, item_def_id: p.item_def_id, qty: Math.min(5, Math.max(1, p.qty ?? 1)) });
        gifts += 1;
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
