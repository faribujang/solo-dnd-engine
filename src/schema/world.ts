import { z } from "zod";
import { Flags, Id } from "./common.js";
import { Trigger } from "./dsl.js";

/** Minutes per in-world day. One monotonic clock; everything else is derived from it. */
export const MINUTES_PER_DAY = 1440;

export const Faction = z.object({
  id: Id,
  name: z.string(),
  rep_with_pc: z.number().min(-100).max(100).default(0),
  member_ids: z.array(Id).default([]),
  goals: z.array(z.string()).default([]),
  /**
   * This faction sells the thing everyone needs, and its grip sets the local price.
   *
   * At most one faction per world should carry this. It is what lets a setting's central
   * economic fact be legible without simulating an economy: you can tell whose town you are
   * standing in by what a healing draught costs.
   */
  controls_supply: z.boolean().default(false),
  /**
   * Positions inside the faction, so no group is monolithic. An NPC names one in their
   * flags as `faction_wing`. Two people flying the same banner can want opposite things,
   * and the DM needs to know which one it is talking to.
   */
  wings: z.array(z.object({ id: z.string(), name: z.string(), wants: z.string() })).default([]),
});
export type Faction = z.infer<typeof Faction>;

export const Weather = z.object({
  current: z.string().default("clear"),
  changes_at_minute: z.number().int().nullable().default(null),
});

export const World = z.object({
  world_minute: z.number().int().nonnegative(),   // THE clock. day/hour/season derive from this.
  calendar: z.object({
    month: z.string().default("Hammer"),
    year: z.number().int().default(1492),
    epoch_day: z.number().int().default(0),       // world_minute 0 falls on this day-of-year
  }).default({}),
  weather: Weather.default({}),
  flags: Flags,
  factions: z.record(z.string(), Faction).default({}),
  triggers: z.array(Trigger).default([]),         // global triggers
  // `once: true` bookkeeping, campaign-wide. Keys are namespaced by source
  // ("world:t_x", "quest:q_a:step_1:t_y") so authored ids only need to be locally unique.
  fired_trigger_ids: z.array(z.string()).default([]),
  scene_id: z.string().default("scene_0001"),
  scene_started_turn: z.number().int().nonnegative().default(0),
});
export type World = z.infer<typeof World>;
