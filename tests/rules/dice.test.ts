import { describe, expect, it } from "vitest";
import { parseDice, rollD20, rollDamage } from "../../src/rules/dice.js";
import { Rng, seedToState } from "../../src/rules/rng.js";

const rng = () => new Rng(seedToState("dice-test"));

describe("dice notation", () => {
  it("parses counts, sides and flat modifiers", () => {
    expect(parseDice("1d8")).toEqual({ count: 1, sides: 8, flat: 0 });
    expect(parseDice("2d6+3")).toEqual({ count: 2, sides: 6, flat: 3 });
    expect(parseDice("d20")).toEqual({ count: 1, sides: 20, flat: 0 });
    expect(parseDice("4d4 - 1")).toEqual({ count: 4, sides: 4, flat: -1 });
  });

  it("refuses nonsense rather than guessing", () => {
    expect(() => parseDice("bell")).toThrow();
    expect(() => parseDice("0d6")).toThrow();
  });
});

describe("the PRNG", () => {
  it("is deterministic from a seed", () => {
    const a = new Rng(seedToState("same"));
    const b = new Rng(seedToState("same"));
    const rollsA = Array.from({ length: 20 }, () => a.int(1, 20));
    const rollsB = Array.from({ length: 20 }, () => b.int(1, 20));
    expect(rollsA).toEqual(rollsB);
  });

  it("gives different streams for different seeds", () => {
    const a = new Rng(seedToState("one"));
    const b = new Rng(seedToState("two"));
    const rollsA = Array.from({ length: 20 }, () => a.int(1, 20));
    const rollsB = Array.from({ length: 20 }, () => b.int(1, 20));
    expect(rollsA).not.toEqual(rollsB);
  });

  it("stays inside its bounds over many draws", () => {
    const r = rng();
    for (let i = 0; i < 5000; i++) {
      const v = r.int(1, 20);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(20);
    }
  });

  it("covers the whole d20 range", () => {
    const r = rng();
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(r.int(1, 20));
    expect(seen.size).toBe(20);
  });
});

describe("d20 tests follow 5e", () => {
  it("auto-hits on a natural 20 and auto-misses on a natural 1 for ATTACKS", () => {
    // Drive the generator to a known natural roll by searching the stream.
    const r = new Rng(seedToState("crit-hunt"));
    let sawCrit = false;
    let sawFumble = false;
    for (let i = 0; i < 400 && !(sawCrit && sawFumble); i++) {
      const roll = rollD20(r, { purpose: "attack", mods: -50, target: 99, isAttack: true });
      if (roll.raw === 20) { expect(roll.success).toBe(true); expect(roll.critical).toBe(true); sawCrit = true; }
      if (roll.raw === 1) { expect(roll.success).toBe(false); expect(roll.fumble).toBe(true); sawFumble = true; }
    }
    expect(sawCrit && sawFumble).toBe(true);
  });

  it("does NOT auto-succeed on a natural 20 for ability checks", () => {
    const r = new Rng(seedToState("check-hunt"));
    let checked = false;
    for (let i = 0; i < 400 && !checked; i++) {
      const roll = rollD20(r, { purpose: "stealth", mods: 0, target: 30, isAttack: false });
      if (roll.raw === 20) {
        expect(roll.success).toBe(false);   // 20 + 0 = 20, still short of DC 30
        expect(roll.critical).toBe(false);
        checked = true;
      }
    }
    expect(checked).toBe(true);
  });

  it("takes the higher die with advantage and the lower with disadvantage", () => {
    const r1 = new Rng(seedToState("adv"));
    for (let i = 0; i < 50; i++) {
      const roll = rollD20(r1, { purpose: "x", mods: 0, target: 10, advantage: "advantage" });
      expect(roll.raw).toBe(Math.max(roll.raw, roll.raw_second!));
    }
    const r2 = new Rng(seedToState("dis"));
    for (let i = 0; i < 50; i++) {
      const roll = rollD20(r2, { purpose: "x", mods: 0, target: 10, advantage: "disadvantage" });
      expect(roll.raw).toBe(Math.min(roll.raw, roll.raw_second!));
    }
  });
});

describe("damage", () => {
  it("doubles the dice on a crit but not the flat modifier", () => {
    // 1d6+0 with a +3 bonus: normal is 1..6 +3; crit is 2..12 +3.
    const normal = new Rng(seedToState("dmg"));
    const crit = new Rng(seedToState("dmg"));
    for (let i = 0; i < 200; i++) {
      const n = rollDamage(normal, "1d6", 3, false);
      expect(n.total).toBeGreaterThanOrEqual(4);
      expect(n.total).toBeLessThanOrEqual(9);
    }
    for (let i = 0; i < 200; i++) {
      const c = rollDamage(crit, "1d6", 3, true);
      expect(c.total).toBeGreaterThanOrEqual(5);
      expect(c.total).toBeLessThanOrEqual(15);
    }
  });

  it("never deals negative damage", () => {
    const r = rng();
    const roll = rollDamage(r, "1d4", -20, false);
    expect(roll.total).toBe(0);
  });
});
