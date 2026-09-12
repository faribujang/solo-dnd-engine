import { z } from "zod";
import type { Entity } from "../schema/entity.js";
import type { GameState } from "../schema/state.js";
import { CLASSES } from "../content/srd/data.js";

/**
 * CLASS FEATURES, AS MECHANICS RATHER THAN LABELS.
 *
 * Until now a class feature was a string in an array: `features: { 1: ["Second Wind"] }`.
 * That is enough to print on a character sheet and enough to fool a reader of this repo
 * into thinking fighters could catch their breath. They could not. The engine supported two
 * classes and neither one's signature ability did anything.
 *
 * The fix follows the same shape as the trigger DSL, for the same reason: **a closed tagged
 * union of mechanical shapes, evaluated by code, authored as data.** A new class is then a
 * data entry rather than a new branch in the combat resolver, which is what makes ten
 * classes tractable at all.
 *
 * The union is deliberately small. Every entry earns its place by being mechanically
 * distinct — not "Rage and Divine Smite are both damage" but "one is a persistent stance
 * with resistance, the other spends a slot on a hit". Anything whose mechanics do not fit
 * is marked `narrative` and says so out loud, rather than being quietly half-implemented.
 */

export const Recharge = z.enum(["short_rest", "long_rest", "turn", "none"]);
export type Recharge = z.infer<typeof Recharge>;

/**
 * What a feature actually does. Each shape is handled in exactly one place in the engine,
 * named in its comment, so there is never a question of where a feature is implemented.
 */
export const FeatureEffect = z.discriminatedUnion("t", [
  /** Heal yourself. Fighter's Second Wind. Handled in engine/turn.ts `use_feature`. */
  z.object({ t: z.literal("heal_self"), dice: z.string(), plus_level: z.boolean().default(true) }),

  /** A pool of healing spent a point at a time. Paladin's Lay on Hands. */
  z.object({ t: z.literal("heal_pool"), per_level: z.number().int().positive() }),

  /** One extra action this turn. Fighter's Action Surge. */
  z.object({ t: z.literal("extra_action") }),

  /** These actions become available as a BONUS action. Rogue's Cunning Action. */
  z.object({ t: z.literal("bonus_action_unlocks"), actions: z.array(z.string()) }),

  /** Conditional extra damage dice. Rogue's Sneak Attack. Handled in combatActions.ts. */
  z.object({ t: z.literal("sneak_damage"), die: z.string().default("d6") }),

  /** Spend a spell slot on a hit for extra damage. Paladin's Divine Smite. */
  z.object({ t: z.literal("smite"), base_dice: z.string(), per_extra_slot: z.string(), damage_type: z.string() }),

  /** A stance: damage bonus and resistance while it lasts. Barbarian's Rage. */
  z.object({
    t: z.literal("rage"),
    damage_bonus: z.number().int(),
    resists: z.array(z.string()),
  }),

  /** Half proficiency on checks you are NOT proficient in. Bard's Jack of All Trades. */
  z.object({ t: z.literal("half_proficiency") }),

  /** Hand an ally a die they can add to a roll. Bard's Bardic Inspiration. */
  z.object({ t: z.literal("inspiration_die"), die: z.string() }),

  /** Attack more than once with the Attack action. */
  z.object({ t: z.literal("extra_attack"), attacks: z.number().int().min(2) }),

  /** Halve incoming damage as a reaction. Rogue's Uncanny Dodge. */
  z.object({ t: z.literal("halve_damage_reaction") }),

  /** Regain spell slots on a short rest. Wizard's Arcane Recovery. */
  z.object({ t: z.literal("recover_slots"), levels_per_use: z.string() }),

  /**
   * Real, and real in the fiction, but with no mechanical handler. It reaches the DM in the
   * prompt and the player on their sheet, and it changes no number.
   *
   * This is the honest half of the system. A feature listed here is NOT secretly working —
   * it is documented as flavour, and anything that ought to be mechanical and is not will
   * be found here rather than discovered missing from a combat log.
   */
  z.object({ t: z.literal("narrative") }),
]);
export type FeatureEffect = z.infer<typeof FeatureEffect>;

