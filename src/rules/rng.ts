/**
 * Seeded PRNG. xorshift32 — small, fast, and fully described by a single 32-bit word,
 * which means the whole generator serializes to 8 hex characters inside campaign.json.
 *
 * The engine reducer never touches this. All randomness happens during resolution and is
 * baked into the event, so a replay reproduces state without re-rolling anything.
 */

export type RngState = string; // 8 hex chars

/**
 * COMMITTED DICE.
 *
 * Every roll is seeded by the situation, not drawn from a mutable stream:
 *
 *   key = H(campaign_seed, turn, actor, purpose, attempt)
 *
 * Rewind and retry the same check on the same turn -> the identical die. The die was cast
 * when the situation arose, and reloading does not recast it. Try a genuinely different
 * approach -> a different purpose -> a fresh die, because the fiction changed. Spend a
 * reroll (Lucky, Bardic Inspiration) -> attempt+1 -> a fresh die, because that is a rule.
 *
 * It is also a net simplification: the hash is pure, so there is no generator state to
 * thread through resolution, store on the campaign, or restore during replay.
 */
export function seedFor(
  campaignSeed: string, turn: number, actorId: string, purpose: string, attempt = 0,
): RngState {
  return seedToState(`${campaignSeed}|${turn}|${actorId}|${purpose}|${attempt}`);
}

/** Fresh entropy for a "true" or "karmic" roll. Stored on the event so replay reuses it. */
export function freshNonce(): string {
  const a = Math.floor(Math.random() * 0x100000000) >>> 0;
  const b = Math.floor(Math.random() * 0x100000000) >>> 0;
  return toHex(a) + toHex(b);
}

/**
 * KARMIC DICE — the streak-breaker.
 *
 * Given the actor's recent natural d20s, returns a lean in [-1, 1]: negative after a hot
 * streak, positive after a cold one. The die is still rolled for real; with probability
 * |lean| × KARMIC_STRENGTH a second die is rolled and the one on the favoured side is kept.
 * That is the whole mechanism. It cannot manufacture a 20, and it cannot deny one — it only
 * makes five failures in a row rarer than a fair die would, which is what people actually
 * mean when they say a die feels cursed.
 */
export const KARMIC_WINDOW = 6;
export const KARMIC_STRENGTH = 0.35;

export function karmicLean(recent: readonly number[]): number {
  if (recent.length < 2) return 0;
  const window = recent.slice(-KARMIC_WINDOW);
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  return Math.max(-1, Math.min(1, (10.5 - mean) / 9.5));
}

/** FNV-1a, used to turn a human-typed seed string into a non-zero 32-bit word. */
export function seedToState(seed: string): RngState {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  if (h === 0) h = 0x9e3779b9; // xorshift cannot escape zero
  return toHex(h);
}

export function toHex(n: number): RngState {
  return (n >>> 0).toString(16).padStart(8, "0");
}

export function fromHex(s: RngState): number {
  const n = parseInt(s, 16) >>> 0;
  return n === 0 ? 0x9e3779b9 : n;
}

/** Advance the generator. Returns the new state and a float in [0, 1). */
export function next(state: RngState): { state: RngState; value: number } {
  let x = fromHex(state);
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;  x >>>= 0;
  return { state: toHex(x), value: x / 0x100000000 };
}

/** Uniform integer in [min, max] inclusive. */
export function nextInt(state: RngState, min: number, max: number): { state: RngState; value: number } {
  const r = next(state);
  return { state: r.state, value: min + Math.floor(r.value * (max - min + 1)) };
}

/**
 * A small mutable cursor so a resolution step can draw several times without threading
 * state by hand. The caller reads `.state` afterwards and stores it back on the campaign.
 */
export class Rng {
  constructor(public state: RngState) {}

  float(): number {
    const r = next(this.state);
    this.state = r.state;
    return r.value;
  }

  int(min: number, max: number): number {
    const r = nextInt(this.state, min, max);
    this.state = r.state;
    return r.value;
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.float() < p;
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error("Rng.pick on empty array");
    return arr[this.int(0, arr.length - 1)]!;
  }
}
