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
  // Hours rather than a moment: "ask around town", "spend the morning searching".
  "montage",
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
  /** For `montage`: how the hours were spent. */
  montage_kind: z.enum(["ask_around", "search", "watch", "work"]).nullable().default(null),
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
  z.object({ t: z.literal("introduce_local"), name: z.string(), descriptor: z.string(), pronouns: z.string().default("they/them"), location_id: z.string(), voice: z.string().default(""), trait: z.string().default("") }),
  z.object({ t: z.literal("give_item"), entity_id: z.string(), item_def_id: z.string(), qty: z.number().int().positive().default(1) }),
  z.object({ t: z.literal("open_thread"), text: z.string(), subject_ids: z.array(z.string()).default([]), location_id: z.string().nullable().default(null), from_entity_id: z.string().nullable().default(null) }),
  z.object({ t: z.literal("resolve_thread"), thread_id: z.string(), as: z.enum(["kept", "broken", "faded"]), outcome: z.string().default("") }),
]);
export type NarratorProposal = z.infer<typeof NarratorProposal>;

/**
 * How a proposal arrives on the wire: tagged, and otherwise unexamined.
 *
 * The strict union above is the LAW, and `validateNarration` enforces every clause of it.
 * It is deliberately NOT the parser at the transport boundary, because those two jobs have
 * opposite failure modes. A narrator that writes four perfect paragraphs and one invented
 * effect name has made a mechanics mistake, and this codebase has a whole apparatus for
 * mechanics mistakes: the effect is refused and recorded in `rejects.jsonl`. Parsing
 * strictly here instead throws away the paragraphs — the one part of the answer the model
 * was actually qualified to produce — over the one part code was always going to check.
 *
 * So: anything tagged gets through the door, and nothing untrue gets past the validator.
 */
export const WireProposal = z.object({ t: z.string() }).passthrough();

export const Narration = z.object({
  narration: z.string().min(1),
  facts: z.array(ProposedFact).default([]),
  attitude_deltas: z.array(ProposedAttitude).default([]),
  opinion_updates: z.array(ProposedOpinion).default([]),
  proposals: z.array(WireProposal).default([]),
  suggested_actions: z.array(z.string()).default([]),
  scene_change: z.string().nullable().default(null),

  /**
   * A promise the player just made, and a promise just settled.
   *
   * These are threads (schema/thread.ts), and they are TOP-LEVEL FIELDS rather than
   * entries in `proposals` for an entirely empirical reason: measured against a live
   * model, `facts` and `attitude_deltas` come back populated on nearly every turn while
   * `proposals` comes back empty on nearly all of them. A field the schema names gets
   * filled; an option buried in a generic tagged union gets skipped, no matter how the
   * prompt begs.
   *
   * Opening a thread is the single most common thing the narrator should do — the player
   * says "I'll find out what happened to him" constantly — so it gets the shape that
   * actually works rather than the shape that is tidier.
   */
  new_thread: z.object({
    /** Second person, as an obligation: "Find out what happened to the courier." */
    text: z.string(),
    subject_ids: z.array(z.string()).default([]),
    from_entity_id: z.string().nullable().default(null),
  }).nullable().default(null),

  settled_thread: z.object({
    thread_id: z.string(),
    as: z.enum(["kept", "broken", "faded"]),
    outcome: z.string().default(""),
  }).nullable().default(null),
});
export type Narration = z.infer<typeof Narration>;

/**
 * The DM answering a question, rather than reciting what it knows.
 *
 * Asking is free and never a turn, so this used to hand the player the raw facts the
 * engine had selected — every true thing about Cotter Vane, in a wall, which answers
 * nothing. Code still decides WHAT the player may know; this only decides how it is said.
 */
export const DMAnswer = z.object({
  /** One or two sentences. Second person, in the DM's voice. */
  answer: z.string().min(1),
});
export type DMAnswer = z.infer<typeof DMAnswer>;

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
