import { z } from "zod";
import { Id } from "./common.js";
import { Effect } from "./dsl.js";

/**
 * ENCOUNTER TABLES.
 *
 * `Location.encounter_table_id` has existed since phase 0 and nothing read it. The reason
 * to give it entries now is travel: a journey across the map that costs time but never
 * *risks* anything is a loading screen with extra steps.
 *
 * The important design note is in the `kind` field. A table of nothing but monsters turns
 * travel into a chore and teaches players to avoid the world. Discovery, weather, and
 * people you meet are what make a road feel like a place.
 */
export const EncounterKind = z.enum([
  "combat",
  "social",        // someone on the road who wants something
  "discovery",     // a thing worth finding
  "environment",   // weather, terrain, a river in flood
  "quiet",         // deliberately nothing. Tension needs rests between beats
]);
export type EncounterKind = z.infer<typeof EncounterKind>;

export const EncounterEntry = z.object({
  id: Id,
  kind: EncounterKind,
  /** Relative likelihood within its table. */
  weight: z.number().positive().default(1),
  /** One line the DM is given to narrate. Never a number. */
  brief: z.string(),
  /** What actually happens. Combat entries queue a fight; the rest set flags or add facts. */
  then: z.array(Effect).default([]),
  /** Only offered at these hours; empty means any time. */
  hours: z.array(z.number().int().min(0).max(23)).default([]),
  /** Only at or above this location danger level. */
  min_danger: z.number().int().min(0).max(5).default(0),
  /** Fire at most once per campaign. */
  once: z.boolean().default(false),
});
export type EncounterEntry = z.infer<typeof EncounterEntry>;

export const EncounterTable = z.object({
  id: Id,
  name: z.string(),
  /** Chance per hour of travel that anything happens at all, before weights are consulted. */
  chance_per_hour: z.number().min(0).max(1).default(0.2),
  entries: z.array(EncounterEntry).default([]),
});
export type EncounterTable = z.infer<typeof EncounterTable>;
