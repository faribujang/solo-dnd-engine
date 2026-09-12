import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { takeTurn } from "../../src/engine/session.js";
import { affordances } from "../../src/rules/affordances.js";
import { CLASSES } from "../../src/content/srd/data.js";
import { Feature, featuresOf, featureOfKind, sneakDice, usesLeft } from "../../src/rules/features.js";
import { skillParts, jackBonus } from "../../src/rules/checks.js";
import type { GameState } from "../../src/schema/state.js";
import type { Entity } from "../../src/schema/entity.js";
import { reduce } from "../../src/engine/reduce.js";
import { rootEvent } from "../helpers/world.js";

const CAMPAIGN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../content/campaign/drowned_bell");
const load = async (): Promise<GameState> => {
  const s = structuredClone(await loadCampaign(CAMPAIGN));
  s.meta.session_zero.dice = "committed";
  return s;
};

/** Rebuild the player as a given class at a given level, keeping them where they stand. */
function asClass(s: GameState, classId: string, level: number): Entity {
  const pc = s.entities["pc_main"]!;
  pc.class_id = classId;
  pc.level = level;
  pc.proficiency_bonus = level < 5 ? 2 : 3;
  pc.hp.max = 60;
  pc.hp.current = 60;
  return pc;
}

describe("the class catalogue", () => {
  it("declares every feature it lists as mechanical, and validates", () => {
    for (const [id, cls] of Object.entries(CLASSES)) {
      for (const f of cls.mechanics ?? []) {
        const parsed = Feature.safeParse(f);
        expect(parsed.success, `${id}/${f.id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      }
    }
  });

  it("covers the ten classes, with hit dice that are not all the same", () => {
    expect(Object.keys(CLASSES)).toHaveLength(10);
    const dice = new Set(Object.values(CLASSES).map((c) => c.hit_die));
    expect(dice.size).toBeGreaterThan(2);
    // The warlock's identity is short-rest slots, so the flag has to survive the data.
    expect(CLASSES["cls_warlock"]!.caster).toBe("pact");
    expect(CLASSES["cls_paladin"]!.caster).toBe("half");
  });

  it("only unlocks a feature once its level is reached", async () => {
    const s = await load();
    const pc = asClass(s, "cls_fighter", 1);
    expect(featuresOf(pc).map((f) => f.id)).toContain("second_wind");
    expect(featuresOf(pc).map((f) => f.id)).not.toContain("action_surge");

    pc.level = 5;
    expect(featuresOf(pc).map((f) => f.id)).toContain("fighter_extra_attack");
  });
});

describe("second wind", () => {
  it("heals, spends the use, and comes back on a short rest", async () => {
    let s = await load();
    const pc = asClass(s, "cls_fighter", 3);
    pc.hp.current = 20;

    const out = takeTurn(s, { type: "use_feature", feature_id: "second_wind" });
    expect(out.ok).toBe(true);
    s = out.state;
    expect(s.entities["pc_main"]!.hp.current).toBeGreaterThan(20);

    // Once per short rest. The second attempt is refused with the reason, not silently.
    const again = takeTurn(s, { type: "use_feature", feature_id: "second_wind" });
    expect(again.ok).toBe(false);
    expect(again.message).toMatch(/spent|short rest/i);

    s = takeTurn(s, { type: "rest", kind: "short" }).state;
    expect(usesLeft(s.entities["pc_main"]!, featuresOf(s.entities["pc_main"]!)[0]!)).toBe(1);
  });

  it("refuses a feature the character does not have", async () => {
    const s = await load();
    asClass(s, "cls_wizard", 3);
    const out = takeTurn(s, { type: "use_feature", feature_id: "second_wind" });
    expect(out.ok).toBe(false);
    expect(out.journal).toHaveLength(0);
  });

  it("will not offer a passive as a button", async () => {
    const s = await load();
    asClass(s, "cls_rogue", 3);
    // Sneak Attack is not a verb. Putting it on the bar teaches the player to hunt for a
    // button that does not exist.
    const bar = affordances(s).filter((a) => a.group === "feature").map((a) => a.label);
    expect(bar).not.toContain("Sneak Attack");
    expect(takeTurn(s, { type: "use_feature", feature_id: "sneak_attack" }).ok).toBe(false);
  });
});

describe("sneak attack", () => {
  it("scales one die per two levels, rounded up", () => {
    expect(sneakDice(1)).toBe(1);
    expect(sneakDice(2)).toBe(1);
    expect(sneakDice(3)).toBe(2);
    expect(sneakDice(8)).toBe(4);
  });

  it("fires when an ally is beside the target, and only once a turn", async () => {
    let s = await load();
    const pc = asClass(s, "cls_rogue", 5);
    const foe = s.entities["mon_bonepicker"]!;
    foe.location_id = pc.location_id;
    foe.hp.max = 200; foe.hp.current = 200;

    // BESIDE the target means in their zone. Getting this wrong is exactly the bug the
    // feature is written to avoid, so the test sets it up explicitly.
    foe.zone_id = pc.zone_id;
    const ally = s.entities["cmp_sela"]!;
    ally.location_id = pc.location_id;
    ally.zone_id = pc.zone_id;
    if (!s.meta.party_ids.includes(ally.id)) s.meta.party_ids.push(ally.id);

    // Swing until one lands — sneak rides a hit, so a miss proves nothing either way.
    let fired = false;
    for (let i = 0; i < 25 && !fired; i++) {
      const out = takeTurn(s, { type: "attack", target_id: "mon_bonepicker" });
      if (out.ok) {
        s = out.state;
        fired = s.entities["pc_main"]!.flags["sneak_used_this_turn"] === true;
      }
      const end = takeTurn(s, { type: "end_turn" });
      if (end.ok) s = end.state; else break;
    }
    expect(fired).toBe(true);
  });

  it("does not fire alone, with no advantage and nobody beside them", async () => {
    const s = await load();
    const pc = asClass(s, "cls_rogue", 5);
    const foe = s.entities["mon_bonepicker"]!;
    foe.location_id = pc.location_id;
    foe.hp.max = 200; foe.hp.current = 200;
    // Everyone else is elsewhere.
    for (const e of Object.values(s.entities)) {
      if (e.id !== "pc_main" && e.id !== "mon_bonepicker") e.location_id = "loc_bell_gate";
    }
    s.meta.party_ids = ["pc_main"];

    const out = takeTurn(s, { type: "attack", target_id: "mon_bonepicker" });
    expect(out.state.entities["pc_main"]!.flags["sneak_used_this_turn"]).toBeUndefined();
  });
});

describe("cunning action", () => {
  it("puts Dash on the bonus pip for a rogue and the action pip for everyone else", async () => {
    const s = await load();
    asClass(s, "cls_rogue", 3);
    s.entities["mon_bonepicker"]!.location_id = s.entities["pc_main"]!.location_id;
    let fight = takeTurn(s, { type: "attack", target_id: "mon_bonepicker" }).state;

    const rogueDash = affordances(fight).find((a) => a.label === "Dash");
    expect(rogueDash?.cost).toBe("bonus");
    expect(rogueDash?.detail).toMatch(/Cunning Action/);

    const s2 = await load();
    asClass(s2, "cls_fighter", 3);
    s2.entities["mon_bonepicker"]!.location_id = s2.entities["pc_main"]!.location_id;
    fight = takeTurn(s2, { type: "attack", target_id: "mon_bonepicker" }).state;
    expect(affordances(fight).find((a) => a.label === "Dash")?.cost).toBe("action");
  });
});

describe("rage", () => {
  const hurt = (s: GameState, amount: number, type: string) =>
    reduce(s, rootEvent("effect", [{ t: "damage", entity_id: "pc_main", amount, damage_type: type }])).state;

  it("halves the three weapon damage types, and nothing else", async () => {
    let s = await load();
    const pc = asClass(s, "cls_barbarian", 3);
    pc.hp.current = 100; pc.hp.max = 100;

    s = takeTurn(s, { type: "use_feature", feature_id: "rage" }).state;
    expect(s.entities["pc_main"]!.flags["raging"]).toBe(true);

    // 10 slashing lands as 5.
    expect(hurt(s, 10, "slashing").entities["pc_main"]!.hp.current).toBe(95);
    // Fire is not on the list. Rage does not make you fireproof.
    expect(hurt(s, 10, "fire").entities["pc_main"]!.hp.current).toBe(90);
  });

  it("does nothing for someone who is not raging", async () => {
    const s = await load();
    const pc = asClass(s, "cls_barbarian", 3);
    pc.hp.current = 100; pc.hp.max = 100;
    expect(hurt(s, 10, "slashing").entities["pc_main"]!.hp.current).toBe(90);
  });

  it("drops the stance when the fight ends", async () => {
    let s = await load();
    const pc = asClass(s, "cls_barbarian", 3);
    pc.hp.current = 100; pc.hp.max = 100;
    const foe = s.entities["mon_bonepicker"]!;
    foe.location_id = pc.location_id;
    foe.zone_id = pc.zone_id;

    s = takeTurn(s, { type: "use_feature", feature_id: "rage" }).state;
    expect(s.entities["pc_main"]!.flags["raging"]).toBe(true);

    // The first attack STARTS the fight; the loop then has to end turns or the barbarian
    // stands there with a spent action. (Getting this wrong made the first version of this
    // test assert against a fight that had never begun.)
    for (let i = 0; i < 30; i++) {
      const atk = takeTurn(s, { type: "attack", target_id: "mon_bonepicker" });
      if (atk.ok) s = atk.state;
      if (!s.combat) break;
      const end = takeTurn(s, { type: "end_turn" });
      if (!end.ok) break;
      s = end.state;
    }

    expect(s.combat).toBeNull();
    expect(s.entities["pc_main"]!.flags["raging"]).toBeUndefined();
  });

  it("cannot be raged twice, and is spent from a limited pool", async () => {
    let s = await load();
    asClass(s, "cls_barbarian", 3);
    s = takeTurn(s, { type: "use_feature", feature_id: "rage" }).state;
    const again = takeTurn(s, { type: "use_feature", feature_id: "rage" });
    expect(again.ok).toBe(false);
    expect(again.message).toMatch(/already raging/i);
  });
});

describe("jack of all trades", () => {
  it("adds half proficiency only where you are not already proficient", async () => {
    const s = await load();
    const pc = asClass(s, "cls_bard", 4);
    pc.proficiencies.skills = ["persuasion"];
    pc.expertise = [];

    expect(jackBonus(pc, "persuasion")).toBe(0);          // already proficient
    expect(jackBonus(pc, "arcana")).toBe(1);              // half of +2, rounded down

    // And it reaches the roll card by name, so the bard can see where it came from.
    const labels = skillParts(pc, "arcana").map((p) => p.label);
    expect(labels).toContain("jack of all trades");
  });

  it("gives nothing to a class without it", async () => {
    const s = await load();
    const pc = asClass(s, "cls_fighter", 4);
    expect(jackBonus(pc, "arcana")).toBe(0);
  });
});

describe("extra attack", () => {
  it("swings twice from level 5, in one action and one event", async () => {
    const s = await load();
    const pc = asClass(s, "cls_fighter", 5);
    const foe = s.entities["mon_bonepicker"]!;
    foe.location_id = pc.location_id;
    foe.hp.max = 500; foe.hp.current = 500;      // survives both, so both resolve

    expect(featureOfKind(pc, "extra_attack")?.effect.attacks).toBe(2);
    const out = takeTurn(s, { type: "attack", target_id: "mon_bonepicker" });
    expect(out.ok).toBe(true);
    const attackEvent = out.journal.find((e) => e.type === "attack")!;
    expect(attackEvent.payload["attacks"]).toBe(2);
    // Two d20s on one event: one action, two swings.
    expect(attackEvent.rolls.filter((r) => r.die === "d20")).toHaveLength(2);
  });

  it("swings once below level 5", async () => {
    const s = await load();
    const pc = asClass(s, "cls_fighter", 4);
    const foe = s.entities["mon_bonepicker"]!;
    foe.location_id = pc.location_id;
    foe.hp.max = 500; foe.hp.current = 500;
    const out = takeTurn(s, { type: "attack", target_id: "mon_bonepicker" });
    expect(out.journal.find((e) => e.type === "attack")!.rolls.filter((r) => r.die === "d20")).toHaveLength(1);
  });
});

describe("levelling up rolls the die", () => {
  it("rolls hit points rather than taking the average", async () => {
    const s = await load();
    const pc = asClass(s, "cls_fighter", 2);
    pc.xp = 100_000;                       // comfortably past the threshold
    const before = pc.hp.max;

    const out = takeTurn(s, { type: "level_up" });
    expect(out.ok).toBe(true);
    expect(out.state.entities["pc_main"]!.level).toBe(3);
    expect(out.state.entities["pc_main"]!.hp.max).toBeGreaterThan(before);

    // The die is on the event, so the roll card can show it and a replay reproduces it.
    const ev = out.journal.find((e) => e.type === "level_up")!;
    expect(ev.rolls).toHaveLength(1);
    expect(ev.rolls[0]!.die).toBe("1d10");
    expect(ev.payload["rolled"]).toBeGreaterThanOrEqual(1);
    expect(ev.payload["rolled"]).toBeLessThanOrEqual(10);
  });

  it("refuses a level that was not earned", async () => {
    const s = await load();
    const pc = asClass(s, "cls_fighter", 2);
    pc.xp = 0;
    const out = takeTurn(s, { type: "level_up" });
    expect(out.ok).toBe(false);
    expect(out.journal).toHaveLength(0);
  });
});
