import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { takeLLMTurn } from "../../src/engine/llmTurn.js";
import { takeTurn } from "../../src/engine/session.js";
import { MockLLM } from "../../src/llm/mock.js";
import type { GameState } from "../../src/schema/state.js";

const CAMPAIGN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../content/campaign/drowned_bell");

/**
 * A TURN ROLLS ONCE.
 *
 * `resolve` is not a query — it draws dice. A caller that resolves to ask whether an
 * action is legal and then plays it has rolled twice, and under `karmic` or `true` dice
 * the second draw is a different number. That is invisible under `committed` dice, which
 * seed from the situation and so answer identically both times — which is exactly why
 * every other test in this suite missed it and why these three force the other modes.
 *
 * The damage is not theoretical: the discarded roll is what reached the player, as the
 * mechanics summary on the roll card and as the whole fallback line when the narrator is
 * down. Code owns truth; it cannot also report a number it threw away.
 */
async function world(dice: "karmic" | "true" | "committed"): Promise<GameState> {
  const s = structuredClone(await loadCampaign(CAMPAIGN));
  s.meta.session_zero.dice = dice;
  return s;
}

/** Every d20 the journal actually recorded, in order. */
function journalledDice(journal: ReadonlyArray<{ rolls: ReadonlyArray<{ raw: number }> }>): number[] {
  return journal.flatMap((e) => e.rolls.map((r) => r.raw));
}

describe("a turn rolls once", () => {
  for (const dice of ["karmic", "true", "committed"] as const) {
    it(`${dice}: the mechanics summary reports a die the journal contains`, async () => {
      const state = await world(dice);
      const llm = new MockLLM({ seed: "one-roll" });

      const out = await takeLLMTurn(llm, state, "persuade Mira", {});
      expect(out.ok).toBe(true);

      const rolled = journalledDice(out.journal);
      // Nothing to prove if the action the parser picked never called for a die.
      if (rolled.length === 0) return;

      // The summary prints the natural die. Whatever number it names has to be one the
      // journal kept — otherwise the player was shown a roll that did not happen.
      const named = [...(out.debug.mechanics ?? "").matchAll(/\bd20 (\d+)\b/g)].map((m) => Number(m[1]));
      expect(named.length).toBeGreaterThan(0);
      for (const n of named) expect(rolled).toContain(n);
    });
  }

  it("karmic: the roll card and the summary describe the same die", async () => {
    const state = await world("karmic");
    const llm = new MockLLM({ seed: "same-die" });

    // Run it enough times that two independent draws would almost certainly disagree at
    // least once: a d20 matching by luck is 1-in-20 a turn, so twenty turns makes a
    // surviving double-resolve a ~1-in-10^26 escape.
    for (let i = 0; i < 20; i++) {
      const out = await takeLLMTurn(llm, state, "persuade Mira", {});
      const rolled = journalledDice(out.journal);
      if (rolled.length === 0) continue;
      const named = [...(out.debug.mechanics ?? "").matchAll(/\bd20 (\d+)\b/g)].map((m) => Number(m[1]));
      for (const n of named) expect(rolled).toContain(n);
    }
  });

  it("takeTurn hands back the root event, so nobody has to resolve again to see it", async () => {
    const state = await world("karmic");
    const played = takeTurn(state, { type: "skill_check", skill: "persuasion", band: "medium", target_id: "npc_mira" });

    expect(played.ok).toBe(true);
    expect(played.root).not.toBeNull();
    // The event handed back is the one that was reduced, not a fresh resolve of the same
    // action — so its dice are the dice the world moved on.
    expect(played.journal[0]!.id).toBe(played.root!.id);
    expect(played.journal[0]!.rolls).toEqual(played.root!.rolls);
  });

  it("a refusal still costs no dice and writes nothing", async () => {
    const state = await world("karmic");
    const played = takeTurn(state, { type: "move", dir: "straight up through the roof" });

    expect(played.ok).toBe(false);
    expect(played.root).toBeNull();
    expect(played.journal).toEqual([]);
    expect(played.state).toBe(state);
  });
});
