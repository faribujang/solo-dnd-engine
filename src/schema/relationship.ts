import { z } from "zod";
import { Dims, FullDims, Id } from "./common.js";

/**
 * Directed edges, keyed "<subject>-><object>". Thorne's feelings about you are not
 * your feelings about Thorne.
 *
 * The split is the whole point:
 *   dims    — CODE writes these, they drive MECHANICS (DC shifts, prices, secret-sharing)
 *   opinion — the LLM writes this, it drives VOICE only
 */

/** Derived label. Never stored independently; computed by rules/social.ts from dims. */
export const Disposition = z.enum([
  "hostile", "cold", "wary", "neutral", "warming", "friendly", "devoted",
]);
export type Disposition = z.infer<typeof Disposition>;

export const AttitudeChange = z.object({
  turn: z.number().int().nonnegative(),
  event_id: Id.nullable().default(null),
  dims: Dims,
  reason: z.string(),
});
export type AttitudeChange = z.infer<typeof AttitudeChange>;

export const Relationship = z.object({
  subject: Id,                               // who holds the feeling
  object: Id,                                // who it is about
  dims: FullDims,
  opinion: z.string().default(""),           // LLM-written, rewritten at most once per scene
  tags: z.array(z.string()).default([]),     // "indebted_to_pc", "suspicious_of_pc_magic"
  history: z.array(AttitudeChange).default([]),  // append-only; regenerates opinion if garbled
});
export type Relationship = z.infer<typeof Relationship>;

/** Key format for the relationships map. */
export function relKey(subject: string, object: string): string {
  return `${subject}->${object}`;
}

export const NEUTRAL_DIMS = { affinity: 0, trust: 0, fear: 0, respect: 0 } as const;

/** Maximum any single dimension may move in one turn, from any source. */
export const ATTITUDE_CLAMP_PER_TURN = 10;

/** Damping applied when a faction-mate's action spills onto other members. */
export const FACTION_REP_SPILL = 0.3;
