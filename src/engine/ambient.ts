import type { Effect } from "../schema/dsl.js";
import type { GameState } from "../schema/state.js";
import type { Rng } from "../rules/rng.js";
import { MINUTES_PER_DAY } from "../schema/world.js";
import { factsKnownTo, hourOfDay, scheduledLocation } from "../state/selectors.js";
import { planGossip } from "./knowledge.js";

/**
 * The living world.
 *
 * The world should not hold its breath while the player thinks. When time passes, NPCs
 * pursue their goals, factions apply pressure, feelings cool, rumours travel and the
 * weather turns — whether or not anyone is watching.
 *
 * The division of labour is the same as everywhere else: CODE decides what happened, from
 * goals and schedules and faction state. The LLM is only ever asked how it looked, and only
 * for the beats the player could actually perceive. A world whose events are invented by
 * the narrator is a world that contradicts itself by turn fifty.
 *
 * Called from RESOLUTION with a live Rng, so everything random is decided before the event
 * is built and the reducer stays pure.
 */

export interface Beat {
  /** What happened, stated plainly. Becomes a fact if the player learns of it. */
  text: string;
  /** Could the player perceive this right now? Drives whether it is narrated. */
  noticeable: boolean;
  subjects: string[];
  importance: 1 | 2 | 3 | 4 | 5;
}

export interface TickResult {
  effects: Effect[];
  beats: Beat[];
}

/** Feelings cool toward neutral at roughly this much per day of absence. */
const DRIFT_PER_DAY = 1;
/** How often a faction with a grievance does something about it, per day. */
const FACTION_ACTION_CHANCE_PER_DAY = 0.5;

/** At most this many offscreen dramas per tick. A world, not a soap opera. */
export const MAX_DRAMAS_PER_TICK = 2;

/** How often a strong feeling between two NPCs turns into an action. */
export const DRAMA_CHANCE_PER_DAY = 0.25;

