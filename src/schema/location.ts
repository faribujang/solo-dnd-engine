import { z } from "zod";
import { TerrainTrait } from "../rules/terrain.js";
import { DifficultyBand, Flags, Id, LightLevel, Skill } from "./common.js";
import { Trigger } from "./dsl.js";

/** A gate on an exit that must be passed with a check rather than a key. */
export const ExitCheck = z.object({
  skill: Skill,
  band: DifficultyBand,
});

export const Exit = z.object({
  dir: z.string(),                           // "north", "up", "through the grate"
  to: Id,
  desc: z.string().default(""),
  travel_minutes: z.number().int().nonnegative().default(1),
  locked_by: Id.nullable().default(null),    // item DEFINITION id that opens it
  hidden_until_flag: z.string().nullable().default(null), // exit is invisible until flag is set
  requires_check: ExitCheck.nullable().default(null),
  revealed: z.boolean().default(false),      // set true once found, independent of the flag
});
export type Exit = z.infer<typeof Exit>;

/**
 * One thing you can do to a feature.
 *
 * Features existed from the start as scenery with a list of verb NAMES, and nothing in
 * the engine ever read them — there was no action that touched a room. So every scene
 * resolved the only way it could, by talking to somebody, and a campaign with nineteen
 * locations shipped with zero things to pick up, pry, cut or climb. This is the shape
 * that makes a place playable: a verb, what it costs, and what it does.
 *
 * The effects are AUTHORED, which is the usual rule — the roll happens at resolution and
 * the outcome was written by a person, so the world is the same on replay.
 */
export const FeatureInteraction = z.object({
  /** One word, how a player would say it: "pry", "search", "climb", "cut", "listen". */
  verb: z.string(),
  /** What the button says: "Pry up the rotted boards". Falls back to "<verb> the <name>". */
  label: z.string().default(""),
  /** Null means it simply works — opening an unlocked door is not a Strength check. */
  skill: Skill.nullable().default(null),
  band: DifficultyBand.default("medium"),
  minutes: z.number().int().nonnegative().default(2),
  /** Needs a tool: an item the player carries whose def carries this tag. */
  requires_item_tag: z.string().nullable().default(null),
  /** Hidden until a flag is set, for things you must learn about first. */
  hidden_until_flag: z.string().nullable().default(null),
  on_success: z.array(Trigger.shape.then.element).default([]),
  on_failure: z.array(Trigger.shape.then.element).default([]),
  /** A line for the DM about what it looks like. Never mechanics. */
  narrate: z.string().default(""),
  /** A board is only pried up once. Tracked in the feature's own state bag. */
  once: z.boolean().default(false),
});
export type FeatureInteraction = z.infer<typeof FeatureInteraction>;

/**
 * Accept the old shape. Four authored features in the demo campaign list their verbs as
 * bare strings, and a schema change that invalidates existing content is a migration
 * nobody asked for: a bare "search" becomes a plain medium Investigation check.
 */
const AnyInteraction = z.union([
  z.string().transform((verb) => FeatureInteraction.parse({ verb })),
  FeatureInteraction,
]);

/** Something in the room the player can interact with, holding its own small state bag. */
export const Feature = z.object({
  id: z.string(),
  name: z.string(),
  desc: z.string().default(""),
  interactions: z.array(AnyInteraction).default([]),
  /** Aliases the player might say: "the boards", "the floor". */
  aliases: z.array(z.string()).default([]),
  state: Flags,
});
export type Feature = z.infer<typeof Feature>;

/** Abstract combat positions. 90% of the tactical feel, 10% of the complexity of a grid. */
export const Zone = z.object({
  id: z.string(),
  name: z.string(),
  adjacent: z.array(z.string()).default([]),
  /**
   * What the ground does. See rules/terrain.ts.
   *
   * Empty means flat and featureless, which is what every zone used to be — and is why
   * every fight played the same. Terrain is the cheapest variety available, because it
   * changes decisions rather than numbers.
   */
  terrain: z.array(TerrainTrait).default([]),
});
export type Zone = z.infer<typeof Zone>;

/** Map coordinates. Abstract units; the client scales them. Cheap now, painful later. */
export const Coords = z.object({ x: z.number(), y: z.number() });

export const Location = z.object({
  id: Id,
  name: z.string(),
  region_id: Id.nullable().default(null),
  coords: Coords.default({ x: 0, y: 0 }),
  /**
   * How this place appears on the map before you have been there.
   *
   *   landmark      — always drawn. Cities, keeps, the mountain everyone can see. Someone
   *                   who grew up in this world knows these are there.
   *   discoverable  — absent until found. Dungeons, hideouts, the room behind the altar.
   *
   * `discovered` and `visited_count` then layer on top: a landmark you have not been to is
   * drawn but hollow; one you have walked is filled.
   */
  map_visibility: z.enum(["landmark", "discoverable"]).default("discoverable"),
  settlement_id: Id.nullable().default(null),
  short_desc: z.string(),                    // sent every turn
  long_desc: z.string().default(""),         // sent on FIRST VISIT or an explicit "look" only
  exits: z.array(Exit).default([]),
  features: z.array(Feature).default([]),
  zones: z.array(Zone).default([]),
  contains_item_ids: z.array(Id).default([]),   // item INSTANCE ids lying here
  ambient: z.object({
    light: LightLevel.default("bright"),      // feeds stealth/perception modifiers
    sound: z.string().default(""),
    smell: z.string().default(""),
  }).default({}),
  on_enter_triggers: z.array(Trigger).default([]),
  discovered: z.boolean().default(false),    // does the player know this place exists
  visited_count: z.number().int().nonnegative().default(0),
  danger_level: z.number().int().min(0).max(5).default(0),
  encounter_table_id: Id.nullable().default(null),
  flags: Flags,
});
export type Location = z.infer<typeof Location>;

// NOTE: `contains_entity_ids` is deliberately absent. It is DERIVED from entity.location_id
// via selectors.entitiesAt(). Two sources of truth for the same fact is how worlds desync.
