import type { Entity } from "../schema/entity.js";

/**
 * The SRD condition list, with what each one actually DOES. Today only four had any
 * mechanics; a condition with no rule attached is a word in a status bar.
 *
 * Every flag here is read by the resolver or the affordance engine, so the reason a check
 * has disadvantage or an action is greyed traces back to one line in this table.
 */
export interface ConditionRule {
  /** Shown on first encounter. */
  teach: string;
  /** This creature cannot take actions or reactions. */
  incapacitated?: boolean;
  /** This creature cannot move between zones. */
  immobile?: boolean;
  /** Attack rolls BY this creature have disadvantage. */
  own_attacks_disadv?: boolean;
  /** Ability checks by this creature have disadvantage. */
  checks_disadv?: boolean;
  /** Attack rolls AGAINST this creature have advantage. */
  attacks_against_adv?: boolean;
  /** Attack rolls AGAINST this creature have disadvantage. */
  attacks_against_disadv?: boolean;
  /** Automatically fails Strength and Dexterity saving throws. */
  auto_fail_str_dex_saves?: boolean;
  /** Melee attacks against this creature that hit are critical hits. */
  melee_hits_crit?: boolean;
  /** Cannot see: attacks against have advantage, own attacks have disadvantage. */
  blinded?: boolean;
}

export const CONDITIONS: Record<string, ConditionRule> = {
  blinded: { teach: "Blinded: you can't see. Your attacks have disadvantage; attacks against you have advantage.", blinded: true, own_attacks_disadv: true, attacks_against_adv: true },
  charmed: { teach: "Charmed: you can't attack the charmer, and they have advantage on social checks against you." },
  deafened: { teach: "Deafened: you can't hear. Checks that need hearing fail automatically." },
  frightened: { teach: "Frightened: disadvantage on checks and attacks while the source of your fear is in sight, and you can't move closer to it.", own_attacks_disadv: true, checks_disadv: true },
  grappled: { teach: "Grappled: your speed is 0. Escape with an Athletics or Acrobatics check.", immobile: true },
  incapacitated: { teach: "Incapacitated: you can't take actions or reactions.", incapacitated: true },
  invisible: { teach: "Invisible: attacks against you have disadvantage; your attacks have advantage.", attacks_against_disadv: true },
  paralyzed: { teach: "Paralysed: you can't move or act, you fail Strength and Dexterity saves, and any melee hit on you is a critical.", incapacitated: true, immobile: true, auto_fail_str_dex_saves: true, attacks_against_adv: true, melee_hits_crit: true },
  petrified: { teach: "Petrified: turned to stone. Incapacitated, immobile, and resistant to all damage.", incapacitated: true, immobile: true, auto_fail_str_dex_saves: true, attacks_against_adv: true },
  poisoned: { teach: "Poisoned: disadvantage on attack rolls and ability checks.", own_attacks_disadv: true, checks_disadv: true },
  prone: { teach: "Prone: melee attacks against you have advantage, ranged ones have disadvantage. Standing up costs half your movement.", attacks_against_adv: true, own_attacks_disadv: true },
  restrained: { teach: "Restrained: speed 0, attacks against you have advantage, yours have disadvantage, and Dexterity saves have disadvantage.", immobile: true, attacks_against_adv: true, own_attacks_disadv: true },
  stunned: { teach: "Stunned: incapacitated, can't move, fail Strength and Dexterity saves, attacks against you have advantage.", incapacitated: true, immobile: true, auto_fail_str_dex_saves: true, attacks_against_adv: true },
  unconscious: { teach: "Unconscious: incapacitated, prone, unaware. Attacks against you have advantage and melee hits are criticals.", incapacitated: true, immobile: true, auto_fail_str_dex_saves: true, attacks_against_adv: true, melee_hits_crit: true },
  exhaustion_1: { teach: "Exhaustion 1: disadvantage on ability checks.", checks_disadv: true },
  exhaustion_2: { teach: "Exhaustion 2: speed halved.", checks_disadv: true },
  exhaustion_3: { teach: "Exhaustion 3: disadvantage on attacks and saves.", checks_disadv: true, own_attacks_disadv: true },
  exhaustion_4: { teach: "Exhaustion 4: hit point maximum halved.", checks_disadv: true, own_attacks_disadv: true },
  exhaustion_5: { teach: "Exhaustion 5: speed 0.", checks_disadv: true, own_attacks_disadv: true, immobile: true },
  exhaustion_6: { teach: "Exhaustion 6: death.", incapacitated: true, immobile: true },
};

export function has(e: Entity, id: string): boolean {
  return e.conditions.some((c) => c.id === id);
}

/** Fold every active condition into one set of flags. */
export function conditionFlags(e: Entity): ConditionRule {
  const out: ConditionRule = { teach: "" };
  for (const c of e.conditions) {
    const rule = CONDITIONS[c.id];
    if (!rule) continue;
    for (const [k, v] of Object.entries(rule)) {
      if (k === "teach") continue;
      if (v === true) (out as unknown as Record<string, unknown>)[k] = true;
    }
  }
  return out;
}

export function canAct(e: Entity): boolean {
  return e.alive && e.hp.current > 0 && !conditionFlags(e).incapacitated;
}

export function canMove(e: Entity): boolean {
  return canAct(e) && !conditionFlags(e).immobile;
}
