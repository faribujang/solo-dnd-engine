import { z } from "zod";
import { Id } from "./common.js";

/**
 * Combat is a CombatState INSIDE GameState, not a separate mode of the app. The turn
 * pipeline is identical; only the legal action set narrows, and the action economy is
 * enforced. This is what lets the affordance bar teach the economy: the pips are real.
 */

/** 5e action economy, per combatant, reset at the start of their turn. */
export const Economy = z.object({
  action: z.boolean().default(true),
  bonus: z.boolean().default(true),
  reaction: z.boolean().default(true),
  /** Zone moves remaining this turn. Normal speed buys 1; Dash buys another. */
  moves: z.number().int().nonnegative().default(1),
  dodging: z.boolean().default(false),       // attacks against have disadvantage until next turn
  disengaged: z.boolean().default(false),    // leaving a zone provokes no opportunity attack
});
export type Economy = z.infer<typeof Economy>;

export const Combatant = z.object({
  entity_id: Id,
  initiative: z.number().int(),
  side: z.enum(["party", "enemy"]),
  economy: Economy.default({}),
  /** Set when a creature has fled the fight; they are out of the order. */
  fled: z.boolean().default(false),
});
export type Combatant = z.infer<typeof Combatant>;

export const Concentration = z.object({
  spell_id: z.string(),
  target_ids: z.array(Id).default([]),
  /** Concentration effects end at this round if not broken sooner. */
  ends_round: z.number().int().nullable().default(null),
});

export const CombatState = z.object({
  id: Id,
  location_id: Id,
  round: z.number().int().positive().default(1),
  /** Sorted descending by initiative; ties to higher dex, then to the party. */
  order: z.array(Combatant).min(1),
  current: z.number().int().nonnegative().default(0),
  /** entity_id → what they are concentrating on. */
  concentration: z.record(z.string(), Concentration).default({}),
  /** Round-scoped log lines, for the combat panel. Cleared when combat ends. */
  log: z.array(z.string()).default([]),
  started_turn: z.number().int().nonnegative(),
});
export type CombatState = z.infer<typeof CombatState>;

/** Per-zone surfaces (fire, grease, water, ice) — the tactical layer. Phase 4 optional. */
export const Surface = z.enum(["fire", "grease", "water", "ice", "none"]);
