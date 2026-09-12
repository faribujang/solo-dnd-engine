import { z } from "zod";
import { DifficultyBand, Id, Skill } from "../schema/common.js";
import { Ability } from "../schema/common.js";

/**
 * The two LLM contracts. Both calls use structured output derived from these schemas —
 * there is no prose parsing anywhere in the system.
 *
 * These are deliberately narrow. Everything the model is allowed to influence is named
 * here; everything else it might try to do is dropped by src/llm/validate.ts and logged.
 */

// ------------------------------------------------------------------ intent

export const IntentAction = z.enum([
  "move", "skill_check", "attack", "cast", "talk", "use_item", "take", "give",
  "trade", "rest", "wait", "look", "inventory", "meta", "unclear",
  "end_turn", "dash", "disengage", "dodge", "flee", "move_zone",
  // Asking the DM is not taking a turn. See engine/questions.ts.
  "ask",
]);
export type IntentAction = z.infer<typeof IntentAction>;

export const DialogueIntent = z.enum(["persuade", "deceive", "intimidate", "inquire", "chat"]);

export const Intent = z.object({
  action: IntentAction,
  /** Free text the player used to name a target; code resolves it to an id. */
  target_name: z.string().nullable().default(null),
  direction: z.string().nullable().default(null),
  skill: Skill.nullable().default(null),
  ability: Ability.nullable().default(null),
  item_name: z.string().nullable().default(null),
  /** A BAND, never a number. Only rules/checks.ts turns this into a DC. */
  difficulty_band: DifficultyBand.nullable().default(null),
  /** Names what the check is FOR, so authored triggers can match a specific attempt. */
  tag: z.string().nullable().default(null),
  dialogue_intent: DialogueIntent.nullable().default(null),
  topic: z.string().nullable().default(null),
  minutes: z.number().int().nonnegative().nullable().default(null),
  rest_kind: z.enum(["short", "long"]).nullable().default(null),
  /** For `ask`: which question, and about what. */
  question: z.enum(["surroundings", "who", "reach", "condition", "know", "carrying", "doing", "time", "options"]).nullable().default(null),
  rationale: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type Intent = z.infer<typeof Intent>;

/** Below this, or on `unclear`, we ask the player rather than guessing. */
export const CONFIDENCE_FLOOR = 0.6;

// --------------------------------------------------------------- narration

/** A fact the narrator wants written to the ledger. */
export const ProposedFact = z.object({
  text: z.string().min(1),
  kind: z.enum(["world", "npc", "item", "quest", "pc_action", "lore"]).default("world"),
  subjects: z.array(z.string()).default([]),      // names or ids; code resolves and drops misses
  importance: z.number().int().min(1).max(5).default(3),
  secret: z.boolean().default(false),
});

export const ProposedAttitude = z.object({
  subject: z.string(),
  object: z.string(),
  dims: z.object({
    affinity: z.number().optional(),
    trust: z.number().optional(),
    fear: z.number().optional(),
    respect: z.number().optional(),
  }),
  reason: z.string().default(""),
});

export const ProposedOpinion = z.object({
  subject: z.string(),
  object: z.string(),
  opinion: z.string(),
});

/**
 * The narrator's soft proposals. Note what is NOT here: no damage, no healing, no items,
 * no quest status, no combat. Those come only from the rules engine or authored triggers.
 */
export const NarratorProposal = z.discriminatedUnion("t", [
  z.object({ t: z.literal("set_flag"), key: z.string(), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
  z.object({ t: z.literal("add_lead"), quest_id: z.string(), text: z.string(), points_to_location_id: z.string().nullable().default(null) }),
  z.object({ t: z.literal("reveal_location"), location_id: z.string() }),
  z.object({ t: z.literal("reveal_exit"), location_id: z.string(), dir: z.string() }),
  z.object({ t: z.literal("teach_fact"), entity_id: z.string(), fact_id: z.string() }),
  z.object({ t: z.literal("move_entity"), entity_id: z.string(), location_id: z.string() }),
  z.object({ t: z.literal("advance_time"), minutes: z.number().int().nonnegative() }),
]);
export type NarratorProposal = z.infer<typeof NarratorProposal>;

export const Narration = z.object({
  narration: z.string().min(1),
  facts: z.array(ProposedFact).default([]),
  attitude_deltas: z.array(ProposedAttitude).default([]),
  opinion_updates: z.array(ProposedOpinion).default([]),
  proposals: z.array(NarratorProposal).default([]),
  suggested_actions: z.array(z.string()).default([]),
  scene_change: z.string().nullable().default(null),
});
export type Narration = z.infer<typeof Narration>;

// ------------------------------------------------------------ scene digest

export const SceneDigest = z.object({
  /** Two or three sentences. Tone and pacing only — never relied on for facts. */
  digest: z.string().min(1),
  title: z.string().default(""),
});
export type SceneDigest = z.infer<typeof SceneDigest>;

// --------------------------------------------------------- ambient / world

/**
 * A single offscreen beat the player would plausibly notice. Code decides WHAT happened
 * from NPC goals and faction state; the model only says how it looked.
 */
export const AmbientBeat = z.object({
  line: z.string().min(1),
});
export type AmbientBeat = z.infer<typeof AmbientBeat>;

/** Every id the model may be asked to produce, for building "you may only name these" lists. */
export const IdRef = Id;
