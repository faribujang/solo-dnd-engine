import type { Difficulty } from "../schema/campaign.js";
import type { GameState } from "../schema/state.js";

/**
 * Difficulty, made real.
 *
 * `session_zero.difficulty` was stored and read by nothing, which made session zero a
 * questionnaire rather than a decision. These are the levers it actually pulls. Every one
 * is a number code consults — none of them is a hint to the narrator, because "be gentler"
 * is exactly the instruction a model will interpret as "let them win".
 */

export interface DifficultyLevers {
  /** Added to every skill-check DC. Negative makes the world more forgiving. */
  dc_shift: number;
  /** Multiplier on the karmic streak-breaker. 0 disables it. */
  karmic_strength: number;
  /** How many Inspiration points a character may hold. */
  inspiration_cap: number;
  /** Multiplier on monster damage. */
  enemy_damage: number;
  /** Which options appear when a character dies. */
  death_options: readonly ("revive" | "rewind" | "continue" | "permadeath")[];
  /** Whether rewind is offered at all. */
  rewind_allowed: boolean;
  /** Encounter budget multiplier when rolling from an encounter table. */
  encounter_budget: number;
  /** Long rest restores this fraction of max HP. 1 is RAW. */
  long_rest_fraction: number;
  /**
   * How far below the DC still counts as SUCCESS AT A COST. 0 removes the band entirely,
   * making every check pass or fail cleanly — which is what ironman players ask for and
   * what everyone else would find joyless.
   */
  cost_margin: number;
}

export const DIFFICULTY: Record<Difficulty, DifficultyLevers> = {
  story: {
    dc_shift: -2,
    karmic_strength: 0.55,
    inspiration_cap: 3,
    enemy_damage: 0.75,
    death_options: ["revive", "rewind", "continue"],
    rewind_allowed: true,
    encounter_budget: 0.75,
    long_rest_fraction: 1,
    cost_margin: 6,
  },
  normal: {
    dc_shift: 0,
    karmic_strength: 0.35,
    inspiration_cap: 2,
    enemy_damage: 1,
    death_options: ["revive", "rewind", "continue"],
    rewind_allowed: true,
    encounter_budget: 1,
    long_rest_fraction: 1,
    cost_margin: 4,
  },
  hard: {
    dc_shift: 1,
    karmic_strength: 0.15,
    inspiration_cap: 1,
    enemy_damage: 1.15,
    death_options: ["revive", "continue"],
    rewind_allowed: true,
    encounter_budget: 1.25,
    long_rest_fraction: 0.75,
    cost_margin: 2,
  },
  ironman: {
    // No rewind, no karma, and death is death. Committed dice are forced on at load, so
    // even reloading a save cannot change a roll.
    dc_shift: 1,
    karmic_strength: 0,
    inspiration_cap: 1,
    enemy_damage: 1.25,
    death_options: ["revive", "permadeath"],
    rewind_allowed: false,
    encounter_budget: 1.25,
    long_rest_fraction: 0.5,
    cost_margin: 0,
  },
};

export function leversOf(s: GameState): DifficultyLevers {
  return DIFFICULTY[s.meta.session_zero.difficulty];
}
