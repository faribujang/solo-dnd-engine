import type { GameEvent } from "../schema/event.js";
import type { GameState } from "../schema/state.js";

/**
 * Who knows what.
 *
 * Every fact carries `known_by`; every event carries `witnesses`. On commit, witnesses
 * learn the facts that event produced. The context builder then filters facts by knower,
 * so a guard cannot mention a murder they never saw and nobody told them about.
 *
 * Gossip — the slower channel by which non-secret facts spread between co-located NPCs —
 * is intentionally NOT here. It is random, so it is computed during resolution and arrives
 * as `teach_fact` effects on the event, keeping this module pure and replay exact.
 */
export function propagateKnowledge(s: GameState, ev: GameEvent): void {
  if (ev.fact_ids.length === 0 || ev.witnesses.length === 0) return;

  for (const factId of ev.fact_ids) {
    const fact = s.facts.find((f) => f.id === factId);
    if (!fact) continue;
    for (const witnessId of [...ev.witnesses].sort()) {
      const w = s.entities[witnessId];
      if (!w || !w.alive) continue;
      if (!fact.known_by.includes(w.id)) fact.known_by.push(w.id);
      if (!w.known_fact_ids.includes(fact.id)) w.known_fact_ids.push(fact.id);
    }
  }
}

/**
 * Candidate gossip transfers for a stretch of elapsed time. Called during RESOLUTION with
 * a live Rng, never from the reducer. Returns the teach_fact pairs that should be baked
 * onto the time_pass event.
 */
export function planGossip(
  s: GameState,
  minutes: number,
  rng: { chance(p: number): boolean },
): Array<{ entity_id: string; fact_id: string }> {
  const hours = Math.floor(minutes / 60);
  if (hours <= 0) return [];

  const out: Array<{ entity_id: string; fact_id: string }> = [];
  const byLocation = new Map<string, string[]>();

  for (const id of Object.keys(s.entities).sort()) {
    const e = s.entities[id]!;
    if (!e.alive || e.flags["is_template"] === true) continue;
    const list = byLocation.get(e.location_id) ?? [];
    list.push(e.id);
    byLocation.set(e.location_id, list);
  }

  for (const locId of [...byLocation.keys()].sort()) {
    const present = byLocation.get(locId)!;
    if (present.length < 2) continue;

    for (const knowerId of present) {
      const knower = s.entities[knowerId]!;
      for (const factId of knower.known_fact_ids) {
        const fact = s.facts.find((f) => f.id === factId);
        if (!fact || fact.secret || fact.superseded_by) continue;

        for (const learnerId of present) {
          if (learnerId === knowerId) continue;
          const learner = s.entities[learnerId]!;
          if (learner.known_fact_ids.includes(factId)) continue;
          if (out.some((o) => o.entity_id === learnerId && o.fact_id === factId)) continue;

          // Chance scales with how well they get on and how long they were together.
          const rel = s.relationships[`${learnerId}->${knowerId}`];
          const affinity = rel?.dims.affinity ?? 0;
          const perHour = 0.15 + Math.max(0, affinity) / 400;
          if (rng.chance(1 - Math.pow(1 - perHour, hours))) {
            out.push({ entity_id: learnerId, fact_id: factId });
          }
        }
      }
    }
  }

  return out;
}
