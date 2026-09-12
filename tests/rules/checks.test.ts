import { describe, expect, it } from "vitest";
import { Entity } from "../../src/schema/entity.js";
import {
  abilityMod, DC_BY_BAND, dcForBand, passiveSkill, saveModifier, skillModifier,
} from "../../src/rules/checks.js";
import {
  dispositionDcShift, dispositionOf, priceMultiplierPct, willComplyFromFear, willShareSecrets,
  willEngage,
} from "../../src/rules/social.js";
import { combineModifiers, lightModifier } from "../../src/rules/modifiers.js";
import { Location } from "../../src/schema/location.js";

const rogue = Entity.parse({
  id: "pc_test", kind: "pc", name: "Test", location_id: "loc_x",
  abilities: { str: 10, dex: 16, con: 12, int: 14, wis: 12, cha: 8 },
  level: 2, hp: { current: 17, max: 17 }, ac: 14, proficiency_bonus: 2,
  proficiencies: { skills: ["stealth", "perception"], saves: ["dex"] },
  expertise: ["stealth"],
  resources: { hit_dice: { max: 2, used: 0 } },
});

describe("ability modifiers", () => {
  it("follows floor((score - 10) / 2), including below 10", () => {
    expect(abilityMod(1)).toBe(-5);
    expect(abilityMod(8)).toBe(-1);
    expect(abilityMod(9)).toBe(-1);
    expect(abilityMod(10)).toBe(0);
    expect(abilityMod(11)).toBe(0);
    expect(abilityMod(16)).toBe(3);
    expect(abilityMod(20)).toBe(5);
  });
});

describe("skill and save modifiers", () => {
  it("adds proficiency once, and expertise twice", () => {
    expect(skillModifier(rogue, "perception")).toBe(1 + 2);      // wis +1, proficient
    expect(skillModifier(rogue, "stealth")).toBe(3 + 4);         // dex +3, expertise
    expect(skillModifier(rogue, "athletics")).toBe(0);           // str +0, not proficient
  });

  it("adds proficiency to proficient saves only", () => {
    expect(saveModifier(rogue, "dex")).toBe(3 + 2);
    expect(saveModifier(rogue, "cha")).toBe(-1);
  });

  it("computes passive scores as 10 + modifier", () => {
    expect(passiveSkill(rogue, "perception")).toBe(13);
  });
});

describe("the band → DC table", () => {
  it("is the only thing that turns a band into a number", () => {
    expect(dcForBand("trivial")).toBe(5);
    expect(dcForBand("easy")).toBe(10);
    expect(dcForBand("medium")).toBe(15);
    expect(dcForBand("hard")).toBe(20);
    expect(dcForBand("very_hard")).toBe(25);
    expect(dcForBand("near_impossible")).toBe(30);
    expect(Object.keys(DC_BY_BAND)).toHaveLength(6);
  });
});

describe("disposition", () => {
  it("labels the affinity scale in order", () => {
    expect(dispositionOf(-90)).toBe("hostile");
    expect(dispositionOf(-40)).toBe("cold");
    expect(dispositionOf(-15)).toBe("wary");
    expect(dispositionOf(0)).toBe("neutral");
    expect(dispositionOf(20)).toBe("warming");
    expect(dispositionOf(50)).toBe("friendly");
    expect(dispositionOf(80)).toBe("devoted");
  });

  it("caps the social DC shift at ±3 so affinity colours a check, never decides it", () => {
    expect(dispositionDcShift(100)).toBe(-3);
    expect(dispositionDcShift(-100)).toBe(3);
    expect(dispositionDcShift(0)).toBe(0);
    expect(dispositionDcShift(40)).toBe(-2);
  });

  it("gates secrets on trust regardless of the roll", () => {
    const rel = (trust: number, fear = 0) =>
      ({ subject: "a", object: "b", dims: { affinity: 0, trust, fear, respect: 0 }, opinion: "", tags: [], history: [] });
    // A secret has to be EARNED, not merely un-forbidden. Someone who does not distrust
    // you is still a stranger, and the old rule had innkeepers confessing to anyone.
    expect(willShareSecrets(rel(-31))).toBe(false);
    expect(willShareSecrets(rel(-29))).toBe(false);
    expect(willShareSecrets(rel(0))).toBe(false);
    expect(willShareSecrets(rel(24))).toBe(false);
    expect(willShareSecrets(rel(25))).toBe(true);
    expect(willShareSecrets(undefined)).toBe(false);

    // Engaging at all is a much lower bar than confiding.
    expect(willEngage(rel(-31))).toBe(false);
    expect(willEngage(rel(0))).toBe(true);
    expect(willComplyFromFear(rel(0, 51))).toBe(true);
    expect(willComplyFromFear(rel(0, 50))).toBe(false);
  });

  it("prices goods by affinity in whole percent", () => {
    const rel = (affinity: number) =>
      ({ subject: "a", object: "b", dims: { affinity, trust: 0, fear: 0, respect: 0 }, opinion: "", tags: [], history: [] });
    expect(priceMultiplierPct(rel(70))).toBe(90);
    expect(priceMultiplierPct(rel(0))).toBe(100);
    expect(priceMultiplierPct(rel(-70))).toBe(130);
  });
});

describe("situational modifiers", () => {
  const dark = Location.parse({
    id: "loc_dark", name: "Dark", short_desc: "d", ambient: { light: "dark" },
  });

  it("helps stealth and hurts perception in the dark", () => {
    expect(lightModifier("stealth", dark)!.dc_delta).toBe(-5);
    const perc = lightModifier("perception", dark)!;
    expect(perc.dc_delta).toBe(5);
    expect(perc.advantage).toBe("disadvantage");
  });

  it("cancels advantage against disadvantage rather than stacking", () => {
    expect(combineModifiers([
      { source: "a", reason: "", dc_delta: 0, advantage: "advantage" },
      { source: "b", reason: "", dc_delta: 0, advantage: "advantage" },
      { source: "c", reason: "", dc_delta: 0, advantage: "disadvantage" },
    ]).advantage).toBe("none");

    expect(combineModifiers([
      { source: "a", reason: "", dc_delta: 2, advantage: "advantage" },
      { source: "b", reason: "", dc_delta: -5, advantage: "none" },
    ])).toEqual({ dc_delta: -3, advantage: "advantage" });
  });
});
