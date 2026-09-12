import type { Ability, Skill } from "../schema/common.js";
import type { Entity } from "../schema/entity.js";
import { Entity as EntitySchema } from "../schema/entity.js";
import { abilityMod } from "./checks.js";
import { averageHp, proficiencyForLevel } from "./progression.js";
import { BACKGROUNDS, CLASSES, POINT_BUY_BUDGET, POINT_BUY_COST, RACES, STANDARD_ARRAY } from "../content/srd/data.js";
import type { Rng } from "./rng.js";

/**
 * Character creation, as a pure function. The guided flow in the client collects a
 * `CharacterChoices`; this turns it into a valid level-1 Entity or explains why it can't.
 */

export type ScoreMethod =
  | { method: "standard"; assignment: Record<Ability, number> }   // each of 15/14/13/12/10/8 once
  | { method: "point_buy"; scores: Record<Ability, number> }      // 27 points, 8–15
  | { method: "rolled"; scores: Record<Ability, number> };        // 4d6 drop lowest, via rollScores()

export interface CharacterChoices {
  id: string;
  name: string;
  pronouns: string;
  race_id: string;
  class_id: string;
  background_id: string;
  scores: ScoreMethod;
  skills: Skill[];                 // from the class's list, class.skill_count of them
  alignment: Entity["alignment"];
  location_id: string;
}

export type CreateResult = { ok: true; entity: Entity } | { ok: false; problems: string[] };

const ABILITIES: Ability[] = ["str", "dex", "con", "int", "wis", "cha"];

export function createCharacter(c: CharacterChoices): CreateResult {
  const problems: string[] = [];
  const race = RACES[c.race_id];
  const cls = CLASSES[c.class_id];
  const bg = BACKGROUNDS[c.background_id];
  if (!race) problems.push(`unknown race ${c.race_id}`);
  if (!cls) problems.push(`unknown class ${c.class_id}`);
  if (!bg) problems.push(`unknown background ${c.background_id}`);
  if (!c.name.trim()) problems.push("a character needs a name");
  if (problems.length || !race || !cls || !bg) return { ok: false, problems };

  // ---- ability scores
  let base: Record<Ability, number>;
  if (c.scores.method === "standard") {
    base = c.scores.assignment;
    const used = ABILITIES.map((a) => base[a]).sort((x, y) => y - x);
    if (used.join() !== [...STANDARD_ARRAY].join()) problems.push("standard array must use 15, 14, 13, 12, 10, 8 exactly once each");
  } else if (c.scores.method === "point_buy") {
    base = c.scores.scores;
    let spent = 0;
    for (const a of ABILITIES) {
      const v = base[a];
      if (POINT_BUY_COST[v] === undefined) { problems.push(`${a} ${v} is outside 8–15`); continue; }
      spent += POINT_BUY_COST[v]!;
    }
    if (spent > POINT_BUY_BUDGET) problems.push(`point buy spends ${spent} of ${POINT_BUY_BUDGET}`);
  } else {
    base = c.scores.scores;
    for (const a of ABILITIES) if (base[a] < 3 || base[a] > 18) problems.push(`rolled ${a} ${base[a]} is outside 3–18`);
  }

  // ---- skills
  if (c.skills.length !== cls.skill_count) problems.push(`${cls.name} picks ${cls.skill_count} skills, got ${c.skills.length}`);
  for (const sk of c.skills) if (!cls.skill_choices.includes(sk)) problems.push(`${cls.name} cannot take ${sk}`);
  if (new Set(c.skills).size !== c.skills.length) problems.push("duplicate skill choice");

  if (problems.length) return { ok: false, problems };

  const abilities = { ...base };
  for (const a of ABILITIES) abilities[a] = Math.min(20, abilities[a] + (race.ability_bonus[a] ?? 0));

  const conMod = abilityMod(abilities.con);
  const maxHp = Math.max(1, cls.hit_die + conMod);
  const level = 1;
  const slots: Record<string, { max: number; used: number }> = {};
  for (const [i, n] of (cls.slots[level] ?? []).entries()) slots[String(i + 1)] = { max: n, used: 0 };

  const entity = EntitySchema.parse({
    id: c.id,
    kind: "pc",
    name: c.name.trim(),
    pronouns: c.pronouns,
    alignment: c.alignment,
    controller: "human",
    descriptor: `a level-1 ${race.name.toLowerCase()} ${cls.name.toLowerCase()}`,
    location_id: c.location_id,
    abilities,
    level,
    class_id: cls.id,
    race_id: race.id,
    hp: { current: maxHp, max: maxHp, temp: 0 },
    ac: 10 + abilityMod(abilities.dex),   // refreshed by rules/equipment.ts once gear is on
    speed: race.speed,
    proficiency_bonus: proficiencyForLevel(level),
    proficiencies: {
      skills: [...new Set([...c.skills, ...bg.skills])],
      saves: cls.saves,
      weapons: cls.weapons,
      tools: bg.tools,
    },
    resources: { spell_slots: slots, hit_dice: { max: level, used: 0 } },
    personality: { ...bg.personality, voice: "" },
    flags: { background_id: bg.id, starting_gold: bg.gold, features: cls.features[1] ?? [], racial_traits: race.traits },
  });

  return { ok: true, entity };
}

/** 4d6-drop-lowest, through the seeded generator so the roll is journaled, not re-rolled. */
export function rollScores(rng: Rng): Record<Ability, number> {
  const out = {} as Record<Ability, number>;
  for (const a of ABILITIES) {
    const dice = [rng.int(1, 6), rng.int(1, 6), rng.int(1, 6), rng.int(1, 6)].sort((x, y) => y - x);
    out[a] = dice[0]! + dice[1]! + dice[2]!;
  }
  return out;
}

/**
 * What levelling from `from` to `from+1` grants. Pure; the `level_up` effect applies it.
 * Returns the HP gain (average, or rolled if a die result is supplied), new proficiency,
 * new slots, and the feature names.
 */
export function levelUpPlan(e: Entity, rolledHitDie?: number): {
  hp_gain: number; proficiency: number; slots: Record<string, number>; features: string[]; asi: boolean;
} {
  const cls = e.class_id ? CLASSES[e.class_id] : undefined;
  const die = cls?.hit_die ?? 8;
  const next = e.level + 1;
  const hpGain = Math.max(1, (rolledHitDie ?? averageHp(die)) + abilityMod(e.abilities.con));
  const slots: Record<string, number> = {};
  for (const [i, n] of (cls?.slots[next] ?? []).entries()) slots[String(i + 1)] = n;
  const features = cls?.features[next] ?? [];
  return { hp_gain: hpGain, proficiency: proficiencyForLevel(next), slots, features, asi: features.includes("Ability Score Improvement") };
}
