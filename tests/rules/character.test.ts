import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { createCharacter, levelUpPlan, rollScores } from "../../src/rules/character.js";
import { computeAC } from "../../src/rules/equipment.js";
import { levelForXp, XP_THRESHOLDS } from "../../src/rules/progression.js";
import { reduce } from "../../src/engine/reduce.js";
import { takeTurn } from "../../src/engine/session.js";
import { rewind } from "../../src/engine/rollback.js";
import { Rng, seedToState } from "../../src/rules/rng.js";
import { rootEvent, tinyWorld } from "../helpers/world.js";
import type { GameState } from "../../src/schema/state.js";

const CAMPAIGN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../content/campaign/drowned_bell");

const standard = { method: "standard" as const, assignment: { str: 8, dex: 15, con: 13, int: 12, wis: 10, cha: 14 } };

describe("character creation", () => {
  it("builds a valid level-1 character from the standard array", () => {
    const r = createCharacter({
      id: "pc_new", name: "Ilse Varr", pronouns: "she/her", race_id: "race_elf", class_id: "cls_rogue",
      background_id: "bg_criminal", scores: standard, skills: ["stealth", "deception", "acrobatics", "insight"],
      alignment: "chaotic_neutral", location_id: "loc_flagon",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entity.abilities.dex).toBe(17);       // 15 + 2 elf
    expect(r.entity.hp.max).toBe(8 + 1);           // d8 + con 13 → +1
    expect(r.entity.proficiencies.skills).toContain("stealth");
    expect(r.entity.proficiencies.skills).toContain("deception");   // from background too, deduped
    expect(r.entity.proficiencies.saves).toEqual(["dex", "int"]);
    expect(r.entity.controller).toBe("human");
  });

  it("refuses a standard array used wrongly", () => {
    const r = createCharacter({
      id: "pc_x", name: "X", pronouns: "they/them", race_id: "race_human", class_id: "cls_fighter",
      background_id: "bg_folk_hero", scores: { method: "standard", assignment: { str: 15, dex: 15, con: 15, int: 8, wis: 8, cha: 8 } },
      skills: ["athletics", "perception"], alignment: null, location_id: "loc_flagon",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.join()).toMatch(/exactly once/);
  });

  it("enforces the point-buy budget", () => {
    const r = createCharacter({
      id: "pc_x", name: "X", pronouns: "he/him", race_id: "race_dwarf", class_id: "cls_cleric",
      background_id: "bg_acolyte", scores: { method: "point_buy", scores: { str: 15, dex: 15, con: 15, int: 15, wis: 15, cha: 15 } },
      skills: ["medicine", "religion"], alignment: "lawful_good", location_id: "loc_flagon",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.join()).toMatch(/spends 54 of 27/);
  });

  it("gives casters their level-1 slots", () => {
    const r = createCharacter({
      id: "pc_w", name: "W", pronouns: "they/them", race_id: "race_human", class_id: "cls_wizard",
      background_id: "bg_sage", scores: standard, skills: ["arcana", "investigation"], alignment: null, location_id: "loc_flagon",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entity.resources.spell_slots["1"]).toEqual({ max: 2, used: 0 });
  });

  it("rolls scores through the seeded generator, so a roll is a roll and not a reroll", () => {
    const a = rollScores(new Rng(seedToState("x")));
    const b = rollScores(new Rng(seedToState("x")));
    expect(a).toEqual(b);
    for (const v of Object.values(a)) { expect(v).toBeGreaterThanOrEqual(3); expect(v).toBeLessThanOrEqual(18); }
  });
});

describe("armour class is computed, not stored", () => {
  it("explains itself: leather 11 + dex 3 = 14", async () => {
    const s = await loadCampaign(CAMPAIGN);
    const ac = computeAC(s, s.entities["pc_main"]!);
    expect(ac.total).toBe(14);
    expect(ac.parts.map((p) => p.label)).toEqual(["leather armor", "dex"]);
  });

  it("caps dex under medium armour and adds a shield", async () => {
    const s = await loadCampaign(CAMPAIGN);
    const out1 = reduce(s, rootEvent("effect", [
      { t: "give_item", entity_id: "pc_main", item_def_id: "item_def_chain_shirt", qty: 1  },
      { t: "give_item", entity_id: "pc_main", item_def_id: "item_def_shield", qty: 1  },
    ], { actor_id: "pc_main", location_id: "loc_flagon" })).state;
    const shirt = Object.values(out1.items).find((i) => i.def_id === "item_def_chain_shirt")!;
    const shield = Object.values(out1.items).find((i) => i.def_id === "item_def_shield")!;
    const out2 = reduce(out1, rootEvent("effect", [
      { t: "equip", entity_id: "pc_main", instance_id: shirt.id, slot: "armor" },
      { t: "equip", entity_id: "pc_main", instance_id: shield.id, slot: "off_hand" },
    ], { id: "evt_r0002", turn: 2, actor_id: "pc_main", location_id: "loc_flagon" })).state;
    const ac = computeAC(out2, out2.entities["pc_main"]!);
    expect(ac.total).toBe(13 + 2 + 2);   // chain 13, dex capped at 2, shield 2
    expect(out2.entities["pc_main"]!.ac).toBe(17);   // and the cache was refreshed
  });
});

describe("progression", () => {
  it("maps XP to level on the SRD table", () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(299)).toBe(1);
    expect(levelForXp(300)).toBe(2);
    expect(levelForXp(900)).toBe(3);
    expect(levelForXp(XP_THRESHOLDS[7]!)).toBe(8);
    expect(levelForXp(999999)).toBe(8);   // campaign cap
  });

  it("grants XP, flags readiness, and levels up on confirmation", () => {
    let s: GameState = tinyWorld();
    s.entities["pc_a"]!.class_id = "cls_fighter";
    s = reduce(s, rootEvent("effect", [{ t: "grant_xp", entity_ids: ["pc_a"], amount: 350, reason: "test" }])).state;
    expect(s.entities["pc_a"]!.xp).toBe(350);
    expect(s.entities["pc_a"]!.flags["level_up_ready"]).toBe(true);
    expect(s.entities["pc_a"]!.level).toBe(1);   // not yet — player confirms

    const plan = levelUpPlan(s.entities["pc_a"]!);
    expect(plan.hp_gain).toBe(6);   // d10 average 6 + con 10 → +0
    expect(plan.features).toContain("Action Surge");

    s = reduce(s, rootEvent("effect", [{ t: "level_up", entity_id: "pc_a", hp_gain: plan.hp_gain }], { id: "evt_r0002", turn: 2 })).state;
    expect(s.entities["pc_a"]!.level).toBe(2);
    expect(s.entities["pc_a"]!.hp.max).toBe(26);
    expect(s.entities["pc_a"]!.flags["level_up_ready"]).toBeUndefined();
  });

  it("refuses a level_up that was not earned", () => {
    let s: GameState = tinyWorld();
    s = reduce(s, rootEvent("effect", [{ t: "level_up", entity_id: "pc_a", hp_gain: 5 }])).state;
    expect(s.entities["pc_a"]!.level).toBe(1);
  });
});

describe("death saves", () => {
  it("drops a character to 0 HP unconscious, not dead", () => {
    const s = reduce(tinyWorld(), rootEvent("attack", [{ t: "damage", entity_id: "pc_a", amount: 20, damage_type: "slashing" }])).state;
    const pc = s.entities["pc_a"]!;
    expect(pc.alive).toBe(true);
    expect(pc.hp.current).toBe(0);
    expect(pc.conditions.map((c) => c.id)).toContain("unconscious");
  });

  it("kills outright on massive damage", () => {
    const s = reduce(tinyWorld(), rootEvent("attack", [{ t: "damage", entity_id: "pc_a", amount: 45, damage_type: "slashing" }])).state;
    expect(s.entities["pc_a"]!.alive).toBe(false);
  });

  it("still kills an NPC at 0 — only characters get death saves", () => {
    const s = reduce(tinyWorld(), rootEvent("attack", [{ t: "damage", entity_id: "npc_b", amount: 8, damage_type: "slashing" }])).state;
    expect(s.entities["npc_b"]!.alive).toBe(false);
  });

  it("three failures is death; three successes is stable; a 20 is up with 1 HP", () => {
    const down = reduce(tinyWorld(), rootEvent("attack", [{ t: "damage", entity_id: "pc_a", amount: 20, damage_type: "x" }])).state;

    let s = down;
    for (let i = 0; i < 3; i++) s = reduce(s, rootEvent("death_save", [{ t: "death_save", entity_id: "pc_a", outcome: "failure" }], { id: `evt_r000${i + 2}`, turn: i + 2 })).state;
    expect(s.entities["pc_a"]!.alive).toBe(false);

    s = down;
    for (let i = 0; i < 3; i++) s = reduce(s, rootEvent("death_save", [{ t: "death_save", entity_id: "pc_a", outcome: "success" }], { id: `evt_r000${i + 2}`, turn: i + 2 })).state;
    expect(s.entities["pc_a"]!.alive).toBe(true);
    expect(s.entities["pc_a"]!.stable).toBe(true);

    s = reduce(down, rootEvent("death_save", [{ t: "death_save", entity_id: "pc_a", outcome: "crit_success" }], { id: "evt_r0002", turn: 2 })).state;
    expect(s.entities["pc_a"]!.hp.current).toBe(1);
    expect(s.entities["pc_a"]!.conditions).toHaveLength(0);
  });

  it("damage while down counts as a failed save; healing wakes you", () => {
    const down = reduce(tinyWorld(), rootEvent("attack", [{ t: "damage", entity_id: "pc_a", amount: 20, damage_type: "x" }])).state;
    const hit = reduce(down, rootEvent("attack", [{ t: "damage", entity_id: "pc_a", amount: 1, damage_type: "x" }], { id: "evt_r0002", turn: 2 })).state;
    expect(hit.entities["pc_a"]!.death_saves.failures).toBe(1);
    const healed = reduce(hit, rootEvent("effect", [{ t: "heal", entity_id: "pc_a", amount: 5 }], { id: "evt_r0003", turn: 3 })).state;
    expect(healed.entities["pc_a"]!.hp.current).toBe(5);
    expect(healed.entities["pc_a"]!.conditions).toHaveLength(0);
    expect(healed.entities["pc_a"]!.death_saves.failures).toBe(0);
  });

  it("a downed player can only roll a death save, and it is journaled and rewindable", async () => {
    let s = await loadCampaign(CAMPAIGN);
    s = reduce(s, rootEvent("attack", [{ t: "damage", entity_id: "pc_main", amount: 17, damage_type: "x" }], { actor_id: "mon_bonepicker", location_id: "loc_flagon" })).state;
    expect(takeTurn(s, { type: "look" }).ok).toBe(false);

    const save = takeTurn(s, { type: "death_save" });
    expect(save.ok).toBe(true);
    expect(save.journal[0]!.type).toBe("death_save");
    expect(save.journal[0]!.rolls[0]!.purpose).toBe("death_save");

    // Rewind is the honest way out of a bad fight, and it is exact.
    const initial = await loadCampaign(CAMPAIGN);
    const back = rewind(initial, save.journal, 0);
    expect(back.state.entities["pc_main"]!.hp.current).toBe(17);
  });
});
