import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { takeTurn } from "../../src/engine/session.js";
import { changesBetween, renderChanges } from "../../src/rules/changes.js";
import { CAST_BUDGET, canAdmit, censusOf } from "../../src/rules/cast.js";
import { crowdFor, harvestable, yieldFor } from "../../src/rules/montage.js";
import { validateNarration } from "../../src/llm/validate.js";
import { reduce } from "../../src/engine/reduce.js";
import type { GameState } from "../../src/schema/state.js";
import type { GameEvent } from "../../src/schema/event.js";

const WICKMOOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../content/campaign/wickmoor");

async function world(): Promise<GameState> {
  return structuredClone(await loadCampaign(WICKMOOR));
}

// ───────────────────────────────────────────────────────────────── changes

describe("what changed", () => {
  it("says nothing changed when nothing changed", async () => {
    const s = await world();
    expect(changesBetween(s, s)).toEqual([]);
    expect(renderChanges(changesBetween(s, s))).toBe("");
  });

  it("reports a fact the PLAYER learned, and not one only an NPC knows", async () => {
    const before = await world();
    const after = structuredClone(before);
    const me = after.meta.pc_id;

    const mine = after.facts.find((f) => !f.known_by.includes(me));
    expect(mine).toBeTruthy();
    mine!.known_by = [...mine!.known_by, me];

    // A second fact that somebody ELSE learns. The player is owed no receipt for that —
    // reporting it would hand over the secret layer one line at a time.
    const theirs = after.facts.find((f) => f.id !== mine!.id && !f.known_by.includes("npc_hob"));
    if (theirs) theirs.known_by = [...theirs.known_by, "npc_hob"];

    const changes = changesBetween(before, after);
    const facts = changes.filter((c) => c.t === "fact");
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ t: "fact", text: mine!.text });
  });

  it("ignores attitude noise and reports a crossed disposition", async () => {
    const before = await world();
    const key = Object.keys(before.relationships).find((k) => k.endsWith(`->${before.meta.pc_id}`))!;

    const nudge = structuredClone(before);
    nudge.relationships[key]!.dims.affinity += 2;   // below the floor, crosses nothing
    expect(changesBetween(before, nudge).filter((c) => c.t === "attitude")).toEqual([]);

    const shove = structuredClone(before);
    shove.relationships[key]!.dims.affinity = -80;  // hostile, whatever it was
    const out = changesBetween(before, shove).filter((c) => c.t === "attitude");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sign: "down" });
    expect((out[0] as { note: string }).note).toContain("hostile");
  });

  it("catches a death, because that is the change a player must never miss", async () => {
    const before = await world();
    const after = structuredClone(before);
    const victim = Object.values(after.entities).find((e) => e.id !== after.meta.pc_id && e.alive)!;
    victim.alive = false;

    const out = changesBetween(before, after);
    expect(out).toContainEqual({ t: "person", name: victim.name, note: "is dead" });
  });

  it("reports a real turn without being told which effects ran", async () => {
    const before = await world();
    const played = takeTurn(before, { type: "look" });
    expect(played.ok).toBe(true);
    // A diff sees whatever moved. It is not given the effect list, so a new effect type
    // shows up here without anybody writing display code for it.
    expect(Array.isArray(changesBetween(before, played.state))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────── montage

describe("a montage", () => {
  it("takes hours and teaches what the crowd actually knows", async () => {
    const s = await world();
    const crowd = crowdFor(s, s.entities[s.meta.pc_id]!.location_id);
    expect(crowd.length).toBeGreaterThan(0);

    const before = s.world.world_minute;
    const played = takeTurn(s, { type: "montage", kind: "ask_around", topic: "the traveller", band: "medium" });

    expect(played.ok).toBe(true);
    // The cost: real time, so every clock in the world ran while you did it.
    expect(played.state.world.world_minute).toBeGreaterThan(before);

    const learned = played.state.facts.filter(
      (f) => f.known_by.includes(s.meta.pc_id) && !s.facts.find((g) => g.id === f.id)?.known_by.includes(s.meta.pc_id),
    );
    // Whatever it turned up must already have been true: a montage never invents a fact.
    for (const f of learned) expect(s.facts.some((g) => g.id === f.id)).toBe(true);
  });

  it("never reveals a sealed fact, at any roll", async () => {
    const s = await world();
    const crowd = crowdFor(s, s.entities[s.meta.pc_id]!.location_id);
    const sealed = s.facts.filter((f) => f.seal).map((f) => f.id);
    const got = harvestable(s, "", crowd).map((f) => f.id);
    for (const id of sealed) expect(got).not.toContain(id);
  });

  it("is deterministic — the same morning twice turns up the same list", async () => {
    const s = await world();
    const crowd = crowdFor(s, s.entities[s.meta.pc_id]!.location_id);
    const a = harvestable(s, "the moot hall", crowd).map((f) => f.id);
    const b = harvestable(s, "the moot hall", crowd).map((f) => f.id);
    expect(a).toEqual(b);
  });

  it("still tells you something on a failure — 'nothing happens' is not an outcome", () => {
    expect(yieldFor("failure", false)).toBeGreaterThan(0);
    expect(yieldFor("critical_success", true)).toBeGreaterThan(yieldFor("success_at_a_cost", true));
  });

  it("is refused in a fight rather than resolved badly", async () => {
    const s = await world();
    // A real fight, started the only way one can be: by swinging at somebody.
    const here = s.entities[s.meta.pc_id]!.location_id;
    const victim = Object.values(s.entities).find(
      (e) => e.id !== s.meta.pc_id && e.alive && e.location_id === here,
    )!;
    const fight = takeTurn(s, { type: "attack", target_id: victim.id });
    expect(fight.ok).toBe(true);
    expect(fight.state.combat).toBeTruthy();

    const played = takeTurn(fight.state, { type: "montage", kind: "ask_around", topic: "", band: "medium" });
    expect(played.ok).toBe(false);
    // And it says why, in words that explain the world rather than listing zones.
    expect(played.message).toMatch(/fight/i);
  });
});

// ──────────────────────────────────────────────────────────────── the cast

describe("the cast budget", () => {
  const ctxFor = (s: GameState) => ({
    presentEntityIds: Object.keys(s.entities),
    locationId: s.entities[s.meta.pc_id]!.location_id,
  });

  function narration(proposals: unknown[]) {
    return {
      narration: "Somebody new is behind the counter.",
      facts: [], attitude_deltas: [], opinion_updates: [],
      proposals, suggested_actions: [], scene_change: null,
    } as never;
  }

  it("admits a local the narrator names, with a stat block and a relationship", async () => {
    const s = await world();
    const here = s.entities[s.meta.pc_id]!.location_id;
    const v = validateNarration(s, narration([
      { t: "introduce_local", name: "Perrin Ashe", descriptor: "a tollgate clerk with ink to the elbow", pronouns: "he/him", location_id: here },
    ]), ctxFor(s));

    expect(v.rejects).toHaveLength(0);
    expect(v.effects).toHaveLength(1);

    const ev: GameEvent = {
      id: "evt_t0001", turn: 1, world_minute: 0, type: "effect",
      actor_id: s.meta.pc_id, location_id: here, target_ids: [], payload: {},
      rolls: [], direct_effects: v.effects, attitude_impact: [], witnesses: [],
      fact_ids: [], duration_minutes: 0, rng_nonce: "", derived_from: null, trigger_id: null,
    };
    const after = reduce(s, ev).state;

    const made = Object.values(after.entities).find((e) => e.name === "Perrin Ashe");
    expect(made).toBeTruthy();
    expect(made!.tier).toBe("local");
    // Everything that exists speaks the same vocabulary — an entity that cannot be hurt,
    // feared or talked to is a prop, not a person.
    expect(made!.hp.max).toBeGreaterThan(0);
    expect(made!.abilities.cha).toBeGreaterThan(0);
    expect(after.relationships[`${made!.id}->${after.meta.pc_id}`]).toBeTruthy();
  });

  it("refuses to introduce somebody who already exists", async () => {
    const s = await world();
    const existing = Object.values(s.entities).find((e) => e.id !== s.meta.pc_id)!;
    const v = validateNarration(s, narration([
      { t: "introduce_local", name: existing.name, descriptor: "as if for the first time", pronouns: "they/them", location_id: existing.location_id },
    ]), ctxFor(s));

    expect(v.effects).toHaveLength(0);
    expect(v.rejects[0]!.reason).toMatch(/already exists/);
  });

  it("refuses past the cap rather than evicting somebody the player might remember", async () => {
    const s = await world();
    const here = s.entities[s.meta.pc_id]!.location_id;

    // Fill the local tier to its cap.
    for (let i = 0; i < CAST_BUDGET.local; i++) {
      const id = `npc_filler_${i}`;
      s.entities[id] = { ...structuredClone(s.entities[s.meta.pc_id]!), id, name: `Filler ${i}`, tier: "local", kind: "npc" };
    }
    expect(censusOf(s).local).toBe(CAST_BUDGET.local);
    expect(canAdmit(s, "local").ok).toBe(false);

    const v = validateNarration(s, narration([
      { t: "introduce_local", name: "One Too Many", descriptor: "nobody in particular", pronouns: "they/them", location_id: here },
    ]), ctxFor(s));

    expect(v.effects).toHaveLength(0);
    expect(v.rejects[0]!.reason).toMatch(/cap/);
    // And the prose survives, as every rejected proposal must.
    expect(v.narration).toBe("Somebody new is behind the counter.");
  });

  it("does not count monsters as cast — a room of raiders is one encounter", async () => {
    const s = await world();
    const before = censusOf(s);
    const wolf = { ...structuredClone(s.entities[s.meta.pc_id]!), id: "mon_wolf_x", name: "Wolf", kind: "monster" as const, tier: "local" as const };
    s.entities[wolf.id] = wolf;
    expect(censusOf(s).local).toBe(before.local);
  });
});
