import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { takeLLMTurn } from "../../src/engine/llmTurn.js";
import { takeTurn } from "../../src/engine/session.js";
import { MAX_WAIT_MINUTES } from "../../src/engine/turn.js";
import { buildContext } from "../../src/context/build.js";
import { MockLLM } from "../../src/llm/mock.js";
import type { GameState } from "../../src/schema/state.js";

const CAMPAIGN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../content/campaign/drowned_bell");

/**
 * These suites test that the ENGINE is deterministic — replay, rewind, cascades. They pin
 * `committed` dice so a re-run of the same script is comparable. Dice *feel* is tested in
 * tests/rules/.
 */
async function loadCommitted() {
  const s = structuredClone(await loadCampaign(CAMPAIGN));
  s.meta.session_zero.dice = "committed";
  return s;
}

/**
 * THE PHASE 2 GATE — the canon test.
 *
 * A detail established at turn 3 must be recalled, unprompted, at turn 55. And an NPC must
 * provably NOT know a secret they never witnessed.
 *
 * The first half is what a rolling summary fails: fifty turns of noise between the detail
 * and the recall. The second half is what a naive "put everything in the prompt" approach
 * fails: the guard would know about the ledger.
 */
describe("canon test: a turn-3 detail survives to turn 55", () => {
  it("recalls a fact established early, verbatim, fifty turns later", async () => {
    const llm = new MockLLM({ seed: "canon" });
    let s = await loadCommitted();

    // Turns 1–3: establish something specific. The narrator (mock) writes a fact on some
    // turns; we plant one deterministically so the test does not depend on the mock's dice.
    for (const t of ["look around", "talk to thorne about the bell", "look around"]) {
      s = (await takeLLMTurn(llm, s, t, {})).state;
    }
    const planted = takeTurn(s, { type: "look" });
    s = planted.state;
    // Simulate the narrator establishing a detail at turn 3 via the engine's own path.
    s = structuredClone(s);
    s.facts.push({
      id: "fact_brother", turn: s.meta.turn, world_minute: s.world.world_minute,
      text: "Thorne's brother was named Aldous, and he drowned the winter the bell was lost.",
      kind: "npc", subjects: ["npc_thorne"], location_id: "loc_flagon", quest_ids: [],
      importance: 3, secret: false, known_by: ["pc_main", "npc_thorne"],
      source: "narrator", superseded_by: null, seal: null,
    });
    s.entities["npc_thorne"]!.known_fact_ids.push("fact_brother");

    // Turns 4–54: fifty turns of noise. Leave the Flagon, wander, fight, come back.
    const noise = [
      "go out", "look around", "search the mud", "talk to mira about the weather",
      "wait 30", "look around", "head down toward the shrine", "look around",
      "speak to garret about the stair", "wait 20", "look", "search behind the altar",
      "go up", "wait 60", "look", "go in", "look around", "go out", "wait 15", "look",
    ];
    let turns = 0;
    while (turns < 50) {
      for (const t of noise) {
        if (turns >= 50) break;
        const out = await takeLLMTurn(llm, s, t, {});
        s = out.state;
        if (out.ok) turns++;   // refusals cost no turn, so they do not count toward fifty
      }
    }
    expect(s.meta.turn).toBeGreaterThanOrEqual(50);

    // Turn 55: walk back into the Flagon. Thorne is present. Build the prompt.
    // Ensure the PC ends up in the Flagon regardless of where the noise left them.
    s = structuredClone(s);
    s.entities["pc_main"]!.location_id = "loc_flagon";
    s.entities["npc_thorne"]!.location_id = "loc_flagon";

    const ctx = buildContext(s);

    // The detail is in CANON, verbatim, and the test is unprompted: nothing asked about it.
    expect(ctx.user).toContain("Thorne's brother was named Aldous");
    expect(ctx.canon.some((c) => c.fact.id === "fact_brother")).toBe(true);
  });

  it("an NPC provably does not know a secret they never witnessed", async () => {
    let s: GameState = await loadCommitted();

    // fact_seed_0002 (Thorne's debt) is known to Thorne and Garret. Mira never learns it
    // unless someone tells her — she is in the lane, and it is secret so gossip skips it.
    expect(s.facts.find((f) => f.id === "fact_seed_0002")!.known_by).not.toContain("npc_mira");

    // Pass a lot of time with everyone in their places. Gossip runs; secrets do not spread.
    for (let i = 0; i < 6; i++) s = takeTurn(s, { type: "wait", minutes: 240 }).state;

    expect(s.entities["npc_mira"]!.known_fact_ids).not.toContain("fact_seed_0002");
    expect(s.facts.find((f) => f.id === "fact_seed_0002")!.known_by).not.toContain("npc_mira");

    // And the prompt, when Mira is the only NPC present, never leaks it.
    s = structuredClone(s);
    s.entities["pc_main"]!.location_id = "loc_lane";
    s.entities["npc_mira"]!.location_id = "loc_lane";
    s.entities["npc_thorne"]!.location_id = "loc_flagon";
    const ctx = buildContext(s);
    expect(ctx.user).not.toContain("owes the Ashen Hand");
  });

  it("but a NON-secret fact does spread by gossip to a co-located NPC", async () => {
    let s: GameState = await loadCommitted();
    // fact_seed_0003 is Mira's non-secret knowledge. Put Thorne with her and pass time.
    s = structuredClone(s);
    s.entities["npc_thorne"]!.location_id = "loc_lane";
    s.entities["npc_thorne"]!.schedule = [];   // stop him walking home
    for (let i = 0; i < 10; i++) s = takeTurn(s, { type: "wait", minutes: 240 }).state;
    expect(s.entities["npc_thorne"]!.known_fact_ids).toContain("fact_seed_0003");
  });
});

