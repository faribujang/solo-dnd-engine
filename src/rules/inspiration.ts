import type { Entity } from "../schema/entity.js";
import type { GameState } from "../schema/state.js";

/**
 * INSPIRATION — 5e RAW, and the honest answer to "I rolled a 3 and want another shot".
 *
 * Earn it by playing your character rather than by winning: act on your bond, lean into
 * your flaw, hold to your ideal when it costs you. Spend it to reroll a d20 after seeing
 * the result.
 *
 * This matters more than it looks. Under karmic or true dice a rewind CAN reroll a failed
 * check (§32.1), so without Inspiration the only outlet for a bad roll is reaching for the
 * timeline. With it, the player has a legitimate, limited, in-fiction mechanism — and
 * rewind goes back to being what it is for: changing your mind, not your dice.
 */

/** How many points a character may hold. RAW is 1; difficulty moves it (rules/difficulty.ts). */
export function inspirationCap(s: GameState): number {
  switch (s.meta.session_zero.difficulty) {
    case "story": return 3;
    case "normal": return 2;
    case "hard": return 1;
    case "ironman": return 1;
  }
}

export function inspirationOf(e: Entity): number {
  const n = e.flags["inspiration"];
  return typeof n === "number" ? n : 0;
}

export function hasInspiration(e: Entity): boolean {
  return inspirationOf(e) > 0;
}

/**
 * Why a character just earned Inspiration, if they did.
 *
 * Deliberately narrow: the DM proposes these (it is on the narrator whitelist) but code
 * decides whether the situation qualifies, because "you played your flaw" is exactly the
 * kind of judgement a model will hand out for free if left to itself.
 */
export type InspirationReason = "bond" | "ideal" | "flaw" | "trait" | "heroism";

export const REASON_TEXT: Record<InspirationReason, string> = {
  bond: "You acted on what you care about, at a cost.",
  ideal: "You held to your ideal when it would have been easier not to.",
  flaw: "You leaned into your flaw and let it steer you.",
  trait: "You played your character rather than the odds.",
  heroism: "You put yourself between danger and someone else.",
};

/** One award per scene, so it stays a moment rather than a drip. */
export function canAward(s: GameState, e: Entity): boolean {
  if (inspirationOf(e) >= inspirationCap(s)) return false;
  return e.flags["inspiration_scene"] !== s.world.scene_id;
}

/**
 * HOW INSPIRATION IS SPENT — and why not as a reroll.
 *
 * RAW, and every earlier draft of this spec, spends Inspiration to **reroll** a d20 after
 * seeing it. Here it is spent **before** the roll, for advantage. That is a deliberate
 * deviation, for two reasons that both come out of this being a text game rather than a
 * table:
 *
 *   1. **It fits the one UX thesis.** Every other action in this game shows you the odds
 *      before you commit — the evaluator prices what you typed, the affordance bar shows a
 *      hit chance. A post-hoc reroll is a mechanic for a game that HIDES the odds until you
 *      have rolled. Advantage is the version you can price: 45% → 70%, on the card, before
 *      you spend anything. The decision gets better information, not less.
 *
 *   2. **A post-hoc reroll is a rewind wearing a hat.** Dice roll during resolution and are
 *      baked into the event, so undoing one means rewinding the turn and re-resolving it.
 *      That machinery exists, it is called rewind, and quietly building a second one that
 *      does the same thing under a nicer name would make the honest feature look like the
 *      cheat and the cheat look like a rule.
 *
 * The cost is real either way: you spend a finite resource, and advantage can still miss.
 */
export const SPEND_GRANTS = "advantage" as const;
