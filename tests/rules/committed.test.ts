import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { runScript, takeTurn } from "../../src/engine/session.js";
import { rewind } from "../../src/engine/rollback.js";
import { DEMO_SCRIPT } from "../../src/content/demoScript.js";
import { seedFor } from "../../src/rules/rng.js";

const CAMPAIGN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../content/campaign/drowned_bell");

/** These tests are about the `committed` mode specifically. */
async function committed() {
  const s = structuredClone(await loadCampaign(CAMPAIGN));
  s.meta.session_zero.dice = "committed";
  return s;
}

/**
 * Committed dice: rewinding cannot reroll a check.
 */
describe("committed dice", () => {
  it("the same check on the same turn after a rewind gives the identical die", async () => {
    const initial = await committed();
    const played = runScript(initial, DEMO_SCRIPT.slice(0, 10));

    // Turn 11 is a persuasion check in the demo script. Roll it once.
    const first = takeTurn(played.state, { type: "skill_check", skill: "persuasion", band: "medium", target_id: "npc_mira" });
    const raw1 = first.journal[0]!.rolls[0]!.raw;

    // Rewind to turn 10 and roll the identical check again. No amount of reloading changes it.
    const back = rewind(initial, played.journal, 10);
    const second = takeTurn(back.state, { type: "skill_check", skill: "persuasion", band: "medium", target_id: "npc_mira" });
    expect(second.journal[0]!.rolls[0]!.raw).toBe(raw1);
  });

  it("relabelling the same attempt with a different tag does not fish for a new die", async () => {
    const initial = await committed();
    const a = takeTurn(initial, { type: "skill_check", skill: "investigation", band: "medium", tag: "search" });
    const b = takeTurn(initial, { type: "skill_check", skill: "investigation", band: "medium", tag: "look_closely" });
    expect(a.journal[0]!.rolls[0]!.raw).toBe(b.journal[0]!.rolls[0]!.raw);
  });

  it("a genuinely different approach draws a fresh die", async () => {
    const initial = await committed();
    // Same turn, different skill. Different situation → independent generator. Over a few
    // different bands and skills at least one must differ, or the hash is broken.
    const rolls = new Set<number>();
    for (const skill of ["stealth", "perception", "persuasion", "athletics", "insight"] as const) {
      rolls.add(takeTurn(initial, { type: "skill_check", skill, band: "medium" }).journal[0]!.rolls[0]!.raw);
    }
    expect(rolls.size).toBeGreaterThan(1);
  });

  it("a different turn draws a fresh die for the same action", async () => {
    const initial = await committed();
    const rolls = new Set<number>();
    let s = initial;
    for (let i = 0; i < 8; i++) {
      const out = takeTurn(s, { type: "skill_check", skill: "perception", band: "medium" });
      rolls.add(out.journal[0]!.rolls[0]!.raw);
      s = out.state;
    }
    expect(rolls.size).toBeGreaterThan(1);
  });

  it("an explicit reroll (attempt+1) is a fresh die — that is a rule, not an exploit", () => {
    const a = seedFor("seed", 5, "pc_main", "check:stealth", 0);
    const b = seedFor("seed", 5, "pc_main", "check:stealth", 1);
    expect(a).not.toBe(b);
    expect(seedFor("seed", 5, "pc_main", "check:stealth", 0)).toBe(a);
  });
});
