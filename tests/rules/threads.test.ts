import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { reduce } from "../../src/engine/reduce.js";
import { takeTurn } from "../../src/engine/session.js";
import { validateNarration } from "../../src/llm/validate.js";
import { changesBetween } from "../../src/rules/changes.js";
import { threadModel } from "../../src/view/models.js";
import { MAX_OPEN_THREADS, THREAD_FADE_MINUTES } from "../../src/schema/thread.js";
import { MAX_WAIT_MINUTES } from "../../src/engine/turn.js";
import type { GameState } from "../../src/schema/state.js";
import type { GameEvent } from "../../src/schema/event.js";
import type { Effect } from "../../src/schema/dsl.js";

const WICKMOOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../content/campaign/wickmoor");
const world = async (): Promise<GameState> => structuredClone(await loadCampaign(WICKMOOR));

function apply(s: GameState, effects: Effect[], turn = 1): GameState {
  const ev: GameEvent = {
    id: `evt_x${turn}`, turn, world_minute: s.world.world_minute, type: "effect",
    actor_id: s.meta.pc_id, location_id: s.entities[s.meta.pc_id]!.location_id,
    target_ids: [], payload: {}, rolls: [], direct_effects: effects, attitude_impact: [],
    witnesses: [], fact_ids: [], duration_minutes: 0, rng_nonce: "", derived_from: null, trigger_id: null,
  };
  return reduce(s, ev).state;
}

function narration(proposals: unknown[]) {
  return {
    narration: "He asks it quietly, as if it costs him something.",
    facts: [], attitude_deltas: [], opinion_updates: [],
    proposals, suggested_actions: [], scene_change: null,
  } as never;
}

const ctxFor = (s: GameState) => ({
  presentEntityIds: Object.keys(s.entities),
  locationId: s.entities[s.meta.pc_id]!.location_id,
});

/**
 * Threads are the side of a campaign nobody wrote down. The tests that matter are not
 * "can it store a sentence" — they are the ones that stop the Journal turning into a
 * to-do list nobody reads.
 */
