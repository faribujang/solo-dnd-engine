import { z } from "zod";
import { Id } from "./common.js";

/**
 * A THREAD: something you said you'd do.
 *
 * The gap this fills is structural, not cosmetic. Quests are authored — steps, triggers,
 * rewards, deadlines — and the narrator can only ever add a lead to one that already
 * exists. So a campaign has exactly as many objectives as a human wrote, and the thing
 * every real table is made of is impossible: the tavern keeper's daughter, the debt you
 * offered to settle, the door somebody asked you not to open. Wild side quests, sub-arcs
 * inside an arc, a throwaway NPC who becomes a three-session detour.
 *
 * A thread is that, with none of the machinery. No steps, no rewards, no triggers, no
 * state machine — a sentence, who it is about, and whether it is still hanging over you.
 * That is deliberately the smallest object that can carry an obligation, because the
 * narrator is allowed to create these and it should not be allowed to create anything
 * with mechanical teeth.
 *
 * Quests are the spine. Threads are everything else.
 */

export const ThreadStatus = z.enum([
  "open",     // still hanging over you
  "kept",     // you did it
  "broken",   // you did the opposite, or somebody else settled it first
  "faded",    // nobody has mentioned it in a long time; the world moved on
]);
export type ThreadStatus = z.infer<typeof ThreadStatus>;

export const Thread = z.object({
  id: Id,
  /** One sentence, in the second person: "Find out who is collecting Emeric's pension." */
  text: z.string().min(1).max(240),
  status: ThreadStatus.default("open"),
  /** Who it is about. Drives whether it surfaces when you are standing in front of them. */
  subject_ids: z.array(Id).default([]),
  /** Where it belongs, if anywhere. */
  location_id: Id.nullable().default(null),
  /** Who asked. Used for the reason line when it is kept or broken. */
  from_entity_id: Id.nullable().default(null),
  opened_turn: z.number().int().nonnegative().default(0),
  opened_world_minute: z.number().int().nonnegative().default(0),
  /**
   * When the world stops caring, in world minutes.
   *
   * Threads FADE rather than accumulating. A journal with forty open promises in it is
   * not a rich world, it is a to-do list nobody can read — and an obligation that can
   * never expire is not an obligation, it is furniture. Fading is silent and automatic;
   * breaking is loud and someone's fault.
   */
  fades_at_world_minute: z.number().int().nonnegative().nullable().default(null),
  /** How it ended, in the world's words rather than a status enum. */
  outcome: z.string().default(""),
  source: z.enum(["authored", "narrator"]).default("narrator"),
});
export type Thread = z.infer<typeof Thread>;

/** Open threads at once. Past this the Journal stops being readable. */
export const MAX_OPEN_THREADS = 12;

/** New threads one turn may open. A scene makes a promise; it does not make five. */
export const MAX_NEW_THREADS_PER_TURN = 1;

/** How long an untouched thread survives, in world minutes. Ten days. */
export const THREAD_FADE_MINUTES = 10 * 24 * 60;
