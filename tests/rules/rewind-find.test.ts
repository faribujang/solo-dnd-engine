import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { takeTurn } from "../../src/engine/session.js";
import { timeline, rewind } from "../../src/engine/rollback.js";
import { findRewindTargets, looksLikeRewind } from "../../src/rules/rewindFind.js";
import type { GameState } from "../../src/schema/state.js";
import type { GameEvent } from "../../src/schema/event.js";

const WICKMOOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../content/campaign/wickmoor");

/**
 * Rewinding by description. The matcher is lexical on purpose: this is the one destructive
 * action in the game, and a fluent wrong answer is worse than an honest list of choices.
 */
async function played(): Promise<{ initial: GameState; state: GameState; journal: GameEvent[] }> {
  const initial = structuredClone(await loadCampaign(WICKMOOR));
  let state = initial;
  const journal: GameEvent[] = [];

  const here = state.entities[state.meta.pc_id]!.location_id;
  const cotter = Object.values(state.entities).find((e) => e.location_id === here && e.id !== state.meta.pc_id)!;

  for (const action of [
    { type: "talk", target_id: cotter.id, topic: "the stranger" },
    { type: "look" },
    { type: "attack", target_id: cotter.id },
  ] as const) {
    const out = takeTurn(state, action);
    if (!out.ok) continue;
    state = out.state;
    journal.push(...out.journal);
  }
  return { initial, state, journal };
}

describe("rewinding by description", () => {
  it("recognises a request to rewind, and does not mistake ordinary play for one", () => {
    for (const yes of ["take me back to before I attacked Jory", "undo that", "roll back", "rewind please"]) {
      expect(looksLikeRewind(yes)).toBe(true);
    }
    for (const no of ["go back to the forge", "attack the raider", "ask Cotter about the stranger"]) {
      expect(looksLikeRewind(no)).toBe(false);
    }
  });

  it("finds the turn somebody is describing, by name", async () => {
    const { state, journal } = await played();
    const who = Object.values(state.entities).find((e) => e.id !== state.meta.pc_id && !e.alive)
      ?? Object.values(state.entities).find((e) => e.id !== state.meta.pc_id)!;

    const found = findRewindTargets(state, journal, `take me back to before I attacked ${who.name}`);
    expect(found.length).toBeGreaterThan(0);
    // "before" means the turn BEFORE the thing, which is what anybody undoing means.
    const attackTurn = timeline(journal, (id) => state.entities[id]?.name ?? id)
      .find((r) => r.type === "attack")!.turn;
    expect(found[0]!.turn).toBe(attackTurn - 1);
  });

  it("never proposes a turn that would drop nothing", async () => {
    const { state, journal } = await played();
    const found = findRewindTargets(state, journal, "undo the last thing I did");
    for (const c of found) expect(c.drops).toBeGreaterThan(0);
  });

  it("returns nothing rather than guessing when the description matches nothing", async () => {
    const { state, journal } = await played();
    expect(findRewindTargets(state, journal, "the submarine and the pineapple")).toEqual([]);
  });

  it("proposes a turn the engine can actually rewind to", async () => {
    const { initial, state, journal } = await played();
    const found = findRewindTargets(state, journal, "undo attacking");
    expect(found.length).toBeGreaterThan(0);

    const back = rewind(initial, journal, found[0]!.turn);
    expect(back.state.meta.turn).toBeLessThanOrEqual(found[0]!.turn);
    expect(back.removed.length).toBe(found[0]!.drops);
    // The dropped turns are handed back, not destroyed — the service archives them.
    expect(back.kept.length + back.removed.length).toBe(journal.filter((e) => e.derived_from === null).length);
  });
});

describe("the log", () => {
  it("speaks names, not ids — it is read by a player and matched against by one", async () => {
    const { state, journal } = await played();
    const rows = timeline(journal, (id) =>
      state.entities[id]?.name ?? state.locations[id]?.name ?? id);

    const text = rows.map((r) => r.summary).join(" | ");
    expect(text).not.toMatch(/\bnpc_[a-z_]+/);
    expect(text).not.toMatch(/\bloc_[a-z_]+/);
  });

  it("still works with no resolver, for callers that have no world in hand", async () => {
    const { journal } = await played();
    expect(() => timeline(journal)).not.toThrow();
  });
});
