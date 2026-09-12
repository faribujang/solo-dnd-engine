import { z } from "zod";
import { Dims, Id } from "./common.js";
import { Condition, Effect, QuestStatus, Trigger } from "./dsl.js";

/** Player-facing visibility, separate from mechanical status. */
export const QuestVisibility = z.enum(["hidden", "rumored", "known"]);

export const QuestStepStatus = z.enum(["locked", "active", "complete", "failed"]);

export const QuestStep = z.object({
  id: z.string(),
  desc: z.string(),
  status: QuestStepStatus.default("locked"),
  preconditions: z.array(Condition).default([]),   // must all hold before this step can activate
  completion_triggers: z.array(Trigger).default([]),
  on_complete: z.array(Effect).default([]),
});
export type QuestStep = z.infer<typeof QuestStep>;

/** A hint the player has actually learned. This is what the DM is allowed to surface. */
export const Lead = z.object({
  text: z.string(),
  learned_turn: z.number().int().nonnegative(),
  source_entity_id: Id.nullable().default(null),
  points_to_location_id: Id.nullable().default(null),
});
export type Lead = z.infer<typeof Lead>;

export const QuestRewards = z.object({
  xp: z.number().int().nonnegative().default(0),
  gold: z.number().int().nonnegative().default(0),
  item_def_ids: z.array(Id).default([]),
  relationship_deltas: z.array(z.object({
    subject: Id, object: Id, dims: Dims,
  })).default([]),
});

export const Quest = z.object({
  id: Id,
  title: z.string(),
  giver_entity_id: Id.nullable().default(null),
  status: QuestStatus.default("unknown"),
  visibility: QuestVisibility.default("hidden"),
  summary: z.string(),                       // player-facing, shown in the quest log
  dm_notes: z.string().default(""),          // truth the player does not know yet
  current_step_id: z.string().nullable().default(null),
  steps: z.array(QuestStep).default([]),
  leads: z.array(Lead).default([]),
  rewards: QuestRewards.default({}),
  deadline_world_minute: z.number().int().nullable().default(null),
  failure_triggers: z.array(Trigger).default([]),
  requires: z.array(Id).default([]),         // quest ids that must be complete first
  blocks: z.array(Id).default([]),           // quest ids this one forecloses
});
export type Quest = z.infer<typeof Quest>;
