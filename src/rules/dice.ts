import type { Advantage, Roll } from "../schema/common.js";
import { degreeOf } from "./checks.js";
import type { Rng } from "./rng.js";

/** Parsed dice notation: 2d6+3 → { count: 2, sides: 6, flat: 3 } */
export interface DiceSpec {
  count: number;
  sides: number;
  flat: number;
}

const DICE_RE = /^(\d*)d(\d+)\s*([+-]\s*\d+)?$/i;

export function parseDice(notation: string): DiceSpec {
  const m = DICE_RE.exec(notation.trim());
  if (!m) throw new Error(`Unparseable dice notation: "${notation}"`);
  const count = m[1] === "" || m[1] === undefined ? 1 : parseInt(m[1], 10);
  const sides = parseInt(m[2]!, 10);
  const flat = m[3] ? parseInt(m[3].replace(/\s+/g, ""), 10) : 0;
  if (count < 1 || sides < 1) throw new Error(`Nonsensical dice notation: "${notation}"`);
  return { count, sides, flat };
}

/** Roll dice notation and return the summed total. */
export function rollDice(rng: Rng, notation: string): number {
  const { count, sides, flat } = parseDice(notation);
  let total = flat;
  for (let i = 0; i < count; i++) total += rng.int(1, sides);
  return total;
}

/**
 * A d20 test. Handles advantage/disadvantage and 5e crit rules.
 *
 * Crits and fumbles are flagged on the natural die, but whether they MATTER is the
 * caller's business: an attack roll crits on a 20, an ability check does not auto-succeed.
 */
export function rollD20(
  rng: Rng,
  opts: {
    purpose: string;
    mods: number;
    target: number | null;
    advantage?: Advantage;
    isAttack?: boolean;
    /** Karmic lean, -1..1. Zero for true and committed dice. */
    lean?: number;
    /** Itemised modifier sources, for the roll card. */
    parts?: Array<{ label: string; value: number }>;
    /** How far below the DC still succeeds at a cost. Difficulty sets it; see checks.ts. */
    costMargin?: number;
  },
): Roll {
  const advantage = opts.advantage ?? "none";
  const lean = opts.lean ?? 0;

  // One natural die, possibly nudged by karma. Advantage/disadvantage is applied on top,
  // to the nudged value, so the two mechanisms compose the way a player would expect.
  const natural = (): number => {
    const first = rng.int(1, 20);
    if (lean === 0 || !rng.chance(Math.abs(lean) * 0.35)) return first;
    const second = rng.int(1, 20);
    return lean > 0 ? Math.max(first, second) : Math.min(first, second);
  };

  const a = natural();
  const b = advantage === "none" ? null : natural();

  let raw = a;
  if (b !== null) raw = advantage === "advantage" ? Math.max(a, b) : Math.min(a, b);

  const total = raw + opts.mods;
  const isAttack = opts.isAttack ?? false;

  // 5e: attack rolls auto-hit on a natural 20 and auto-miss on a natural 1.
  // Ability checks and saves do neither — they are just a 20 or a 1.
  let success: boolean | null = null;
  if (opts.target !== null) {
    if (isAttack && raw === 20) success = true;
    else if (isAttack && raw === 1) success = false;
    else success = total >= opts.target;
  }

  return {
    purpose: opts.purpose,
    die: "d20",
    raw,
    raw_second: b,
    mods: opts.mods,
    total,
    target: opts.target,
    success,
    critical: isAttack && raw === 20,
    fumble: isAttack && raw === 1,
    advantage,
    // Ability checks and saves are graded; attacks are hit or miss. The natural die is
    // passed in so a 20 or a 1 can move the band — see degreeOf.
    degree: !isAttack && opts.target !== null
      ? degreeOf(total, opts.target, { natural: raw, ...(opts.costMargin !== undefined ? { costMargin: opts.costMargin } : {}) })
      : null,
    parts: opts.parts ?? [],
  };
}

/** A damage roll, recorded as a Roll with no target and no success. */
export function rollDamage(rng: Rng, notation: string, bonus: number, critical: boolean): Roll {
  const spec = parseDice(notation);
  // A critical doubles the dice, not the flat modifier.
  const count = critical ? spec.count * 2 : spec.count;
  let dice = 0;
  for (let i = 0; i < count; i++) dice += rng.int(1, spec.sides);
  const total = dice + spec.flat + bonus;
  return {
    purpose: "damage",
    die: notation,
    raw: dice,
    raw_second: null,
    mods: spec.flat + bonus,
    total: Math.max(0, total),
    target: null,
    success: null,
    critical,
    fumble: false,
    advantage: "none",
    degree: null,
    parts: [],
  };
}
