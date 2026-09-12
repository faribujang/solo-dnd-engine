import type { Disposition, Relationship } from "../schema/relationship.js";

/**
 * The mechanical consequences of how someone feels about you. This is where the numeric
 * spine of a relationship earns its keep — without this file, affinity would be flavour
 * text and the LLM would be free to invent whether the innkeeper helps you.
 */

/** Derived label. Never stored on the edge; always computed from dims. */
export function dispositionOf(affinity: number): Disposition {
  if (affinity <= -60) return "hostile";
  if (affinity <= -30) return "cold";
  if (affinity <= -10) return "wary";
  if (affinity < 10) return "neutral";
  if (affinity < 35) return "warming";
  if (affinity < 70) return "friendly";
  return "devoted";
}

/** Social DC shift from affinity, capped at ±3 so it colours a check without deciding it. */
export function dispositionDcShift(affinity: number): number {
  const raw = Math.round(affinity / 20);
  // `|| 0` normalizes negative zero. It would serialize as 0 anyway, but a -0 leaking into
  // a DC calculation is the kind of thing that costs an hour to find later.
  return -Math.max(-3, Math.min(3, raw)) || 0;
}

/**
 * Two different thresholds, long conflated.
 *
 * `HOSTILE_FLOOR` is where someone stops engaging with you at all. `SECRET_TRUST` is where
 * they will hand you something that costs them to say — and that has to be EARNED, not
 * merely the absence of suspicion. A stranger who does not distrust you is still a
 * stranger, and the old rule had innkeepers confessing to anyone who had not yet wronged
 * them.
 */
export const HOSTILE_FLOOR = -30;
export const SECRET_TRUST = 25;

export function willShareSecrets(rel: Relationship | undefined): boolean {
  if (!rel) return false;
  return rel.dims.trust >= SECRET_TRUST;
}

/** Whether they will engage at all, secrets aside. */
export function willEngage(rel: Relationship | undefined): boolean {
  return (rel?.dims.trust ?? 0) > HOSTILE_FLOOR;
}

/**
 * What trust does to the DC of getting something out of someone.
 *
 * This is the main lever, and it is deliberately stronger than affinity's ±3: liking you
 * COLOURS a conversation, trusting you DECIDES one. Capped at ±6 so it never makes a hard
 * thing automatic or an easy thing impossible — a stranger can still be talked round by a
 * good roll, and a friend can still refuse on a bad one.
 *
 * Expressed as a DC delta rather than a bonus to the roll, because that is the honest
 * place for it: the difficulty of the ask is what changed, not the character's silver
 * tongue. It shows on the roll card by name — "he barely knows you +3".
 */
export const TRUST_DC_CAP = 6;

export function trustDcShift(trust: number): number {
  const raw = Math.round(-trust / 8);
  return Math.max(-TRUST_DC_CAP, Math.min(TRUST_DC_CAP, raw)) || 0;
}

/** How they read to the player, for the reason line on a guarded topic. */
export function trustLabel(trust: number): string {
  if (trust <= HOSTILE_FLOOR) return "will not deal with you";
  if (trust < -10) return "does not trust you";
  if (trust < 8) return "barely knows you";
  if (trust < SECRET_TRUST) return "is warming to you";
  if (trust < 50) return "trusts you";
  return "would tell you anything";
}

/** Above this fear, an NPC complies or flees rather than being rolled against. */
export const COMPLIANCE_FEAR_FLOOR = 50;

export function willComplyFromFear(rel: Relationship | undefined): boolean {
  if (!rel) return false;
  return rel.dims.fear > COMPLIANCE_FEAR_FLOOR;
}

/** Merchant price multiplier, in hundredths to keep gold arithmetic in integers. */
export function priceMultiplierPct(rel: Relationship | undefined): number {
  if (!rel) return 100;
  const a = rel.dims.affinity;
  if (a > 60) return 90;
  if (a > 25) return 95;
  if (a < -60) return 130;
  if (a < -25) return 115;
  return 100;
}

/** Will this NPC volunteer help without being asked? */
export function offersUnpromptedAid(rel: Relationship | undefined): boolean {
  if (!rel) return false;
  return rel.dims.affinity > 60 && rel.dims.trust > 20;
}