/**
 * THE DEADLINE TEST — a quest fails by expiry with its cascade intact.
 */
describe("a quest can be failed by letting its deadline expire", () => {
  it("refuses to let one `wait` skip a deadline, however it was asked for", async () => {
    // The cap used to live in the intent mapper alone, so any client sending the action
    // directly — a palette entry, a replay, a test — skipped 694 days in a single turn and
    // finished every clock in the world. A rule that holds for only one of an action's
    // entry points is not a rule.
    const s = await loadCommitted();
    const before = s.world.world_minute;
    const out = takeTurn(s, { type: "wait", minutes: 999_999 });
    expect(out.ok).toBe(true);
    expect(out.state.world.world_minute - before).toBe(MAX_WAIT_MINUTES);
  });

  it("expires q_thornes_debt when the clock passes 4000 without completing it", async () => {
    let s = await loadCommitted();
    expect(s.quests["q_thornes_debt"]!.status).toBe("active");
    expect(s.world.world_minute).toBeLessThan(4000);

    // Never read the ledger. Just let time pass — in the increments a player actually
    // has. One `wait` is capped at MAX_WAIT_MINUTES so that no single action can skip a
    // deadline; reaching one takes repeated, visible decisions to burn the day.
    let out = takeTurn(s, { type: "rest", kind: "long" });        // +480
    s = out.state;
    out = takeTurn(s, { type: "rest", kind: "long" });            // +480
    s = out.state;
    // The deadline is now crossed partway through, on whichever turn happens to carry the
    // world past it — so the whole run is collected rather than only the last turn.
    const everything = [...out.journal];
    for (let i = 0; i < 6; i++) {
      out = takeTurn(s, { type: "wait", minutes: MAX_WAIT_MINUTES });
      s = out.state;
      everything.push(...out.journal);
    }

    expect(s.world.world_minute).toBeGreaterThanOrEqual(4000);
    expect(s.quests["q_thornes_debt"]!.status).toBe("expired");

    // The cascade is journaled: a quest_update event exists for the expiry.
    const expiry = everything.find(
      (e) => e.type === "quest_update" && (e.payload as { quest_id?: string }).quest_id === "q_thornes_debt",
    );
    expect(expiry).toBeDefined();
    expect(expiry!.derived_from).not.toBeNull();
  });

  it("does not expire it if it was completed in time", async () => {
    let s = await loadCommitted();
    s = takeTurn(s, { type: "skill_check", skill: "investigation", band: "trivial", tag: "read_ledger" }).state;
    expect(s.quests["q_thornes_debt"]!.status).toBe("complete");
    s = takeTurn(s, { type: "wait", minutes: 5000 }).state;
    expect(s.quests["q_thornes_debt"]!.status).toBe("complete");
  });
});
