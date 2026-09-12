import type { Ability, Skill } from "../../schema/common.js";
import type { Feature } from "../../rules/features.js";

/**
 * A compact SRD 5.1 subset for character creation: four races, TEN classes and eight
 * backgrounds. Content here is Creative Commons (SRD 5.1, CC-BY-4.0); see
 * content/srd/LICENSE.md.
 *
 * Classes carry two lists. `features` is names, for the sheet and the DM prompt.
 * `mechanics` is the subset the engine actually implements, as declarative data — see
 * rules/features.ts. A feature with effect `narrative` is flavour and says so, which is
 * the honest way to ship a class whose signature trick is a whole system of its own.
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
  /** Level → features gained, as names. The sheet and the DM prompt read this. */
  features: Record<number, string[]>;
  /**
   * The same features, mechanically, for the ones the engine implements. See
   * rules/features.ts — anything not here is flavour, and is honest about being flavour.
   */
  mechanics?: Feature[];
  starting_items: string[];   // item_def ids
  /** Half-casters get slots at half rate; pact casters recharge on a SHORT rest. */
  caster: "full" | "half" | "pact" | "none";
}

export const CLASSES: Record<string, ClassDef> = {
  // ------------------------------------------------------------------ martial
  cls_fighter: {
    id: "cls_fighter", name: "Fighter", hit_die: 10, saves: ["str", "con"], caster: "none",
    skill_choices: ["acrobatics", "animal_handling", "athletics", "history", "insight", "intimidation", "perception", "survival"],
    skill_count: 2, weapons: ["simple", "martial"], spellcasting: null, slots: {},
    features: { 1: ["Fighting Style", "Second Wind"], 2: ["Action Surge"], 3: ["Martial Archetype"], 4: ["Ability Score Improvement"], 5: ["Extra Attack"] },
    mechanics: [
      {
        id: "second_wind", name: "Second Wind", level: 1, uses: 1, recharge: "short_rest",
        text: "A bonus action to catch your breath: regain 1d10 + your fighter level.",
        effect: { t: "heal_self", dice: "1d10", plus_level: true },
      },
      {
        id: "action_surge", name: "Action Surge", level: 2, uses: 1, recharge: "short_rest",
        text: "Push past your limit: take one additional action this turn.",
        effect: { t: "extra_action" },
      },
      {
        id: "fighter_extra_attack", name: "Extra Attack", level: 5, uses: "unlimited", recharge: "none",
        text: "You attack twice whenever you take the Attack action.",
        effect: { t: "extra_attack", attacks: 2 },
      },
    ],
    starting_items: ["item_def_longsword", "item_def_chain_shirt", "item_def_shield"],
  },

  cls_rogue: {
    id: "cls_rogue", name: "Rogue", hit_die: 8, saves: ["dex", "int"], caster: "none",
    skill_choices: ["acrobatics", "athletics", "deception", "insight", "intimidation", "investigation", "perception", "performance", "persuasion", "sleight_of_hand", "stealth"],
    skill_count: 4, weapons: ["simple", "shortsword"], spellcasting: null, slots: {},
    features: { 1: ["Expertise", "Sneak Attack", "Thieves' Cant"], 2: ["Cunning Action"], 3: ["Roguish Archetype"], 4: ["Ability Score Improvement"], 5: ["Uncanny Dodge"] },
    mechanics: [
      {
        id: "sneak_attack", name: "Sneak Attack", level: 1, uses: "unlimited", recharge: "turn",
        text: "Once a turn, add extra damage when you have advantage — or when an ally is beside your target and you do not have disadvantage. Finesse or ranged weapons only.",
        effect: { t: "sneak_damage", die: "d6" },
      },
      {
        id: "cunning_action", name: "Cunning Action", level: 2, uses: "unlimited", recharge: "none",
        text: "Dash, Disengage or Hide as a BONUS action, every turn.",
        effect: { t: "bonus_action_unlocks", actions: ["dash", "disengage", "hide"] },
      },
      {
        id: "uncanny_dodge", name: "Uncanny Dodge", level: 5, uses: "unlimited", recharge: "none",
        text: "Your reaction halves the damage of one attack you can see coming.",
        effect: { t: "halve_damage_reaction" },
      },
    ],
    starting_items: ["item_def_shortsword", "item_def_leather_armor"],
  },

  cls_barbarian: {
    id: "cls_barbarian", name: "Barbarian", hit_die: 12, saves: ["str", "con"], caster: "none",
    skill_choices: ["animal_handling", "athletics", "intimidation", "nature", "perception", "survival"],
    skill_count: 2, weapons: ["simple", "martial"], spellcasting: null, slots: {},
    features: { 1: ["Rage", "Unarmored Defense"], 2: ["Reckless Attack", "Danger Sense"], 3: ["Primal Path"], 4: ["Ability Score Improvement"], 5: ["Extra Attack", "Fast Movement"] },
    mechanics: [
      {
        id: "rage", name: "Rage", level: 1, uses: 2, recharge: "long_rest",
        text: "A bonus action. While raging you deal extra melee damage and take half from blades, arrows and clubs.",
        effect: { t: "rage", damage_bonus: 2, resists: ["slashing", "piercing", "bludgeoning"] },
      },
      {
        id: "barbarian_extra_attack", name: "Extra Attack", level: 5, uses: "unlimited", recharge: "none",
        text: "You attack twice whenever you take the Attack action.",
        effect: { t: "extra_attack", attacks: 2 },
      },
    ],
    starting_items: ["item_def_longsword", "item_def_leather_armor"],
  },

  // ------------------------------------------------------------- half-casters
  cls_paladin: {
    id: "cls_paladin", name: "Paladin", hit_die: 10, saves: ["wis", "cha"], caster: "half",
    skill_choices: ["athletics", "insight", "intimidation", "medicine", "persuasion", "religion"],
    skill_count: 2, weapons: ["simple", "martial"], spellcasting: "cha",
    slots: { 2: [2], 3: [3], 4: [3], 5: [4, 2], 6: [4, 2], 7: [4, 3], 8: [4, 3] },
    features: { 1: ["Divine Sense", "Lay on Hands"], 2: ["Fighting Style", "Spellcasting", "Divine Smite"], 3: ["Divine Health", "Sacred Oath"], 4: ["Ability Score Improvement"], 5: ["Extra Attack"], 6: ["Aura of Protection"] },
    mechanics: [
      {
        id: "lay_on_hands", name: "Lay on Hands", level: 1, uses: "unlimited", recharge: "long_rest",
        text: "A pool of healing worth five hit points per paladin level, spent a point at a time by touch.",
        effect: { t: "heal_pool", per_level: 5 },
      },
      {
        id: "divine_smite", name: "Divine Smite", level: 2, uses: "unlimited", recharge: "none",
        text: "When you hit, spend a spell slot to sear the target: 2d8 radiant, and another d8 for each slot level above the first.",
        effect: { t: "smite", base_dice: "2d8", per_extra_slot: "1d8", damage_type: "radiant" },
      },
      {
        id: "paladin_extra_attack", name: "Extra Attack", level: 5, uses: "unlimited", recharge: "none",
        text: "You attack twice whenever you take the Attack action.",
        effect: { t: "extra_attack", attacks: 2 },
      },
    ],
    starting_items: ["item_def_longsword", "item_def_chain_shirt", "item_def_shield"],
  },

  cls_ranger: {
    id: "cls_ranger", name: "Ranger", hit_die: 10, saves: ["str", "dex"], caster: "half",
    skill_choices: ["animal_handling", "athletics", "insight", "investigation", "nature", "perception", "stealth", "survival"],
    skill_count: 3, weapons: ["simple", "martial"], spellcasting: "wis",
    slots: { 2: [2], 3: [3], 4: [3], 5: [4, 2], 6: [4, 2], 7: [4, 3], 8: [4, 3] },
    features: { 1: ["Favored Enemy", "Natural Explorer"], 2: ["Fighting Style", "Spellcasting"], 3: ["Ranger Archetype", "Primeval Awareness"], 4: ["Ability Score Improvement"], 5: ["Extra Attack"] },
    mechanics: [
      {
        id: "natural_explorer", name: "Natural Explorer", level: 1, uses: "unlimited", recharge: "none",
        text: "In your favoured country you are never lost, and you notice things others walk past.",
        effect: { t: "narrative" },
      },
      {
        id: "ranger_extra_attack", name: "Extra Attack", level: 5, uses: "unlimited", recharge: "none",
        text: "You attack twice whenever you take the Attack action.",
        effect: { t: "extra_attack", attacks: 2 },
      },
    ],
    starting_items: ["item_def_shortsword", "item_def_leather_armor"],
  },

  // ------------------------------------------------------------- full casters
  cls_cleric: {
    id: "cls_cleric", name: "Cleric", hit_die: 8, saves: ["wis", "cha"], caster: "full",
    skill_choices: ["history", "insight", "medicine", "persuasion", "religion"],
    skill_count: 2, weapons: ["simple"], spellcasting: "wis",
    slots: { 1: [2], 2: [3], 3: [4, 2], 4: [4, 3], 5: [4, 3, 2], 6: [4, 3, 3], 7: [4, 3, 3], 8: [4, 3, 3] },
    features: { 1: ["Spellcasting", "Divine Domain"], 2: ["Channel Divinity"], 4: ["Ability Score Improvement"], 5: ["Destroy Undead"] },
    mechanics: [
      {
        id: "channel_divinity", name: "Channel Divinity", level: 2, uses: 1, recharge: "short_rest",
        text: "Call directly on your god. Undead that can see you must flee.",
        effect: { t: "narrative" },
      },
    ],
    starting_items: ["item_def_mace", "item_def_chain_shirt", "item_def_shield"],
  },

  cls_wizard: {
    id: "cls_wizard", name: "Wizard", hit_die: 6, saves: ["int", "wis"], caster: "full",
    skill_choices: ["arcana", "history", "insight", "investigation", "medicine", "religion"],
    skill_count: 2, weapons: ["dagger", "quarterstaff"], spellcasting: "int",
    slots: { 1: [2], 2: [3], 3: [4, 2], 4: [4, 3], 5: [4, 3, 2], 6: [4, 3, 3], 7: [4, 3, 3], 8: [4, 3, 3] },
    features: { 1: ["Spellcasting", "Arcane Recovery"], 2: ["Arcane Tradition"], 4: ["Ability Score Improvement"] },
    mechanics: [
      {
        id: "arcane_recovery", name: "Arcane Recovery", level: 1, uses: 1, recharge: "long_rest",
        text: "Once a day, a short rest gives back spell slots worth half your wizard level, rounded up.",
        effect: { t: "recover_slots", levels_per_use: "half_level" },
      },
    ],
    starting_items: ["item_def_quarterstaff", "item_def_dagger"],
  },

  cls_druid: {
    id: "cls_druid", name: "Druid", hit_die: 8, saves: ["int", "wis"], caster: "full",
    skill_choices: ["arcana", "animal_handling", "insight", "medicine", "nature", "perception", "religion", "survival"],
    skill_count: 2, weapons: ["quarterstaff", "dagger"], spellcasting: "wis",
    slots: { 1: [2], 2: [3], 3: [4, 2], 4: [4, 3], 5: [4, 3, 2], 6: [4, 3, 3], 7: [4, 3, 3], 8: [4, 3, 3] },
    features: { 1: ["Druidic", "Spellcasting"], 2: ["Wild Shape", "Druid Circle"], 4: ["Ability Score Improvement", "Wild Shape Improvement"] },
    mechanics: [
      {
        id: "wild_shape", name: "Wild Shape", level: 2, uses: 2, recharge: "short_rest",
        text: "Take the shape of a beast you have seen. NOT YET MECHANICAL — see SPEC: becoming a different stat block is its own system.",
        effect: { t: "narrative" },
      },
    ],
    starting_items: ["item_def_quarterstaff", "item_def_leather_armor"],
  },

  cls_bard: {
    id: "cls_bard", name: "Bard", hit_die: 8, saves: ["dex", "cha"], caster: "full",
    skill_choices: ["acrobatics", "arcana", "deception", "history", "insight", "intimidation", "investigation", "nature", "perception", "performance", "persuasion", "religion", "sleight_of_hand", "stealth", "survival"],
    skill_count: 3, weapons: ["simple", "shortsword"], spellcasting: "cha",
    slots: { 1: [2], 2: [3], 3: [4, 2], 4: [4, 3], 5: [4, 3, 2], 6: [4, 3, 3], 7: [4, 3, 3], 8: [4, 3, 3] },
    features: { 1: ["Spellcasting", "Bardic Inspiration"], 2: ["Jack of All Trades", "Song of Rest"], 3: ["Bard College", "Expertise"], 4: ["Ability Score Improvement"] },
    mechanics: [
      {
        id: "bardic_inspiration", name: "Bardic Inspiration", level: 1, uses: "prof", recharge: "long_rest",
        text: "A bonus action gives an ally a d6 they can add to one roll, whenever they choose to.",
        effect: { t: "inspiration_die", die: "1d6" },
      },
      {
        id: "jack_of_all_trades", name: "Jack of All Trades", level: 2, uses: "unlimited", recharge: "none",
        text: "Half your proficiency bonus on every check you are not already proficient in.",
        effect: { t: "half_proficiency" },
      },
    ],
    starting_items: ["item_def_shortsword", "item_def_leather_armor"],
  },

  cls_warlock: {
    id: "cls_warlock", name: "Warlock", hit_die: 8, saves: ["wis", "cha"], caster: "pact",
    skill_choices: ["arcana", "deception", "history", "intimidation", "investigation", "nature", "religion"],
    skill_count: 2, weapons: ["simple"], spellcasting: "cha",
    // Pact magic: FEW slots, all at the highest level you can cast, and they come back on a
    // SHORT rest. That last part is the whole class identity, and it is why `caster` exists.
    slots: { 1: [1], 2: [2], 3: [0, 2], 4: [0, 2], 5: [0, 0, 2], 6: [0, 0, 2], 7: [0, 0, 2], 8: [0, 0, 2] },
    features: { 1: ["Otherworldly Patron", "Pact Magic"], 2: ["Eldritch Invocations"], 3: ["Pact Boon"], 4: ["Ability Score Improvement"] },
    mechanics: [
      {
        id: "pact_magic", name: "Pact Magic", level: 1, uses: "unlimited", recharge: "none",
        text: "Few slots, always at your highest level — and they return on a SHORT rest, not a long one.",
        effect: { t: "narrative" },
      },
    ],
    starting_items: ["item_def_dagger", "item_def_leather_armor"],
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
  bg_noble: {
    id: "bg_noble", name: "Noble", skills: ["history", "persuasion"], tools: [], gold: 25,
    personality: { traits: ["waits to be offered a chair"], ideal: "Rank is a debt owed downward.", bond: "A house name that is not theirs to spend.", flaw: "Has never once been told no and believed it." },
  },
  bg_outlander: {
    id: "bg_outlander", name: "Outlander", skills: ["athletics", "survival"], tools: [], gold: 10,
    personality: { traits: ["sleeps badly indoors"], ideal: "The wild does not lie to you.", bond: "A stretch of country they would die defending.", flaw: "Says the true thing at the worst moment." },
  },
  bg_soldier: {
    id: "bg_soldier", name: "Soldier", skills: ["athletics", "intimidation"], tools: [], gold: 10,
    personality: { traits: ["counts the exits and the people in a room, in that order"], ideal: "You do not leave anyone behind.", bond: "The ones who did not come back.", flaw: "Cannot take an order and cannot quite give one up." },
  },
  bg_urchin: {
    id: "bg_urchin", name: "Urchin", skills: ["sleight_of_hand", "stealth"], tools: ["thieves_tools"], gold: 10,
    personality: { traits: ["eats like it might be taken away"], ideal: "Nobody is coming to help. Act accordingly.", bond: "The others from the same alley.", flaw: "Cannot accept a gift without looking for the hook." },
  },
};

/** The standard array, 5e's simplest honest method. */
export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8] as const;

/** Point buy: 27 points, scores 8–15 before racial bonuses. */
export const POINT_BUY_COST: Record<number, number> = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
export const POINT_BUY_BUDGET = 27;
