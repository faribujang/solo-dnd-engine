import type { Ability, Degree, DifficultyBand, Skill } from "../schema/common.js";
import type { Entity } from "../schema/entity.js";
import { featureOfKind } from "./features.js";

/**
 * The band → DC table. The intent parser proposes a BAND; only this table turns it into a
 * number. The LLM never sets a DC.
 */
export const DC_BY_BAND: Record<DifficultyBand, number> = {
  trivial: 5,
  easy: 10,
  medium: 15,
  hard: 20,
  very_hard: 25,
  near_impossible: 30,
};

export function dcForBand(band: DifficultyBand, shift = 0): number {
  return Math.max(1, DC_BY_BAND[band] + shift);
}

/** SRD 5.1 skill → governing ability. */
export const SKILL_ABILITY: Record<Skill, Ability> = {
  acrobatics: "dex",
  animal_handling: "wis",
  arcana: "int",
  athletics: "str",
  deception: "cha",
  history: "int",
  insight: "wis",
  intimidation: "cha",
  investigation: "int",
  medicine: "wis",
  nature: "int",
  perception: "wis",
  performance: "cha",
  persuasion: "cha",
  religion: "int",
  sleight_of_hand: "dex",
  stealth: "dex",
  survival: "wis",
};

/** The 5e ability modifier: floor((score - 10) / 2). */
export function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function abilityModOf(e: Entity, ability: Ability): number {
  return abilityMod(e.abilities[ability]);
}

/** Ability mod + proficiency (doubled with expertise) for a skill check. */
/**
 * JACK OF ALL TRADES. Half proficiency, rounded down, on every check you are NOT already
 * proficient in — which is the bard's whole identity as the party's second-best everything.
 */
export function jackBonus(e: Entity, skill: Skill): number {
  if (e.proficiencies.skills.includes(skill)) return 0;
  return featureOfKind(e, "half_proficiency") ? Math.floor(e.proficiency_bonus / 2) : 0;
}

export function skillModifier(e: Entity, skill: Skill): number {
  return skillParts(e, skill).reduce((n, p) => n + p.value, 0);
}

/**
 * The same number, itemised. This is what the roll card renders, and it is why a player
 * can see that their +7 Stealth is dex and expertise rather than a figure the game made up.
 */
export function skillParts(e: Entity, skill: Skill): Array<{ label: string; value: number }> {
  const ability = SKILL_ABILITY[skill];
  const out: Array<{ label: string; value: number }> = [{ label: ability, value: abilityModOf(e, ability) }];
  if (e.expertise.includes(skill)) out.push({ label: "expertise", value: e.proficiency_bonus * 2 });
  else if (e.proficiencies.skills.includes(skill)) out.push({ label: "proficiency", value: e.proficiency_bonus });
  else {
    // Jack of All Trades reaches the roll card as its own named part, so a bard can see
    // where their surprising +2 in a skill nobody taught them came from.
    const jack = jackBonus(e, skill);
    if (jack > 0) out.push({ label: "jack of all trades", value: jack });
  }
  return out.filter((p) => p.value !== 0);
}

/** Ability mod + proficiency if proficient in that save. */
export function saveModifier(e: Entity, ability: Ability): number {
  let mod = abilityModOf(e, ability);
  if (e.proficiencies.saves.includes(ability)) mod += e.proficiency_bonus;
  return mod;
}

/** Passive score, used for noticing things without a roll. */
export function passiveSkill(e: Entity, skill: Skill): number {
  return 10 + skillModifier(e, skill);
}

/** How far above or below the DC counts as which band. */
export const CRIT_MARGIN = 5;
export const COST_MARGIN = 4;

/** Bands in order, worst to best. Upgrading and downgrading walk this array. */
export const DEGREE_ORDER: readonly Degree[] = [
  "failure", "success_at_cost", "success", "critical_success",
];

/**
 * Grade a check into the four things that can happen to you.
 *
 *   miss by 5 or more   FAILURE            it did not work, and the situation got worse
 *   miss by 1–4         SUCCESS AT A COST  you got it, and something went wrong
 *   meet it, up to +4   SUCCESS            clean
 *   beat it by 5+       CRITICAL           more than you asked for
 *
 * The near-miss band is deliberately WIDE — four points, not two. It is where most rolls
 * land and where the interesting outcomes live, and a game whose middle band is a sliver
 * is really a pass/fail game wearing four labels. `ironman` narrows it to nothing.
 *
 * **A natural 20 upgrades one band, and a natural 1 downgrades one.** This is not RAW —
 * 5e grants neither on an ability check — and it is a deliberate deviation. A d20 should
 * never be dead: rolling a 20 against a wall you cannot climb still gets you the best
 * outcome available, which may be "you get up there, and you are stuck" rather than "no".
 * It cannot manufacture a clean success out of a hopeless total, because it moves ONE step.
 */
export function degreeOf(
  total: number,
  dc: number,
  opts: { natural?: number; costMargin?: number } = {},
): Degree {
  const cost = opts.costMargin ?? COST_MARGIN;

  let band: Degree;
  if (total >= dc + CRIT_MARGIN) band = "critical_success";
  else if (total >= dc) band = "success";
  else if (total >= dc - cost) band = "success_at_cost";
  else band = "failure";

  if (opts.natural === 20) return shiftDegree(band, +1);
  if (opts.natural === 1) return shiftDegree(band, -1);
  return band;
}

/** Move a band up or down, clamped at the ends. */
export function shiftDegree(d: Degree, steps: number): Degree {
  const i = DEGREE_ORDER.indexOf(d);
  return DEGREE_ORDER[Math.max(0, Math.min(DEGREE_ORDER.length - 1, i + steps))]!;
}

/** Short label for the mechanics line and the roll card. */
export const DEGREE_LABEL: Record<Degree, string> = {
  critical_success: "CRITICAL SUCCESS",
  success: "SUCCESS",
  success_at_cost: "SUCCESS AT A COST",
  failure: "FAILURE",
};

/** What the narrator is obliged to do with each band. Lives in the system prompt. */
export const DEGREE_BRIEF: Record<Degree, string> = {
  critical_success: "SUCCESS, and better than they hoped — give them something extra.",
  success: "SUCCESS. Straightforward.",
  success_at_cost: "SUCCESS AT A COST — they get what they wanted AND something goes wrong: a noise, a broken tool, lost time, someone notices. Narrate both halves.",
  failure: "FAILURE, and not a near thing — they missed by a wide margin. It must still CHANGE the situation, never stall it: the lock holds and the pick snaps, the guard is not fooled and now he is watching. Never answer with 'nothing happens'.",
};

/** Initiative modifier. */
export function initiativeModifier(e: Entity): number {
  return abilityModOf(e, "dex");
}
