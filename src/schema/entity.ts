import { z } from "zod";
import { Ability, Flags, Id, Skill } from "./common.js";
import { Trigger } from "./dsl.js";
import { ApprovalRule } from "../rules/approval.js";

/** One schema covers PC, companions, NPCs and monsters; `kind` discriminates. */
export const EntityKind = z.enum(["pc", "companion", "npc", "monster"]);
export type EntityKind = z.infer<typeof EntityKind>;

/** Combat behaviour policy for companions. Pure code, never an LLM. */
export const AiPolicy = z.enum(["aggressive", "support", "cautious", "skirmish"]);
export type AiPolicy = z.infer<typeof AiPolicy>;

export const AbilityScores = z.object({
  str: z.number().int().min(1).max(30),
  dex: z.number().int().min(1).max(30),
  con: z.number().int().min(1).max(30),
  int: z.number().int().min(1).max(30),
  wis: z.number().int().min(1).max(30),
  cha: z.number().int().min(1).max(30),
});
export type AbilityScores = z.infer<typeof AbilityScores>;

export const HitPoints = z.object({
  current: z.number().int(),                 // may go to 0; negative is clamped by the engine
  max: z.number().int().positive(),
  temp: z.number().int().nonnegative().default(0),
});

export const ActiveCondition = z.object({
  id: z.string(),                            // "poisoned", "prone", "grappled"
  source_event_id: Id.nullable().default(null),
  expires_world_minute: z.number().int().nullable().default(null), // null = until removed
  expires_round: z.number().int().nullable().default(null),        // combat-scoped conditions
});
export type ActiveCondition = z.infer<typeof ActiveCondition>;

export const SpellSlotTier = z.object({
  max: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
});

export const Resources = z.object({
  spell_slots: z.record(z.string(), SpellSlotTier).default({}),  // keyed by tier: "1".."9"
  hit_dice: z.object({ max: z.number().int().nonnegative(), used: z.number().int().nonnegative() }),
});

/** Drives LLM voice only. Never consulted by the rules engine. */
export const Personality = z.object({
  traits: z.array(z.string()).default([]),
  ideal: z.string().default(""),
  bond: z.string().default(""),
  flaw: z.string().default(""),
  voice: z.string().default(""),             // "clipped, wary, dry humour"
});
export type Personality = z.infer<typeof Personality>;

export const Goal = z.object({
  text: z.string(),
  priority: z.number().int().min(1).default(1),
  quest_id: Id.nullable().default(null),
});

/** Where this entity stands at a given hour. Advance the clock and NPCs relocate. */
export const ScheduleBlock = z.object({
  from_hour: z.number().int().min(0).max(23),
  to_hour: z.number().int().min(0).max(23),  // may wrap past midnight
  location_id: Id,
});
export type ScheduleBlock = z.infer<typeof ScheduleBlock>;

export const EquipSlots = z.object({
  main_hand: Id.nullable().default(null),
  off_hand: Id.nullable().default(null),
  armor: Id.nullable().default(null),
  trinket: Id.nullable().default(null),
});

export const Alignment = z.enum([
  "lawful_good", "neutral_good", "chaotic_good",
  "lawful_neutral", "true_neutral", "chaotic_neutral",
  "lawful_evil", "neutral_evil", "chaotic_evil",
]);
export type Alignment = z.infer<typeof Alignment>;

/** Who is driving this character right now. Flips at drop-in / drop-out. */
export const Controller = z.enum(["human", "cpu"]);

/** 5e death saves. Reset on stabilising, healing, or a rest. */
export const DeathSaves = z.object({
  successes: z.number().int().min(0).max(3).default(0),
  failures: z.number().int().min(0).max(3).default(0),
});

export const Entity = z.object({
  id: Id,
  kind: EntityKind,
  name: z.string(),
  pronouns: z.string().default("they/them"),   // used by the narrator; never inferred from a name
  alignment: Alignment.nullable().default(null), // predicts companion reaction; never constrains the player
  xp: z.number().int().nonnegative().default(0),
  controller: Controller.default("cpu"),
  group_id: Id.nullable().default(null),
  death_saves: DeathSaves.default({}),
  /** Last few natural d20s, oldest first. Drives karmic dice; shown on the sheet as "luck". */
  recent_d20s: z.array(z.number().int().min(1).max(20)).default([]),
  stable: z.boolean().default(false),          // at 0 HP but no longer dying
  aliases: z.array(z.string()).default([]),  // things the player might call them
  descriptor: z.string().default(""),        // one line, rendered into the DM prompt
  /**
   * How much of this world this person is allowed to carry. See rules/cast.ts.
   *
   * Authored content gets `standing` unless it says otherwise, which is the honest
   * default: somebody a human bothered to write down is at least a named local with a
   * relationship. `local` is what the narrator may mint mid-scene.
   */
  tier: z.enum(["principal", "standing", "local"]).default("standing"),

  location_id: Id,
  zone_id: z.string().nullable().default(null), // abstract combat zone within the location
  faction_ids: z.array(Id).default([]),

  abilities: AbilityScores,
  level: z.number().int().min(0).default(1),
  class_id: Id.nullable().default(null),
  race_id: Id.nullable().default(null),
  hp: HitPoints,
  ac: z.number().int(),
  speed: z.number().int().default(30),
  proficiency_bonus: z.number().int().default(2),
  proficiencies: z.object({
    skills: z.array(Skill).default([]),
    saves: z.array(Ability).default([]),
    weapons: z.array(z.string()).default([]),
    tools: z.array(z.string()).default([]),
  }).default({}),
  expertise: z.array(Skill).default([]),     // double proficiency bonus
  conditions: z.array(ActiveCondition).default([]),
  resources: Resources,

  inventory: z.array(Id).default([]),        // item INSTANCE ids
  equipped: EquipSlots.default({}),

  personality: Personality.default({}),
  goals: z.array(Goal).default([]),
  schedule: z.array(ScheduleBlock).default([]),

  known_fact_ids: z.array(Id).default([]),   // the knowledge model — see engine/knowledge.ts
  ai_policy: AiPolicy.nullable().default(null),
  /**
   * How THIS companion reacts to what the party does. Authored per character, because a
   * shared policy would make every companion the same person in a different coat.
   */
  approval: z.array(ApprovalRule).default([]),
  /** Characterisation doing mechanical work: how they break when they break. */
  flee_behavior: z.enum(["run", "invisible_and_run", "beg", "fight_to_the_end"]).default("run"),
  /** Their own quest chain, gated on how they feel about the party. */
  personal_arc_quest_id: Id.nullable().default(null),
  /** What it would take to recruit them, in their own words. Shown when you meet them. */
  recruit_condition: z.string().default(""),
  recruitable: z.boolean().default(false),
  on_death: z.array(Trigger).default([]),
  on_first_talk: z.array(Trigger).default([]),

  alive: z.boolean().default(true),
  flags: Flags,
});
export type Entity = z.infer<typeof Entity>;
