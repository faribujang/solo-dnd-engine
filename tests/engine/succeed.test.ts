import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { reduce, reduceAll } from "../../src/engine/reduce.js";
import { campaignComplete, planSuccession } from "../../src/engine/succession.js";
import { Rng, seedToState } from "../../src/rules/rng.js";
import { stable } from "../../src/state/jsonFileStore.js";
import type { GameEvent } from "../../src/schema/event.js";
import type { GameState } from "../../src/schema/state.js";

const CAMPAIGN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../content/campaign/drowned_bell");
const load = async (): Promise<GameState> => structuredClone(await loadCampaign(CAMPAIGN));

/**
 * Succession as the CLI runs it: one plan, one journaled event.
 *
 * The shape matters more than the numbers. A time skip that is not an ordinary event is a
 * time skip the journal cannot replay and a rewind cannot undo, and the moment that is true
 * the journal has stopped being the source of truth.
 */
function successionEvent(s: GameState, campaignId: string, years = 12): { event: GameEvent; plan: ReturnType<typeof planSuccession> } {
  const rng = new Rng(seedToState(`${s.meta.seed}|succession|${campaignId}|`));
  const plan = planSuccession(s, rng, { campaignId, years });
  return {
    plan,
    event: {
      id: `evt_succ${String(s.meta.turn + 1).padStart(4, "0")}`,
      turn: s.meta.turn + 1,
      world_minute: s.world.world_minute,
      type: "campaign_start",
      actor_id: null, target_ids: [], location_id: null,
      payload: { succession: true, campaign_id: campaignId, years },
      rolls: [], direct_effects: plan.effects, attitude_impact: [], witnesses: [], fact_ids: [],
      duration_minutes: 0, rng_nonce: "", derived_from: null, trigger_id: null,
    },
  };
}

describe("ending a campaign", () => {
  it("will not call an unfinished campaign finished", async () => {
    const s = await load();
    // Its climax quest is still open. Ending a campaign is a one-way door in the fiction,
    // so it should not happen because a side quest expired.
    expect(campaignComplete(s, "cmp_mudwallow")).toBe(false);
  });

  it("ages the world through ONE ordinary event, which replays exactly", async () => {
    const s = await load();
    const { event, plan } = successionEvent(s, "cmp_mudwallow");
    expect(plan.effects.length).toBeGreaterThan(0);

    const after = reduce(s, event);
    // Twelve years, on the same clock everything else uses.
    expect(after.state.world.world_minute).toBeGreaterThan(s.world.world_minute + 11 * 365 * 1440);

    // And it is just an event: replaying it from the same start lands on the same world.
    const replayed = reduceAll(s, [event]);
    expect(stable(replayed.state)).toBe(stable(after.state));
  });

  it("retires the party rather than killing them off", async () => {
    const s = await load();
    const { event } = successionEvent(s, "cmp_mudwallow");
    const after = reduce(s, event).state;
    for (const id of s.meta.party_ids) {
      // A retired hero is the best NPC a later campaign can meet.
      expect(after.entities[id]!.flags["retired"]).toBe(true);
      expect(after.entities[id]!.flags["died_offscreen"]).toBeUndefined();
    }
  });

  it("promotes the threads nobody tied off, known to nobody yet", async () => {
    const s = await load();
    const { plan, event } = successionEvent(s, "cmp_mudwallow");
    expect(plan.promoted.length).toBeGreaterThan(0);

    const after = reduce(s, event).state;
    const seeded = after.facts.find((f) => f.text === plan.promoted[0]!.text);
    expect(seeded).toBeDefined();
    // The next party has to FIND it. A seed everybody already knows is not a hook.
    expect(seeded!.known_by).toEqual([]);
    expect(seeded!.importance).toBeGreaterThanOrEqual(4);
  });

  it("writes a legacy ledger of what mattered, not everything that happened", async () => {
    const s = await load();
    const { plan } = successionEvent(s, "cmp_mudwallow");
    expect(plan.legacy.length).toBeGreaterThan(0);
    for (const entry of plan.legacy) {
      expect(entry.campaign_id).toBe("cmp_mudwallow");
      expect(entry.text.length).toBeGreaterThan(0);
    }
    // Low-importance facts stay in the fact ledger and out of the world's long memory.
    const trivia = s.facts.filter((f) => f.importance < 4).map((f) => f.text);
    for (const t of trivia) expect(plan.legacy.some((l) => l.text === t)).toBe(false);
  });

  it("leaves a wrecked faction wrecked, and lets an untouched one drift back", async () => {
    const s = await load();
    const fid = Object.keys(s.world.factions)[0]!;
    s.world.factions[fid]!.rep_with_pc = -80;

    const { event } = successionEvent(s, "cmp_mudwallow");
    const after = reduce(s, event).state;
    // It recovers, but only partly: consequence should outlast the people who caused it.
    expect(after.world.factions[fid]!.rep_with_pc).toBeGreaterThan(-80);
    expect(after.world.factions[fid]!.rep_with_pc).toBeLessThan(0);
  });

  it("closes the books through effects, not beside them", async () => {
    const s = await load();
    const { event } = successionEvent(s, "cmp_mudwallow");
    const after = reduce(s, event).state;

    // Everything a succession changes goes through the reducer. The first version of the
    // CLI mutated these four beside the journal and the rebuild gate caught it within a
    // minute — which is the entire reason that gate exists.
    expect(after.campaigns["cmp_mudwallow"]!.status).toBe("complete");
    expect(Object.values(after.arcs).every((a) => a.status !== "active")).toBe(true);
    expect(after.legacy.length).toBeGreaterThan(0);
    expect(Object.values(after.arcs).flatMap((a) => a.seeds).every((x) => x.promoted)).toBe(true);
  });

  it("fires clocks in a stable order, whatever order they were written in", async () => {
    // A twelve-year skip finishes several clocks at once. Iterating them in object order
    // means authored content (written order) and a reloaded save (key-sorted) fire their
    // consequences in different sequences, which renumbers every fact minted afterwards.
    const s = await load();
    const shuffled = await load();
    shuffled.clocks = Object.fromEntries(Object.entries(s.clocks).reverse());
    expect(Object.keys(shuffled.clocks)).not.toEqual(Object.keys(s.clocks));

    const a = reduce(s, successionEvent(s, "cmp_mudwallow").event).state;
    const b = reduce(shuffled, successionEvent(shuffled, "cmp_mudwallow").event).state;
    expect(a.facts.map((f) => f.text)).toEqual(b.facts.map((f) => f.text));
    expect(a.facts.map((f) => f.id)).toEqual(b.facts.map((f) => f.id));
  });

  it("is deterministic given the same seed, so a rebuild reproduces the same generation", async () => {
    const a = await load();
    const b = await load();
    expect(stable(successionEvent(a, "cmp_mudwallow").plan))
      .toBe(stable(successionEvent(b, "cmp_mudwallow").plan));
  });
});
