import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { takeTurn } from "../../src/engine/session.js";
import { combatOver } from "../../src/engine/combat.js";
import { objectiveState, describeObjective } from "../../src/rules/objectives.js";
import { attackModifiers, describeZone } from "../../src/rules/terrain.js";
import type { GameState } from "../../src/schema/state.js";
import type { CombatObjective } from "../../src/rules/objectives.js";

const WICKMOOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../content/campaign/wickmoor");
const world = async (): Promise<GameState> => structuredClone(await loadCampaign(WICKMOOR));

/** A real fight, started the only way one can be. */
async function fighting(): Promise<GameState> {
  const s = await world();
  const here = s.entities[s.meta.pc_id]!.location_id;
  const foe = Object.values(s.entities).find((e) => e.id !== s.meta.pc_id && e.alive && e.location_id === here)!;
  const out = takeTurn(s, { type: "attack", target_id: foe.id });
  expect(out.state.combat).toBeTruthy();
  return out.state;
}

function withObjective(s: GameState, obj: Partial<CombatObjective> & { kind: CombatObjective["kind"] }): GameState {
  const next = structuredClone(s);
  next.combat!.objective = {
    text: "do the thing", rounds: 3, zone_id: null, entity_id: null,
    killing_also_wins: true, ...obj,
  };
  return next;
}

describe("terrain", () => {
  it("prices cover, shadow and height, itemised so the roll card can show why", async () => {
    const s = await world();
    const loc = Object.values(s.locations).find((l) => l.zones.length >= 2)
      ?? Object.values(s.locations)[0]!;
    if (loc.zones.length < 2) return;

    const [a, b] = loc.zones;
    a!.terrain = ["high"];
    b!.terrain = ["cover", "dim"];

    const attacker = structuredClone(s.entities[s.meta.pc_id]!);
    attacker.location_id = loc.id;
    attacker.zone_id = a!.id;
    const defender = structuredClone(Object.values(s.entities).find((e) => e.id !== s.meta.pc_id)!);
    defender.location_id = loc.id;
    defender.zone_id = b!.id;
    s.entities[attacker.id] = attacker;
    s.entities[defender.id] = defender;

    const mods = attackModifiers(s, attacker, defender);
    const total = mods.reduce((n, m) => n + m.value, 0);
    // +2 from above, -2 for their cover, -2 for the shadow.
    expect(total).toBe(-2);
    expect(mods.map((m) => m.label)).toContain("high ground");
    expect(mods.map((m) => m.label)).toContain("their cover");
  });

  it("gives no height bonus when everyone is up there", async () => {
    const s = await world();
    const loc = Object.values(s.locations).find((l) => l.zones.length >= 2);
    if (!loc) return;
    loc.zones[0]!.terrain = ["high"];
    loc.zones[1]!.terrain = ["high"];

    const a = structuredClone(s.entities[s.meta.pc_id]!);
    const b = structuredClone(Object.values(s.entities).find((e) => e.id !== s.meta.pc_id)!);
    a.location_id = b.location_id = loc.id;
    a.zone_id = loc.zones[0]!.id;
    b.zone_id = loc.zones[1]!.id;
    s.entities[a.id] = a; s.entities[b.id] = b;

    expect(attackModifiers(s, a, b)).toEqual([]);
  });

  it("says nothing about flat ground, so the DM is not handed noise", async () => {
    const s = await world();
    const loc = Object.values(s.locations).find((l) => l.zones.length > 0);
    if (!loc) return;
    loc.zones[0]!.terrain = [];
    expect(describeZone(s, loc.id, loc.zones[0]!.id)).toBe("");
  });
});

describe("combat objectives", () => {
  it("`hold` is won by surviving, not by killing", async () => {
    let s = withObjective(await fighting(), { kind: "hold", rounds: 2, text: "Hold the door." });
    expect(objectiveState(s, s.combat!)).toBe("pending");
    expect(combatOver(s, s.combat!)).toBeNull();

    s.combat!.round = 3;   // past two rounds
    expect(objectiveState(s, s.combat!)).toBe("won");
    // And the fight is OVER in the party's favour with every enemy still standing.
    expect(combatOver(s, s.combat!)).toBe("party");
  });

  it("`protect` is lost the moment the ward falls, whatever else is going well", async () => {
    const base = await fighting();
    const ward = Object.values(base.entities).find((e) => e.id !== base.meta.pc_id && e.alive)!;
    let s = withObjective(base, { kind: "protect", entity_id: ward.id, rounds: 5, text: "Keep them breathing." });
    expect(objectiveState(s, s.combat!)).toBe("pending");

    s.entities[ward.id]!.hp.current = 0;
    s.entities[ward.id]!.alive = false;
    expect(objectiveState(s, s.combat!)).toBe("lost");
    expect(combatOver(s, s.combat!)).toBe("enemy");
  });

  it("`escape` cannot be won by killing everyone, because that is not escaping", async () => {
    const base = await fighting();
    const zones = base.locations[base.combat!.location_id]!.zones;
    if (zones.length === 0) return;

    const s = withObjective(base, {
      kind: "escape", zone_id: zones[zones.length - 1]!.id,
      text: "Get out.", killing_also_wins: false,
    });

    // Wipe the other side out. The fight does NOT end, because leaving was the point.
    for (const cb of s.combat!.order) {
      if (cb.side !== "enemy") continue;
      s.entities[cb.entity_id]!.hp.current = 0;
      s.entities[cb.entity_id]!.alive = false;
    }
    expect(combatOver(s, s.combat!)).toBeNull();

    // Stand in the right place and it is over.
    s.entities[s.meta.pc_id]!.zone_id = zones[zones.length - 1]!.id;
    expect(combatOver(s, s.combat!)).toBe("party");
  });

  it("`break` ends the fight when one specific enemy drops", async () => {
    const base = await fighting();
    const foe = base.combat!.order.find((c) => c.side === "enemy")!.entity_id;
    const s = withObjective(base, { kind: "break", entity_id: foe, text: "Put the captain down." });

    expect(objectiveState(s, s.combat!)).toBe("pending");
    s.entities[foe]!.hp.current = 0;
    expect(objectiveState(s, s.combat!)).toBe("won");
  });

  it("is lost if the player goes down, whatever the objective was", async () => {
    const s = withObjective(await fighting(), { kind: "hold", rounds: 9, text: "Hold." });
    s.entities[s.meta.pc_id]!.hp.current = 0;
    s.entities[s.meta.pc_id]!.alive = false;
    expect(objectiveState(s, s.combat!)).toBe("lost");
  });

  it("an ordinary fight still ends the ordinary way", async () => {
    const s = await fighting();
    expect(s.combat!.objective).toBeNull();
    expect(objectiveState(s, s.combat!)).toBe("pending");
    for (const cb of s.combat!.order) {
      if (cb.side !== "enemy") continue;
      s.entities[cb.entity_id]!.hp.current = 0;
      s.entities[cb.entity_id]!.alive = false;
    }
    expect(combatOver(s, s.combat!)).toBe("party");
  });

  it("tells the player what they are doing and how long they have", async () => {
    const s = withObjective(await fighting(), { kind: "hold", rounds: 3, text: "Hold the bridge." });
    s.combat!.round = 2;
    const line = describeObjective(s, s.combat!);
    expect(line).toContain("Hold the bridge.");
    expect(line).toMatch(/2 rounds left/);
  });
});
