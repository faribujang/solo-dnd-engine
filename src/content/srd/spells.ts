import type { Ability } from "../../schema/common.js";

/**
 * The spell subset. Cantrips plus levels 1–3, chosen for coverage of the three resolution
 * paths — attack roll, saving throw, no roll — rather than completeness. Anything outside
 * this list is refused honestly by the intent parser: "that spell isn't in this game yet"
 * beats a silent approximation. SRD 5.1, CC-BY-4.0.
 */
export interface SpellDef {
  id: string;
  name: string;
  level: number;                       // 0 = cantrip
  classes: string[];                   // class ids that know it
  cost: "action" | "bonus" | "reaction";
  /** Zone reach. `self` | `touch` (same zone) | `near` (same or adjacent) | `far` (any zone). */
  range: "self" | "touch" | "near" | "far";
  resolution:
    | { kind: "attack"; damage: string; type: string }
    | { kind: "save"; ability: Ability; damage?: string; type?: string; half_on_save?: boolean; condition?: string; condition_rounds?: number }
    | { kind: "auto"; damage?: string; type?: string; heal?: string; buff?: string };
  /** Hits every enemy in the target zone rather than one creature. */
  area: boolean;
  concentration: boolean;
  ritual: boolean;
  teach: string;
}

export const SPELLS: Record<string, SpellDef> = {
  spell_fire_bolt: {
    id: "spell_fire_bolt", name: "Fire Bolt", level: 0, classes: ["cls_wizard"], cost: "action", range: "far",
    resolution: { kind: "attack", damage: "1d10", type: "fire" }, area: false, concentration: false, ritual: false,
    teach: "A spell attack is d20 + your spellcasting modifier + proficiency against Armour Class, like a weapon.",
  },
  spell_sacred_flame: {
    id: "spell_sacred_flame", name: "Sacred Flame", level: 0, classes: ["cls_cleric"], cost: "action", range: "far",
    resolution: { kind: "save", ability: "dex", damage: "1d8", type: "radiant" }, area: false, concentration: false, ritual: false,
    teach: "A saving-throw spell has no attack roll. The TARGET rolls d20 + their save against your spell DC, and takes the effect on a failure.",
  },
  spell_magic_missile: {
    id: "spell_magic_missile", name: "Magic Missile", level: 1, classes: ["cls_wizard"], cost: "action", range: "far",
    resolution: { kind: "auto", damage: "3d4+3", type: "force" }, area: false, concentration: false, ritual: false,
    teach: "Some spells simply happen. Magic Missile never misses and allows no save.",
  },
  spell_burning_hands: {
    id: "spell_burning_hands", name: "Burning Hands", level: 1, classes: ["cls_wizard"], cost: "action", range: "near",
    resolution: { kind: "save", ability: "dex", damage: "3d6", type: "fire", half_on_save: true }, area: true, concentration: false, ritual: false,
    teach: "An area spell hits everyone in the zone. A successful save usually halves the damage rather than avoiding it.",
  },
  spell_thunderwave: {
    id: "spell_thunderwave", name: "Thunderwave", level: 1, classes: ["cls_wizard"], cost: "action", range: "touch",
    resolution: { kind: "save", ability: "con", damage: "2d8", type: "thunder", half_on_save: true }, area: true, concentration: false, ritual: false,
    teach: "Thunderwave bursts out from you, so it hits everything in your own zone — friends included.",
  },
  spell_cure_wounds: {
    id: "spell_cure_wounds", name: "Cure Wounds", level: 1, classes: ["cls_cleric"], cost: "action", range: "touch",
    resolution: { kind: "auto", heal: "1d8" }, area: false, concentration: false, ritual: false,
    teach: "Healing adds your spellcasting modifier. Touch means the same zone.",
  },
  spell_healing_word: {
    id: "spell_healing_word", name: "Healing Word", level: 1, classes: ["cls_cleric"], cost: "bonus", range: "far",
    resolution: { kind: "auto", heal: "1d4" }, area: false, concentration: false, ritual: false,
    teach: "A bonus-action spell leaves your action free. Healing Word heals less than Cure Wounds but from anywhere, and you can still attack.",
  },
  spell_guiding_bolt: {
    id: "spell_guiding_bolt", name: "Guiding Bolt", level: 1, classes: ["cls_cleric"], cost: "action", range: "far",
    resolution: { kind: "attack", damage: "4d6", type: "radiant" }, area: false, concentration: false, ritual: false,
    teach: "Guiding Bolt lights the target up: the next attack against them has advantage.",
  },
  spell_bless: {
    id: "spell_bless", name: "Bless", level: 1, classes: ["cls_cleric"], cost: "action", range: "near",
    resolution: { kind: "auto", buff: "blessed" }, area: false, concentration: true, ritual: false,
    teach: "Concentration: you can hold one such spell at a time. Taking damage forces a Constitution save (DC 10 or half the damage) to keep it.",
  },
  spell_hold_person: {
    id: "spell_hold_person", name: "Hold Person", level: 2, classes: ["cls_cleric", "cls_wizard"], cost: "action", range: "far",
    resolution: { kind: "save", ability: "wis", condition: "paralyzed", condition_rounds: 3 }, area: false, concentration: true, ritual: false,
    teach: "Paralysed creatures fail Strength and Dexterity saves and every melee hit on them is a critical. This is why casters are scary.",
  },
  spell_scorching_ray: {
    id: "spell_scorching_ray", name: "Scorching Ray", level: 2, classes: ["cls_wizard"], cost: "action", range: "far",
    resolution: { kind: "attack", damage: "2d6", type: "fire" }, area: false, concentration: false, ritual: false,
    teach: "Higher-level slots buy bigger effects. A 2nd-level slot is a different resource from a 1st.",
  },
  spell_fireball: {
    id: "spell_fireball", name: "Fireball", level: 3, classes: ["cls_wizard"], cost: "action", range: "far",
    resolution: { kind: "save", ability: "dex", damage: "8d6", type: "fire", half_on_save: true }, area: true, concentration: false, ritual: false,
    teach: "The 3rd-level slot. Fireball hits a whole zone for 8d6. Mind where your friends are standing.",
  },
};

export function spellsFor(classId: string | null, level: number): SpellDef[] {
  if (!classId) return [];
  const maxLevel = Math.min(3, Math.ceil(level / 2));   // 1→1, 2→1, 3→2, 4→2, 5→3
  return Object.values(SPELLS).filter((sp) => sp.classes.includes(classId) && sp.level <= maxLevel);
}

/** Spell save DC and spell attack bonus, per 5e. */
export function spellDC(profBonus: number, castingMod: number): number {
  return 8 + profBonus + castingMod;
}
