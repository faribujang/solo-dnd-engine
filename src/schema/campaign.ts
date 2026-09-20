import { z } from "zod";
import { Id } from "./common.js";
import { Effect } from "./dsl.js";

/**
 * The layer above quests.
 *
 *   World      persistent. Outlives every party. Carries the legacy ledger.
 *   Campaign   one party's run. 3–5 arcs and an overarching goal.
 *   Arc        a movement of the story. Owns quests, has a climax, plants seeds.
 *   Quest      (schema/quest.ts)
 */

export const ArcStatus = z.enum(["locked", "active", "complete", "abandoned"]);

/** A hook an arc plants for a later arc or campaign to pick up. */
export const Seed = z.object({
  id: Id,
  text: z.string(),                          // "Garret's sister still works for the Hand"
  kind: z.enum(["fact", "npc", "location", "debt", "artefact"]).default("fact"),
  subject_ids: z.array(Id).default([]),
  promoted: z.boolean().default(false),      // became a quest or rumour in a later run
});
export type Seed = z.infer<typeof Seed>;

export const Arc = z.object({
  id: Id,
  title: z.string(),
  status: ArcStatus.default("locked"),
  summary: z.string().default(""),
  themes: z.array(z.string()).default([]),
  quest_ids: z.array(Id).default([]),
  climax_quest_id: Id.nullable().default(null),
  seeds: z.array(Seed).default([]),
  requires_arc_ids: z.array(Id).default([]),
});
export type Arc = z.infer<typeof Arc>;

export const Campaign = z.object({
  id: Id,
  title: z.string(),
  premise: z.string().default(""),
  arc_ids: z.array(Id).default([]),
  /** Applied as ordinary effects at turn zero, so it is journaled like everything else. */
  world_mutation: z.array(Effect).default([]),
  status: z.enum(["available", "active", "complete"]).default("available"),
});
export type Campaign = z.infer<typeof Campaign>;

/** What a completed campaign left behind. Append-only, like the fact ledger. */
export const LegacyEntry = z.object({
  campaign_id: Id,
  completed_turn: z.number().int().nonnegative(),
  world_minute: z.number().int().nonnegative(),
  party_ids: z.array(Id).default([]),
  text: z.string(),                          // "The Ashen Hand lost the river trade."
  subject_ids: z.array(Id).default([]),
});
export type LegacyEntry = z.infer<typeof LegacyEntry>;

export const Difficulty = z.enum(["story", "normal", "hard", "ironman"]);
export type Difficulty = z.infer<typeof Difficulty>;

/** Session zero: the table's agreement before play. Injected into the DM system prompt. */
export const SessionZero = z.object({
  tone: z.enum(["grim", "heroic", "comic", "blend"]).default("blend"),
  lines: z.array(z.string()).default([]),    // content that does not appear at all
  veils: z.array(z.string()).default([]),    // content handled off-screen
  difficulty: Difficulty.default("normal"),
  levelling: z.enum(["xp", "milestone"]).default("xp"),
  /**
   * How dice behave.
   *   true       — every roll is fresh and independent, like a physical die.
   *   karmic     — fresh, with a subtle streak-breaker (Baldur's Gate 3's default): after a
   *                run of low rolls the next is nudged up, and vice versa. Never decides a
   *                roll; only leans on it.
   *   committed  — seeded by the situation, so rewind-and-retry cannot reroll a check.
   * Every mode journals the roll, so replay is exact in all three.
   */
  dice: z.enum(["true", "karmic", "committed"]).default("karmic"),
  /**
   * How much happens that nobody planned.
   *
   * Not a difficulty setting — it does not change a single DC. It changes how often the
   * world interrupts: a pedlar on the road, a faction camp off the causeway, somebody
   * who wants a word. The stuff between the plot points, which is most of what people
   * remember about a campaign and the first thing a story-shaped engine cuts.
   *
   *   quiet   — the road is a road. Travel is a transition.
   *   normal  — something happens on a long journey, now and then.
   *   lively  — the world keeps having opinions at you.
   */
  liveliness: z.enum(["quiet", "normal", "lively"]).default("normal"),
});
export type SessionZero = z.infer<typeof SessionZero>;

/** A set of party members travelling together. One by default; a split makes two. */
export const Group = z.object({
  id: Id,
  member_ids: z.array(Id).min(1),
  /** The member whose location defines this group's scene. */
  lead_id: Id,
});
export type Group = z.infer<typeof Group>;

/**
 * How a faction stands in one settlement — the cell of the faction matrix.
 *
 * Factions and settlements both existed and nothing connected them, so a world was a list
 * of towns with some global reputation numbers floating above it. There was no way to say
 * "the Syndicate runs the docks here but the Accord is still quietly sheltering people in
 * the temple district", which is the difference between a political map and a spreadsheet.
 *
 * The DM's trick this encodes: for every faction and every town, ask *who is in power here,
 * and who is trying to change that*. Side quests fall out of the answer rather than being
 * authored one at a time.
 */
export const Allegiance = z.enum([
  "holds",     // this place answers to them
  "contests",  // they are pushing for it, and it is not settled
  "present",   // they operate here without running it
  "hunted",    // they are here, and being known for them is dangerous
]);
export type Allegiance = z.infer<typeof Allegiance>;

export const FactionPresence = z.object({
  faction_id: Id,
  allegiance: Allegiance,
  /** 0–100. How much of the place actually answers to them. */
  strength: z.number().int().min(0).max(100).default(50),
  /**
   * Whether you can SEE them operating. A faction that holds a town openly is the law; one
   * that holds it covertly is the reason the law does what it does.
   */
  openness: z.enum(["open", "quiet", "covert"]).default("open"),
});
export type FactionPresence = z.infer<typeof FactionPresence>;

export const Settlement = z.object({
  id: Id,
  name: z.string(),
  region_id: Id.nullable().default(null),
  location_ids: z.array(Id).default([]),
  population: z.number().int().nonnegative().default(0),
  /** Town-level standing, separate from any individual's opinion and from faction rep. */
  reputation_with_pc: z.number().min(-100).max(100).default(0),
  /** The faction matrix, one row per faction that matters here. */
  presence: z.array(FactionPresence).default([]),
  services: z.array(z.object({
    kind: z.enum(["inn", "shop", "temple", "job_board", "smith"]),
    location_id: Id,
  })).default([]),
});
export type Settlement = z.infer<typeof Settlement>;
