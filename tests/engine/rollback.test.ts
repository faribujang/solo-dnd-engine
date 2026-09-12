import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { DEMO_SCRIPT } from "../../src/content/demoScript.js";
import { runScript, takeTurn } from "../../src/engine/session.js";
import { highestTurn, rewind, rewindBy, timeline } from "../../src/engine/rollback.js";
import { stable } from "../../src/state/jsonFileStore.js";

const CAMPAIGN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../content/campaign/drowned_bell",
);

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

describe("rewind", () => {
  it("returns the world to exactly what it was at that turn", async () => {
    const initial = await loadCommitted();

    // Play ten turns, remember the world, play twenty more, then go back.
    const first = runScript(initial, DEMO_SCRIPT.slice(0, 10));
    const full = runScript(initial, DEMO_SCRIPT);

    const back = rewind(initial, full.journal, 10);

    expect(stable(back.state)).toBe(stable(first.state));
  });

  it("has no depth limit — turn 1 is as reachable as turn 29", async () => {
    const initial = await loadCommitted();
    const full = runScript(initial, DEMO_SCRIPT);

    // Only turns before combat begins are reproducible by re-running a script prefix: once
    // the CPU acts, turns and script indices diverge. Later turns are covered by replay.
    for (const turn of [1, 5, 17]) {
      const expected = runScript(initial, DEMO_SCRIPT.slice(0, turn));
      const back = rewind(initial, full.journal, turn);
      expect(stable(back.state), `rewind to turn ${turn}`).toBe(stable(expected.state));
    }
  });

  it("rewinds all the way to before anything happened", async () => {
    const initial = await loadCommitted();
    const full = runScript(initial, DEMO_SCRIPT);
    const back = rewind(initial, full.journal, 0);
    expect(stable(back.state)).toBe(stable(initial));
  });

  it("hands back the events it dropped so nothing is actually destroyed", async () => {
    const initial = await loadCommitted();
    const full = runScript(initial, DEMO_SCRIPT);
    const roots = full.journal.filter((e) => e.derived_from === null);

    const back = rewind(initial, full.journal, 25);

    expect(back.kept.length + back.removed.length).toBe(roots.length);
    expect(back.removed.every((e) => e.turn > 25)).toBe(true);
    expect(back.kept.every((e) => e.turn <= 25)).toBe(true);
  });

  it("can be resumed: rewind, play differently, and the world follows the new branch", async () => {
    const initial = await loadCommitted();
    const full = runScript(initial, DEMO_SCRIPT);

    const back = rewind(initial, full.journal, 5);
    const diverged = takeTurn(back.state, { type: "rest", kind: "long" });

    expect(diverged.ok).toBe(true);
    expect(diverged.state.meta.turn).toBe(6);
    expect(diverged.state.world.world_minute).toBeGreaterThan(back.state.world.world_minute);
  });

  it("counts back from the present with rewindBy", async () => {
    const initial = await loadCommitted();
    const full = runScript(initial, DEMO_SCRIPT);

    const top = full.journal.filter((e) => e.derived_from === null).length;
    expect(highestTurn(full.journal)).toBe(top);
    expect(rewindBy(initial, full.journal, 5).toTurn).toBe(top - 5);
    expect(rewindBy(initial, full.journal, 999).toTurn).toBe(0);
  });

  it("refuses a negative turn rather than doing something surprising", async () => {
    const initial = await loadCommitted();
    const full = runScript(initial, DEMO_SCRIPT);
    expect(() => rewind(initial, full.journal, -1)).toThrow(RangeError);
  });
});

describe("the timeline view", () => {
  it("describes every turn in a form a player could choose from", async () => {
    const initial = await loadCommitted();
    const full = runScript(initial, DEMO_SCRIPT);
    const rows = timeline(full.journal);

    expect(rows.length).toBe(full.journal.filter((e) => e.derived_from === null).length);
    expect(rows[0]!.turn).toBe(1);
    for (const r of rows) {
      expect(r.summary.length).toBeGreaterThan(0);
      expect(r.cascades).toBeGreaterThanOrEqual(0);
    }
    // The turn that killed the bonepicker should show the cascade it set off.
    expect(rows.some((r) => r.cascades > 0)).toBe(true);
  });

  it("summarises an attack with its outcome", async () => {
    const initial = await loadCommitted();
    const full = runScript(initial, DEMO_SCRIPT);
    const attacks = timeline(full.journal).filter((r) => r.type === "attack");
    expect(attacks.length).toBeGreaterThan(0);
    expect(attacks[0]!.summary).toMatch(/hit for \d+|miss/);
  });
});