export function worldTick(s: GameState, minutes: number, rng: Rng): TickResult {
  const effects: Effect[] = [];
  const beats: Beat[] = [];
  if (minutes <= 0) return { effects, beats };

  const pcLocation = s.entities[s.meta.pc_id]?.location_id ?? null;
  const days = minutes / MINUTES_PER_DAY;

  // 1. Rumours travel. Already deterministic given the rng; see engine/knowledge.ts.
  for (const g of planGossip(s, minutes, rng)) {
    effects.push({ t: "teach_fact", entity_id: g.entity_id, fact_id: g.fact_id });
  }

  // 2. Feelings cool. Absence does not make the heart grow fonder; it makes it forget.
  //    Only applied while the player is elsewhere, so a conversation is never undone
  //    by the minutes it took to have.
  if (days >= 0.25) {
    const drift = Math.max(1, Math.round(DRIFT_PER_DAY * days));
    for (const key of Object.keys(s.relationships).sort()) {
      const rel = s.relationships[key]!;
      if (rel.object !== s.meta.pc_id) continue;
      const subject = s.entities[rel.subject];
      if (!subject?.alive) continue;
      if (subject.location_id === pcLocation) continue;

      const dims: Record<string, number> = {};
      for (const dim of ["affinity", "trust", "fear", "respect"] as const) {
        const v = rel.dims[dim];
        if (v === 0) continue;
        // Fear fades fastest; respect, once earned, barely moves.
        const rate = dim === "fear" ? 2 : dim === "respect" ? 0.25 : 1;
        const step = Math.min(Math.abs(v), Math.max(1, Math.round(drift * rate)));
        dims[dim] = v > 0 ? -step : step;
      }
      if (Object.keys(dims).length > 0) {
        effects.push({
          t: "adjust_attitude", subject: rel.subject, object: rel.object, dims,
          reason: "time passing without you",
        });
      }
    }
  }

  // 3. NPCs walk toward what they want, when their schedule leaves them free.
  for (const id of Object.keys(s.entities).sort()) {
    const e = s.entities[id]!;
    if (!e.alive || e.id === s.meta.pc_id || e.flags["is_template"] === true) continue;
    if (e.goals.length === 0) continue;
    if (scheduledLocation(s, e) !== null) continue;   // a scheduled NPC has somewhere to be

    const goal = e.goals[0]!;
    const quest = goal.quest_id ? s.quests[goal.quest_id] : undefined;
    if (quest && (quest.status === "complete" || quest.status === "failed")) continue;

    if (rng.chance(Math.min(0.6, days))) {
      beats.push({
        text: `${e.name} spent the time working on their own business: ${goal.text.toLowerCase()}.`,
        noticeable: e.location_id === pcLocation,
        subjects: [e.id],
        importance: 2,
      });
    }
  }

  // 3b. People act on how they feel about EACH OTHER.
  //
  //     The relationship graph has always been directed and many-to-many — Mira can
  //     distrust Thorne without Thorne knowing it — and until now precisely nothing read
  //     the edges that did not involve the player. Which meant every NPC's inner life ran
  //     exclusively through you, and a world where nobody has a quarrel you are not part
  //     of is a world with one real person in it.
  //
  //     Two things happen here, both bounded and both derived from edges the author
  //     already wrote. Someone who despises another and knows something damaging passes it
  //     on. Someone devoted to another goes to them when they are in trouble. The player
  //     may hear about either, and only if they could plausibly have heard.
  let dramas = 0;
  for (const key of Object.keys(s.relationships).sort()) {
    if (dramas >= MAX_DRAMAS_PER_TICK) break;
    const rel = s.relationships[key]!;
    if (rel.object === s.meta.pc_id || rel.subject === s.meta.pc_id) continue;

    const actor = s.entities[rel.subject];
    const other = s.entities[rel.object];
    if (!actor?.alive || !other?.alive) continue;
    if (actor.flags["is_template"] === true || other.flags["is_template"] === true) continue;
    if (!rng.chance(Math.min(0.5, days * DRAMA_CHANCE_PER_DAY))) continue;

    // Malice: they know something about the other and no longer care to sit on it.
    if (rel.dims.affinity <= -40) {
      const damaging = factsKnownTo(s, actor.id).find(
        (f) => !f.superseded_by && f.subjects.includes(other.id) && f.secret,
      );
      const audience = Object.values(s.entities).find(
        (e) => e.alive && e.id !== actor.id && e.id !== other.id
          && e.location_id === actor.location_id && e.flags["is_template"] !== true,
      );
      if (damaging && audience) {
        dramas++;
        effects.push({ t: "teach_fact", entity_id: audience.id, fact_id: damaging.id });
        effects.push({
          t: "adjust_attitude", subject: audience.id, object: other.id,
          dims: { trust: -8, affinity: -5 },
          reason: `what ${actor.name} said about them`,
        });
        beats.push({
          text: `${actor.name} was heard telling ${audience.name} something about ${other.name} that was not theirs to tell.`,
          noticeable: actor.location_id === pcLocation,
          subjects: [actor.id, other.id, audience.id],
          importance: 3,
        });
        continue;
      }
    }

    // Loyalty: someone they love is hurt or in trouble, and they go to them.
    if (rel.dims.affinity >= 50 && actor.location_id !== other.location_id) {
      const hurt = other.hp.current < other.hp.max / 2;
      if (hurt && s.locations[other.location_id]) {
        dramas++;
        effects.push({ t: "move_entity", entity_id: actor.id, location_id: other.location_id });
        beats.push({
          text: `${actor.name} left in a hurry when word reached them about ${other.name}.`,
          noticeable: actor.location_id === pcLocation,
          subjects: [actor.id, other.id],
          importance: 3,
        });
        continue;
      }
    }
  }

  // 4. Factions with a grievance act on it. This is the pressure that makes a deadline
  //    feel like a deadline rather than a number in a save file.
  for (const fid of Object.keys(s.world.factions).sort()) {
    const f = s.world.factions[fid]!;
    if (f.rep_with_pc > -20) continue;
    if (!rng.chance(FACTION_ACTION_CHANCE_PER_DAY * days)) continue;

    const living = f.member_ids.filter((m) => s.entities[m]?.alive);
    const actor = living.length ? s.entities[rng.pick(living)]! : null;
    const goal = f.goals[0] ?? "their own ends";

    beats.push({
      text: actor
        ? `${f.name} moved openly while you were elsewhere; ${actor.name} was seen carrying word about ${goal}.`
        : `${f.name} moved openly while you were elsewhere, pressing toward ${goal}.`,
      noticeable: true,   // the point of pressure is that you feel it
      subjects: [fid, ...(actor ? [actor.id] : [])],
      importance: 3,
    });

    effects.push({ t: "set_flag", key: `${fid}_active`, value: true });
  }

  // 5. Weather turns on its own schedule.
  const changesAt = s.world.weather.changes_at_minute;
  if (changesAt !== null && s.world.world_minute + minutes >= changesAt) {
    const next = rng.pick([
      "cold rain", "a thin freezing mist", "clear and bitter", "low cloud and no wind", "sleet",
    ]);
    if (next !== s.world.weather.current) {
      beats.push({
        text: `The weather turned to ${next}.`,
        noticeable: true,
        subjects: [],
        importance: 1,
      });
      effects.push({ t: "set_flag", key: "weather_pending", value: next });
    }
  }

  // 6. Beats the player could perceive become facts. Beats they could not are left as
  //    beats: they happened, but nobody has told them yet, and the fact ledger records
  //    what is KNOWN, not what is true.
  for (const b of beats) {
    if (!b.noticeable) continue;
    effects.push({
      t: "add_fact",
      text: b.text,
      subjects: b.subjects,
      importance: b.importance,
      secret: false,
      known_by: [s.meta.pc_id], quest_ids: [] });
  }

  return { effects, beats };
}

/** A short label for the time of day, used to colour ambient narration. */
export function watchLabel(s: GameState): string {
  const h = hourOfDay(s);
  if (h < 4) return "the small hours";
  if (h < 7) return "first light";
  if (h < 11) return "the morning";
  if (h < 15) return "the middle of the day";
  if (h < 19) return "the afternoon";
  if (h < 22) return "the evening";
  return "late";
}
