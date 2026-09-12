import type { Entity } from "../schema/entity.js";

/**
 * XP and levelling. SRD thresholds, levels 1–8 (the campaign's target range), with the
 * higher tiers present so a save that overshoots does not fall off the table.
 */
export const XP_THRESHOLDS: readonly number[] = [
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000,
];

export const MAX_LEVEL = 8;

export function levelForXp(xp: number): number {
  let lvl = 1;
  for (let i = 1; i < XP_THRESHOLDS.length; i++) if (xp >= XP_THRESHOLDS[i]!) lvl = i + 1;
  return Math.min(MAX_LEVEL, lvl);
}

export function xpToNext(e: Entity): number | null {
  if (e.level >= MAX_LEVEL) return null;
  return Math.max(0, XP_THRESHOLDS[e.level]! - e.xp);
}

export function proficiencyForLevel(level: number): number {
  return 2 + Math.floor((level - 1) / 4);
}

/** SRD experience by Challenge Rating. */
export const XP_BY_CR: Record<string, number> = {
  "0": 10, "1/8": 25, "1/4": 50, "1/2": 100, "1": 200, "2": 450, "3": 700, "4": 1100,
  "5": 1800, "6": 2300, "7": 2900, "8": 3900,
};

export function xpForCR(cr: string): number {
  return XP_BY_CR[cr] ?? 0;
}

/**
 * Awards for things other than killing. Non-violent resolution pays the same as combat —
 * if talking past the guard paid less than killing him, the system would have told the
 * player what it wants, and it is not what we want.
 */
export const XP_AWARD = {
  quest_step: (partyLevel: number) => 50 * partyLevel,
  quest_complete: (partyLevel: number) => 150 * partyLevel,
  discover_location: 50,
  learn_fact: (importance: number) => (importance >= 4 ? 50 : 25),
} as const;

/** Hit die size per class. */
export const HIT_DIE: Record<string, number> = {
  cls_fighter: 10, cls_rogue: 8, cls_cleric: 8, cls_wizard: 6, cls_commoner: 8, cls_guard: 8,
};

/** Average roll on the hit die, as 5e offers instead of rolling. */
export function averageHp(die: number): number {
  return Math.floor(die / 2) + 1;
}
