import type { Ability, Skill } from "../../schema/common.js";

/**
 * A compact SRD 5.1 subset for character creation. Four races, four classes, four
 * backgrounds — enough to make a real character and prove the flow. Content here is
 * Creative Commons (SRD 5.1, CC-BY-4.0); see content/srd/LICENSE.md.
 */

export interface RaceDef {
  id: string;
  name: string;
  ability_bonus: Partial<Record<Ability, number>>;
  speed: number;
  traits: string[];
  darkvision: boolean;
}

export const RACES: Record<string, RaceDef> = {
  race_human: {
    id: "race_human", name: "Human",
    ability_bonus: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 },
    speed: 30, traits: ["Versatile"], darkvision: false,
  },
  race_elf: {
    id: "race_elf", name: "Elf",
    ability_bonus: { dex: 2 },
    speed: 30, traits: ["Darkvision", "Keen Senses", "Fey Ancestry", "Trance"], darkvision: true,
  },
  race_dwarf: {
    id: "race_dwarf", name: "Dwarf",
    ability_bonus: { con: 2 },
    speed: 25, traits: ["Darkvision", "Dwarven Resilience", "Stonecunning"], darkvision: true,
  },
  race_halfling: {
    id: "race_halfling", name: "Halfling",
    ability_bonus: { dex: 2 },
    speed: 25, traits: ["Lucky", "Brave", "Halfling Nimbleness"], darkvision: false,
  },
};

export interface ClassDef {
  id: string;
  name: string;
  hit_die: number;
  saves: Ability[];
  skill_choices: Skill[];
  skill_count: number;
  weapons: string[];
  spellcasting: Ability | null;
  /** Level → 1st..3rd slot counts, for casters. */
  slots: Record<number, number[]>;
  /** Level → features gained. Descriptive; mechanics attach where the engine supports them. */
  features: Record<number, string[]>;
  starting_items: string[];   // item_def ids
}

export const CLASSES: Record<string, ClassDef> = {
  cls_fighter: {
    id: "cls_fighter", name: "Fighter", hit_die: 10, saves: ["str", "con"],
    skill_choices: ["acrobatics", "animal_handling", "athletics", "history", "insight", "intimidation", "perception", "survival"],
    skill_count: 2, weapons: ["simple", "martial"], spellcasting: null, slots: {},
    features: { 1: ["Fighting Style", "Second Wind"], 2: ["Action Surge"], 3: ["Martial Archetype"], 4: ["Ability Score Improvement"], 5: ["Extra Attack"] },
    starting_items: ["item_def_longsword", "item_def_chain_shirt", "item_def_shield"],
  },
  cls_rogue: {
    id: "cls_rogue", name: "Rogue", hit_die: 8, saves: ["dex", "int"],
    skill_choices: ["acrobatics", "athletics", "deception", "insight", "intimidation", "investigation", "perception", "performance", "persuasion", "sleight_of_hand", "stealth"],
    skill_count: 4, weapons: ["simple", "shortsword"], spellcasting: null, slots: {},
    features: { 1: ["Expertise", "Sneak Attack", "Thieves' Cant"], 2: ["Cunning Action"], 3: ["Roguish Archetype"], 4: ["Ability Score Improvement"], 5: ["Uncanny Dodge"] },
    starting_items: ["item_def_shortsword", "item_def_leather_armor"],
  },
  cls_cleric: {
    id: "cls_cleric", name: "Cleric", hit_die: 8, saves: ["wis", "cha"],
    skill_choices: ["history", "insight", "medicine", "persuasion", "religion"],
    skill_count: 2, weapons: ["simple"], spellcasting: "wis",
    slots: { 1: [2], 2: [3], 3: [4, 2], 4: [4, 3], 5: [4, 3, 2], 6: [4, 3, 3], 7: [4, 3, 3], 8: [4, 3, 3] },
    features: { 1: ["Spellcasting", "Divine Domain"], 2: ["Channel Divinity"], 4: ["Ability Score Improvement"], 5: ["Destroy Undead"] },
    starting_items: ["item_def_mace", "item_def_chain_shirt", "item_def_shield"],
  },
  cls_wizard: {
    id: "cls_wizard", name: "Wizard", hit_die: 6, saves: ["int", "wis"],
    skill_choices: ["arcana", "history", "insight", "investigation", "medicine", "religion"],
    skill_count: 2, weapons: ["dagger", "quarterstaff"], spellcasting: "int",
    slots: { 1: [2], 2: [3], 3: [4, 2], 4: [4, 3], 5: [4, 3, 2], 6: [4, 3, 3], 7: [4, 3, 3], 8: [4, 3, 3] },
    features: { 1: ["Spellcasting", "Arcane Recovery"], 2: ["Arcane Tradition"], 4: ["Ability Score Improvement"] },
    starting_items: ["item_def_quarterstaff"],
  },
};

export interface BackgroundDef {
  id: string;
  name: string;
  skills: Skill[];
  tools: string[];
  gold: number;
  personality: { traits: string[]; ideal: string; bond: string; flaw: string };
}

export const BACKGROUNDS: Record<string, BackgroundDef> = {
  bg_acolyte: {
    id: "bg_acolyte", name: "Acolyte", skills: ["insight", "religion"], tools: [], gold: 15,
    personality: { traits: ["quotes scripture at the wrong moment"], ideal: "Faith is a debt paid forward.", bond: "Owes a temple a life.", flaw: "Trusts anyone in vestments." },
  },
  bg_criminal: {
    id: "bg_criminal", name: "Criminal", skills: ["deception", "stealth"], tools: ["thieves_tools"], gold: 15,
    personality: { traits: ["always knows where the exits are"], ideal: "Chains are for those who get caught.", bond: "Someone took the fall for them once.", flaw: "Cannot leave a locked thing locked." },
  },
  bg_folk_hero: {
    id: "bg_folk_hero", name: "Folk Hero", skills: ["animal_handling", "survival"], tools: ["smiths_tools"], gold: 10,
    personality: { traits: ["judges people by their hands"], ideal: "The powerful should answer to the small.", bond: "Their village still expects them home.", flaw: "Cannot refuse a plea." },
  },
  bg_sage: {
    id: "bg_sage", name: "Sage", skills: ["arcana", "history"], tools: [], gold: 10,
    personality: { traits: ["answers a question with a better question"], ideal: "What is written cannot be argued away.", bond: "One book, still unfinished.", flaw: "Would trade almost anyone for a primary source." },
  },
};

/** The standard array, 5e's simplest honest method. */
export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8] as const;

/** Point buy: 27 points, scores 8–15 before racial bonuses. */
export const POINT_BUY_COST: Record<number, number> = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
export const POINT_BUY_BUDGET = 27;