describe("threads", () => {
  it("opens one the narrator asked for, and reports it on the receipt", async () => {
    const s = await world();
    const who = Object.values(s.entities).find((e) => e.id !== s.meta.pc_id)!;

    const v = validateNarration(s, narration([
      { t: "open_thread", text: "Find out who is still collecting Emeric's pension.", subject_ids: [who.id], location_id: null, from_entity_id: who.id },
    ]), ctxFor(s));
    expect(v.rejects).toHaveLength(0);

    const after = apply(s, v.effects);
    const open = Object.values(after.threads).filter((t) => t.status === "open");
    expect(open).toHaveLength(1);
    expect(open[0]!.from_entity_id).toBe(who.id);

    // The player is told they took something on.
    const changes = changesBetween(s, after).filter((c) => c.t === "thread");
    expect(changes).toHaveLength(1);
  });

  it("opens at most one per turn", async () => {
    const s = await world();
    const v = validateNarration(s, narration([
      { t: "open_thread", text: "Bring Nell the good flour.", subject_ids: [], location_id: null, from_entity_id: null },
      { t: "open_thread", text: "Ask Hob about the pitch price.", subject_ids: [], location_id: null, from_entity_id: null },
    ]), ctxFor(s));

    expect(v.effects).toHaveLength(1);
    expect(v.rejects[0]!.reason).toMatch(/one new thread per turn/);
  });

  it("stops accepting new ones once the Journal is full", async () => {
    let s = await world();
    for (let i = 0; i < MAX_OPEN_THREADS; i++) {
      s = apply(s, [{ t: "open_thread", text: `Errand number ${i}.`, subject_ids: [], location_id: null, from_entity_id: null }], i + 1);
    }
    const v = validateNarration(s, narration([
      { t: "open_thread", text: "One promise too many.", subject_ids: [], location_id: null, from_entity_id: null },
    ]), ctxFor(s));

    expect(v.effects).toHaveLength(0);
    expect(v.rejects[0]!.reason).toMatch(/already hanging/);
    // And the prose survives, as every rejected proposal must.
    expect(v.narration).toContain("quietly");
  });

  it("fades what nobody mentions again, rather than hoarding it forever", async () => {
    let s = await world();
    s = apply(s, [{ t: "open_thread", text: "Look in on the Wick girl.", subject_ids: [], location_id: null, from_entity_id: null }]);
    const id = Object.keys(s.threads)[0]!;
    expect(s.threads[id]!.status).toBe("open");

    // Ten days of ordinary play, in the increments a player actually has.
    const waits = Math.ceil(THREAD_FADE_MINUTES / MAX_WAIT_MINUTES) + 1;
    for (let i = 0; i < waits; i++) s = takeTurn(s, { type: "wait", minutes: MAX_WAIT_MINUTES }).state;

    expect(s.threads[id]!.status).toBe("faded");
    expect(s.threads[id]!.outcome).toMatch(/nobody mentioned/);
  });

  it("can be settled, and will not be settled twice", async () => {
    let s = await world();
    s = apply(s, [{ t: "open_thread", text: "Pay Hob what the pitch was worth.", subject_ids: [], location_id: null, from_entity_id: null }]);
    const id = Object.keys(s.threads)[0]!;

    const ok = validateNarration(s, narration([
      { t: "resolve_thread", thread_id: id, as: "kept", outcome: "paid in full, in front of witnesses" },
    ]), ctxFor(s));
    expect(ok.effects).toHaveLength(1);
    s = apply(s, ok.effects, 2);
    expect(s.threads[id]!.status).toBe("kept");

    const again = validateNarration(s, narration([
      { t: "resolve_thread", thread_id: id, as: "broken", outcome: "actually no" },
    ]), ctxFor(s));
    expect(again.effects).toHaveLength(0);
    expect(again.rejects[0]!.reason).toMatch(/already kept/);
  });

  it("refuses to resolve a thread that does not exist", async () => {
    const s = await world();
    const v = validateNarration(s, narration([
      { t: "resolve_thread", thread_id: "thr_invented", as: "kept", outcome: "" },
    ]), ctxFor(s));
    expect(v.effects).toHaveLength(0);
    expect(v.rejects[0]!.reason).toMatch(/no thread/);
  });

  it("marks a thread whose subject is standing in front of you", async () => {
    let s = await world();
    const here = s.entities[s.meta.pc_id]!.location_id;
    const present = Object.values(s.entities).find((e) => e.id !== s.meta.pc_id && e.location_id === here)!;
    const elsewhere = Object.values(s.entities).find((e) => e.location_id !== here && e.id !== s.meta.pc_id)!;

    s = apply(s, [{ t: "open_thread", text: "Say the thing to their face.", subject_ids: [present.id], location_id: null, from_entity_id: null }], 1);
    s = apply(s, [{ t: "open_thread", text: "Find them, wherever they went.", subject_ids: [elsewhere.id], location_id: null, from_entity_id: null }], 2);

    const rows = threadModel(s);
    expect(rows.find((r) => r.text.includes("to their face"))!.here).toBe(true);
    expect(rows.find((r) => r.text.includes("wherever they went"))!.here).toBe(false);
  });

  it("survives replay — a thread is state like anything else", async () => {
    const initial = await world();
    const s1 = apply(initial, [{ t: "open_thread", text: "Settle it before the tithe.", subject_ids: [], location_id: null, from_entity_id: null }]);
    const s2 = apply(initial, [{ t: "open_thread", text: "Settle it before the tithe.", subject_ids: [], location_id: null, from_entity_id: null }]);
    // Same effect, same starting world, same id — no clock, no randomness, no ordering luck.
    expect(Object.keys(s1.threads)).toEqual(Object.keys(s2.threads));
    expect(s1.threads).toEqual(s2.threads);
  });
});