export const Feature = z.object({
  id: z.string(),
  name: z.string(),
  level: z.number().int().min(1).max(20),
  /** Rules text, in the player's terms. Shown on the sheet and in a first-use tooltip. */
  text: z.string(),
  effect: FeatureEffect,
  /** How many times before it needs a rest. `prof` scales with proficiency bonus. */
  uses: z.union([z.number().int().positive(), z.literal("prof"), z.literal("unlimited")]).default("unlimited"),
  recharge: Recharge.default("none"),
});
export type Feature = z.infer<typeof Feature>;

/** Every feature this character has unlocked at their current level. */
export function featuresOf(e: Entity): Feature[] {
  if (!e.class_id) return [];
  const cls = CLASSES[e.class_id];
  if (!cls) return [];
  return (cls.mechanics ?? []).filter((f) => f.level <= e.level);
}

export function featureById(e: Entity, id: string): Feature | undefined {
  return featuresOf(e).find((f) => f.id === id);
}

/** Does this character have a feature with this mechanical shape? */
export function featureOfKind<K extends FeatureEffect["t"]>(
  e: Entity,
  kind: K,
): (Feature & { effect: Extract<FeatureEffect, { t: K }> }) | undefined {
  return featuresOf(e).find((f) => f.effect.t === kind) as never;
}

/** How many times this feature may be used before its recharge. */
export function usesOf(e: Entity, f: Feature): number {
  if (f.uses === "unlimited") return Infinity;
  if (f.uses === "prof") return e.proficiency_bonus;
  return f.uses;
}

/** How many are left right now. Spent counts live in flags, keyed by feature id. */
export function usesLeft(e: Entity, f: Feature): number {
  const spent = e.flags[`feat_used_${f.id}`];
  return usesOf(e, f) - (typeof spent === "number" ? spent : 0);
}

export function canUse(e: Entity, f: Feature): boolean {
  return usesLeft(e, f) > 0;
}

/**
 * SNEAK ATTACK, and why it is the fiddliest feature in the book.
 *
 * RAW needs three things at once: a finesse or ranged weapon, once per turn, and either
 * advantage OR an ally of yours beside the target while you do not have disadvantage.
 *
 * That second clause is the one that gets implemented wrong, because the obvious reading —
 * "you have advantage" — is only half of it, and the half that gets dropped is the half
 * that makes rogues want a friend in the fight. In zone-based combat "beside the target"
 * means an ally of yours in the target's zone.
 */
export function sneakAttackApplies(
  s: GameState,
  attacker: Entity,
  target: Entity,
  opts: { advantage: boolean; disadvantage: boolean; finesseOrRanged: boolean },
): boolean {
  if (!featureOfKind(attacker, "sneak_damage")) return false;
  if (!opts.finesseOrRanged) return false;
  // Once per turn, not once per attack. The flag is cleared when their turn begins.
  if (attacker.flags["sneak_used_this_turn"] === true) return false;

  if (opts.advantage) return true;
  if (opts.disadvantage) return false;

  return Object.values(s.entities).some(
    (a) =>
      a.id !== attacker.id &&
      a.alive &&
      a.id !== target.id &&
      a.location_id === target.location_id &&
      a.zone_id === target.zone_id &&
      isAllyOf(s, a, attacker),
  );
}

/** Party members and the player count as each other's allies. Everyone else does not. */
function isAllyOf(s: GameState, who: Entity, of: Entity): boolean {
  const party = new Set([s.meta.pc_id, ...s.meta.party_ids]);
  return party.has(who.id) && party.has(of.id);
}

/** Sneak Attack scales one die per two rogue levels, rounded up. */
export function sneakDice(level: number): number {
  return Math.max(1, Math.ceil(level / 2));
}

/** Rage, Second Wind and the rest come back on a rest. Called from the rest resolver. */
export function rechargeFeatures(e: Entity, kind: "short" | "long"): void {
  for (const f of featuresOf(e)) {
    if (f.recharge === "none") continue;
    if (f.recharge === "long_rest" && kind !== "long") continue;
    delete e.flags[`feat_used_${f.id}`];
  }
}
