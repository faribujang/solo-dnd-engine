import { z } from "zod";

/** Stable, human-readable, prefixed identifier: `npc_thorne`, `loc_citadel_gate`. */
export const Id = z
  .string()
  .regex(/^[a-z][a-z0-9]*_[a-z0-9_]+$/, "id must look like `prefix_name` in snake_case");
export type Id = z.infer<typeof Id>;

/** The six 5e ability scores. */
export const Ability = z.enum(["str", "dex", "con", "int", "wis", "cha"]);
export type Ability = z.infer<typeof Ability>;

/** SRD 5.1 skill list, each mapped to its governing ability in rules/checks.ts. */
export const Skill = z.enum([
  "acrobatics", "animal_handling", "arcana", "athletics", "deception", "history",
  "insight", "intimidation", "investigation", "medicine", "nature", "perception",
  "performance", "persuasion", "religion", "sleight_of_hand", "stealth", "survival",
]);
export type Skill = z.infer<typeof Skill>;

/** Difficulty bands. The intent parser proposes one of these; code maps it to a number. */
export const DifficultyBand = z.enum([
  "trivial", "easy", "medium", "hard", "very_hard", "near_impossible",
]);
export type DifficultyBand = z.infer<typeof DifficultyBand>;

/** The four relationship dimensions, each -100..100. */
export const Dim = z.enum(["affinity", "trust", "fear", "respect"]);
export type Dim = z.infer<typeof Dim>;

/** A partial set of relationship dimension deltas or values. */
export const Dims = z.object({
  affinity: z.number().optional(),
  trust: z.number().optional(),
  fear: z.number().optional(),
  respect: z.number().optional(),
});
export type Dims = z.infer<typeof Dims>;

/** A fully populated dimension set, as stored on a relationship edge. */
export const FullDims = z.object({
  affinity: z.number().min(-100).max(100),
  trust: z.number().min(-100).max(100),
  fear: z.number().min(-100).max(100),
  respect: z.number().min(-100).max(100),
});
export type FullDims = z.infer<typeof FullDims>;

/** Advantage state on a d20 roll. */
export const Advantage = z.enum(["none", "advantage", "disadvantage"]);
export type Advantage = z.infer<typeof Advantage>;

/** Ambient light, which modifies Stealth and Perception. */
export const LightLevel = z.enum(["bright", "dim", "dark"]);
export type LightLevel = z.infer<typeof LightLevel>;

/**
 * How well a check went, not merely whether it went.
 *
 * 5e as written is binary and the interesting band is the middle. This is the DMG's
 * "success at a cost" variant, which is also PbtA's 7–9: most rolls land here, and a
 * complication is a scene where a flat failure is a dead end.
 *
 * Attack rolls do NOT use this — combat stays clean hit/miss, because a "graze" band would
 * quietly rewrite every monster's threat.
 */
export const Degree = z.enum(["critical_success", "success", "success_at_cost", "failure"]);
export type Degree = z.infer<typeof Degree>;

/** A single resolved die roll, recorded on the event that caused it. */
export const Roll = z.object({
  purpose: z.string(),                       // "attack" | "stealth" | "initiative" | "damage"
  die: z.string(),                           // "d20", "1d8"
  raw: z.number().int(),                     // the natural die result, before modifiers
  raw_second: z.number().int().nullable().default(null), // the other d20 under adv/disadv
  mods: z.number().int(),                    // total applied modifier
  total: z.number().int(),                   // raw + mods
  target: z.number().int().nullable(),       // DC or AC being beaten; null for damage rolls
  success: z.boolean().nullable(),           // null for damage rolls
  critical: z.boolean().default(false),      // natural 20 on an attack roll
  fumble: z.boolean().default(false),        // natural 1 on an attack roll
  advantage: Advantage.default("none"),
  /** Set on ability checks and saves; null on attack and damage rolls. */
  degree: Degree.nullable().default(null),
  /**
   * Where the modifier came from, itemised: `+3 dex`, `+2 proficiency`, `−2 dim light`.
   *
   * The roll card is the component that convinces a player the DM is not cheating, and it
   * can only do that if the arithmetic is shown with its sources. The modifier layer has
   * always known the reasons; this is what carries them out to the client.
   */
  parts: z.array(z.object({ label: z.string(), value: z.number().int() })).default([]),
});
export type Roll = z.infer<typeof Roll>;

/** An arbitrary JSON-safe value, used for flags and free-form state bags. */
export const Json: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(Json), z.record(Json)]),
);
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** Flag bag used on world, entities, locations and items. */
export const Flags = z.record(Json).default({});
export type Flags = z.infer<typeof Flags>;
