import { z } from "zod";
import { Id } from "./common.js";
import { Effect } from "./dsl.js";

/**
 * PROGRESS CLOCKS — from Blades in the Dark, and the cheapest way to make a situation feel
 * like it is going somewhere.
 *
 * A clock is a named thing with segments that fill. The guards' suspicion. The flood
 * rising. How close the Ashen Hand is to finding the bell. When it fills, something
 * happens — and because it is visible, the player can see it coming and decide whether to
 * spend time on it.
 *
 * This is the honest version of a hidden timer. A DM who says "you feel time is short" is
 * asking to be trusted; a clock with four of six segments filled has already been trusted.
 */
export const Clock = z.object({
  id: Id,
  name: z.string(),                          // "The Hand closes in"
  /** Player-facing, or hidden until something reveals it. */
  visible: z.boolean().default(true),
  segments: z.number().int().min(2).max(12),
  filled: z.number().int().nonnegative().default(0),
  /** Fractional progress carried between ticks, so half a day twice is a whole day. */
  drift: z.number().min(0).max(1).default(0),
  /** Fires once when `filled` reaches `segments`. */
  on_complete: z.array(Effect).default([]),
  /** Advances this many segments per in-world day, on its own. 0 means only events move it. */
  per_day: z.number().default(0),
  /** Set when it completes, so it does not fire twice. */
  done: z.boolean().default(false),
  /** What it belongs to, for grouping in the UI. */
  quest_id: Id.nullable().default(null),
  arc_id: Id.nullable().default(null),
});
export type Clock = z.infer<typeof Clock>;

/**
 * VOWS — from Ironsworn, and the answer to "why does my character care".
 *
 * Arcs and quests are things the world wants. A vow is what the *character* wants, sworn at
 * session zero and carried until it is fulfilled or forsworn. It is a progress track rather
 * than a checklist, so it advances by degrees and the player can see how far they have come.
 *
 * Without one, a campaign is a list of errands. With one, every errand is either progress
 * or a detour, and the player knows which.
 */
export const VowRank = z.enum(["troublesome", "dangerous", "formidable", "extreme", "epic"]);
export type VowRank = z.infer<typeof VowRank>;

/** How many ticks one unit of progress is worth. Ten ticks fill one of ten boxes. */
export const VOW_PROGRESS: Record<VowRank, number> = {
  troublesome: 30,   // three boxes per meaningful step — a short vow
  dangerous: 20,
  formidable: 10,
  extreme: 4,
  epic: 2,           // a whole campaign's spine
};

export const Vow = z.object({
  id: Id,
  /** Whose oath. Each character may swear their own. */
  sworn_by: Id,
  text: z.string(),                          // "Find out what my father pledged, and undo it"
  rank: VowRank.default("dangerous"),
  /** 0..100 ticks; 10 ticks is one filled box of ten. */
  progress: z.number().int().min(0).max(100).default(0),
  status: z.enum(["sworn", "fulfilled", "forsworn"]).default("sworn"),
  /** Quests and arcs that advance it, so code can tick it without an author remembering to. */
  advanced_by_quest_ids: z.array(Id).default([]),
  sworn_turn: z.number().int().nonnegative().default(0),
});
export type Vow = z.infer<typeof Vow>;

export function filledBoxes(v: Vow): number {
  return Math.floor(v.progress / 10);
}

export function vowComplete(v: Vow): boolean {
  return v.progress >= 100;
}
