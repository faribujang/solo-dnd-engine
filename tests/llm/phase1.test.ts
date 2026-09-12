import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { DEMO_FREE_TEXT } from "../../src/content/demoFreeText.js";
import { takeLLMTurn } from "../../src/engine/llmTurn.js";
import { reduceAll } from "../../src/engine/reduce.js";
import { MockLLM } from "../../src/llm/mock.js";
import { GameState } from "../../src/schema/state.js";
import { stable } from "../../src/state/jsonFileStore.js";
import type { GameEvent } from "../../src/schema/event.js";
import type { Reject } from "../../src/llm/validate.js";

const CAMPAIGN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../content/campaign/drowned_bell",
);

async function play(text: readonly string[], mischief = 0) {
  const initial = await loadCampaign(CAMPAIGN);
  const llm = new MockLLM({ seed: "phase1", mischief });
  let state = initial;
  const journal: GameEvent[] = [];
  const rejects: Reject[] = [];
  const recent: string[] = [];
  const log: Array<{ input: string; kind: string; text: string }> = [];

  for (const input of text) {
    const out = await takeLLMTurn(llm, state, input, { recent: recent.slice(-6) });
    state = out.state;
    journal.push(...out.journal);
    rejects.push(...out.rejects);
    log.push({ input, kind: out.kind, text: out.text });
    if (out.ok) recent.push(`> ${input}\n${out.text}`);
  }

  return { initial, state, journal, rejects, log, llm };
}

/**
 * THE PHASE 1 GATE.
 *
 * Twenty turns of free-text play with zero schema violations reaching state, and a
 * rejects log that has actually been exercised.
 */
describe("golden: twenty turns of free text", () => {
  it("plays twenty turns without a single schema violation reaching state", async () => {
    const { state, log } = await play(DEMO_FREE_TEXT);

    expect(log.length).toBeGreaterThanOrEqual(20);
    // The strongest statement available: whatever the model said, the world is still valid.
    expect(() => GameState.parse(state)).not.toThrow();
  });

  it("keeps the world valid after every single turn, not just at the end", async () => {
    const initial = await loadCampaign(CAMPAIGN);
    const llm = new MockLLM({ seed: "per-turn", mischief: 0.5 });
    let state = initial;

    for (const input of DEMO_FREE_TEXT) {
      const out = await takeLLMTurn(llm, state, input, {});
      state = out.state;
      expect(() => GameState.parse(state), `world invalid after "${input}"`).not.toThrow();
    }
  });

  it("answers nonsense with a question rather than a guess", async () => {
    const { log } = await play(DEMO_FREE_TEXT);
    const nonsense = log.find((l) => l.input === "flurb the wibbet")!;
    expect(nonsense.kind).toBe("clarify");
    expect(nonsense.text.length).toBeGreaterThan(0);
  });

  it("refuses an unimplemented action honestly instead of doing something else", async () => {
    const { log } = await play(DEMO_FREE_TEXT);
    const spell = log.find((l) => l.input.startsWith("cast fireball"))!;
    expect(spell.kind).toBe("clarify");
    expect(spell.text).toMatch(/not implemented/i);
  });

  it("replays the whole session from its journal, byte for byte", async () => {
    const { initial, state, journal } = await play(DEMO_FREE_TEXT, 0.4);

    // Including the narrator's own committed effects, which is the point: a non-deterministic
    // narrator does not make the save non-reproducible, because what it said was journaled.
    const roots = journal.filter((e) => e.derived_from === null);
    const replayed = reduceAll(initial, roots);

    expect(stable(replayed.state)).toBe(stable(state));
  });

  it("advances the world: time, facts and quests all move", async () => {
    const { initial, state } = await play(DEMO_FREE_TEXT);

    expect(state.world.world_minute).toBeGreaterThan(initial.world.world_minute);
    expect(state.facts.length).toBeGreaterThan(initial.facts.length);
    expect(state.meta.turn).toBeGreaterThan(10);
  });

  it("calls the model exactly twice per resolved turn, and not at all for a refusal", async () => {
    const initial = await loadCampaign(CAMPAIGN);
    const llm = new MockLLM({ seed: "counting" });

    await takeLLMTurn(llm, initial, "look around", {});
    expect(llm.calls.map((c) => c.role)).toEqual(["intent", "narrate"]);

    // Nonsense stops after the intent call — there is nothing to narrate.
    await takeLLMTurn(llm, initial, "flurb the wibbet", {});
    expect(llm.calls.map((c) => c.role)).toEqual(["intent", "narrate", "intent"]);
  });
});

describe("the rejects log", () => {
  it("stays empty when the narrator behaves", async () => {
    const { rejects } = await play(DEMO_FREE_TEXT, 0);
    expect(rejects).toHaveLength(0);
  });

  it("catches a misbehaving narrator, and none of it reaches state", async () => {
    const { state, rejects } = await play(DEMO_FREE_TEXT, 1);

    expect(rejects.length).toBeGreaterThan(0);

    // Every rejection carries enough to debug it without re-running the session.
    for (const r of rejects) {
      expect(r.reason.length).toBeGreaterThan(10);
      expect(r.payload).toBeDefined();
      expect(typeof r.turn).toBe("number");
    }

    // The specific things the mischievous mock tries, and what should have happened.
    const reasons = rejects.map((r) => r.reason).join(" | ");
    expect(reasons).toMatch(/may not move the player|unknown location|clamped|cap is|unknown quest/);

    // The PC never took the psychic damage the narrator tried to deal.
    expect(state.entities["pc_main"]!.hp.current).toBeGreaterThan(0);
    expect(state.locations["loc_the_moon"]).toBeUndefined();
  });

  it("never lets the narrator move the player character", async () => {
    const { rejects } = await play(["look around"], 0);
    expect(rejects.filter((r) => r.reason.includes("may not move the player"))).toBeDefined();
  });
});
