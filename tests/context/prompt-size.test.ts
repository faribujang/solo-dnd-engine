import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { buildContext } from "../../src/context/build.js";

const CAMPAIGN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../content/campaign/drowned_bell");

/**
 * The system prompt is FIXED OVERHEAD, paid on every single turn.
 *
 * Nothing sheds it. The budget trims the sections below it, so every token added here is
 * a token taken from the facts, the scene and what the player just said — and it is
 * bought with cash on every request besides. It grew from ~1,900 to 2,621 tokens in a
 * single day of adding rules, and the first thing that noticed was a budget test failing
 * for what looked like an unrelated reason.
 *
 * So it gets a ceiling. This is not a performance micro-optimisation; it is a forcing
 * function. Going over means saying the new rule more briefly, or deciding it is worth
 * more than the rule it displaces — either is fine, and both should be deliberate.
 */
const CEILING_TOKENS = 2400;

describe("the system prompt", () => {
  it("stays under its ceiling, because nothing can shed it", async () => {
    const s = await loadCampaign(CAMPAIGN);
    const ctx = buildContext(s, { recent: [], maxTokens: 6000 });
    const tokens = Math.ceil(ctx.system.length / 4);

    // Printed either way: the number is the point, not just the pass.
    console.log(`system prompt: ~${tokens} tokens of ${CEILING_TOKENS}`);
    expect(tokens).toBeLessThanOrEqual(CEILING_TOKENS);
  });

  it("says the things the rest of the system depends on it saying", async () => {
    const s = await loadCampaign(CAMPAIGN);
    const { system } = buildContext(s, { recent: [], maxTokens: 6000 });

    // Each of these is load-bearing for a fix that cost a playthrough to find. A trim
    // that drops one of them silently is the failure this test exists to catch.
    for (const rule of ["introduce_local", "introduce_place", "introduce_feature", "suggested_actions", "new_thread", "give_item"]) {
      expect(system).toContain(rule);
    }
  });
});
