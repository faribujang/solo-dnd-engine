import { z } from "zod";
import { Dims, Id, Json, Roll } from "./common.js";
import { Effect, EventType } from "./dsl.js";

/**
 * The journal entry. `journal.jsonl` is append-only and complete; every other state file
 * is a materialized cache rebuildable by replaying these through the reducer.
 *
 * Two invariants make replay exact:
 *   1. All randomness happens during RESOLUTION and is baked into the event, in `rolls`
 *      and `direct_effects`. The reducer itself contains no RNG.
 *   2. Cascade events carry `derived_from`; replay skips them because reducing the root
 *      event regenerates them.
 */

export const AttitudeImpact = z.object({
  subject: Id,
  object: Id,
  dims: Dims,
  reason: z.string(),
});
export type AttitudeImpact = z.infer<typeof AttitudeImpact>;

export const GameEvent = z.object({
  id: Id,
  turn: z.number().int().nonnegative(),
  world_minute: z.number().int().nonnegative(),   // clock BEFORE this event's duration
  type: EventType,
  actor_id: Id.nullable().default(null),
  target_ids: z.array(Id).default([]),
  location_id: Id.nullable().default(null),

  payload: z.record(Json).default({}),            // type-specific detail
  rolls: z.array(Roll).default([]),               // every die this event consumed
  direct_effects: z.array(Effect).default([]),    // resolution-computed effects, incl. RNG results
  attitude_impact: z.array(AttitudeImpact).default([]),
  witnesses: z.array(Id).default([]),             // drives knowledge propagation
  fact_ids: z.array(Id).default([]),              // facts this event produced

  duration_minutes: z.number().int().nonnegative().default(0),
  /** Entropy this event's dice were drawn from. Replay reuses it rather than re-rolling. */
  rng_nonce: z.string().default(""),
  derived_from: Id.nullable().default(null),      // set on cascade events; replay skips these
  trigger_id: Id.nullable().default(null),        // which trigger emitted this cascade
});
export type GameEvent = z.infer<typeof GameEvent>;
