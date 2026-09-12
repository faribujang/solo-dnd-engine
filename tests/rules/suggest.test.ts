import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { actionKeyOf, suggest } from "../../src/rules/suggest.js";
import { degreeOf, DEGREE_BRIEF } from "../../src/rules/checks.js";
import { takeTurn } from "../../src/engine/session.js";
import { takeLLMTurn } from "../../src/engine/llmTurn.js";
import { MockLLM } from "../../src/llm/mock.js";

const CAMPAIGN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../content/campaign/drowned_bell");

describe("degrees of success", () => {
  it("grades a check into four bands around the DC", () => {
    expect(degreeOf(20, 15)).toBe("critical_success");   // +5
    expect(degreeOf(15, 15)).toBe("success");
    expect(degreeOf(14, 15)).toBe("success_at_cost");    // −1
    // The near-miss band is FOUR wide, not two. It is where most rolls land, and a game
    // whose middle band is a sliver is pass/fail wearing four labels.
    expect(degreeOf(11, 15)).toBe("success_at_cost");    // −4
    expect(degreeOf(10, 15)).toBe("failure");            // −5, missed by a wide margin
  });

  it("lets a natural 20 move one band up and a natural 1 move one down", () => {
    // Deliberately not RAW. A d20 should never be dead: a 20 against something far out of
    // reach still buys the best outcome available — but it moves ONE step, so it cannot
    // manufacture a clean success out of a hopeless total.
    expect(degreeOf(10, 15, { natural: 20 })).toBe("success_at_cost");   // −5, saved by the die
    expect(degreeOf(15, 15, { natural: 20 })).toBe("critical_success");
    expect(degreeOf(15, 15, { natural: 1 })).toBe("success_at_cost");
    expect(degreeOf(10, 15, { natural: 1 })).toBe("failure");            // already the floor
    expect(degreeOf(30, 15, { natural: 20 })).toBe("critical_success");  // already the ceiling
  });

  it("lets difficulty widen or close the near-miss band", () => {
    expect(degreeOf(11, 15, { costMargin: 6 })).toBe("success_at_cost");  // story
    expect(degreeOf(14, 15, { costMargin: 0 })).toBe("failure");          // ironman: no band
    expect(degreeOf(15, 15, { costMargin: 0 })).toBe("success");
  });

  it("puts the degree on ability checks and never on attacks or damage", async () => {
    const s = await loadCampaign(CAMPAIGN);
    const check = takeTurn(s, { type: "skill_check", skill: "investigation", band: "medium" });
    expect(check.journal[0]!.rolls[0]!.degree).not.toBeNull();

    const fight = takeTurn(s, { type: "attack", target_id: "npc_thorne" });
    for (const r of fight.journal[0]!.rolls) expect(r.degree).toBeNull();
  });

  it("a near miss still gets what the player reached for", async () => {
    // Committed dice so the search below is deterministic rather than flaky.
    const base = structuredClone(await loadCampaign(CAMPAIGN));
    base.meta.session_zero.dice = "committed";

    let found = false;
    let s = base;
    // Walk forward a few turns; each turn deals a different deterministic die, so one of
    // them lands in the two-point window below the DC.
    for (let i = 0; i < 30 && !found; i++) {
      for (const band of ["easy", "medium", "hard", "very_hard"] as const) {
        const r = takeTurn(s, { type: "skill_check", skill: "investigation", band, tag: "search" });
        if (r.journal[0]!.rolls[0]!.degree === "success_at_cost") {
          // The tag records a success, so authored triggers fire; the cost is the
          // narrator's to invent, and it may not touch a number.
          expect(r.journal[0]!.payload["success_search"]).toBe(true);
          expect(r.message).toContain("SUCCESS AT A COST");
          found = true;
          break;
        }
      }
      s = takeTurn(s, { type: "wait", minutes: 1 }).state;
    }
    expect(found).toBe(true);
  });

  it("tells the narrator what each band obliges it to do", () => {
    expect(DEGREE_BRIEF.success_at_cost).toMatch(/AND something goes wrong/);
    expect(DEGREE_BRIEF.failure).toMatch(/never answer with 'nothing happens'/i);
  });
});

describe("suggestion chips", () => {
  it("returns three or four things, all of them actually legal", async () => {
    const s = await loadCampaign(CAMPAIGN);
    const list = suggest(s);
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.length).toBeLessThanOrEqual(4);
    for (const x of list) {
      expect(x.affordance.available).toBe(true);
      expect(takeTurn(s, x.affordance.action).ok, x.fallback).toBe(true);
    }
  });

  it("ranks an unspoken-to NPC above housekeeping", async () => {
    const s = await loadCampaign(CAMPAIGN);
    const list = suggest(s);
    const talk = list.find((x) => x.affordance.action.type === "talk");
    expect(talk, "Thorne has never been spoken to and should be suggested").toBeDefined();
    expect(talk!.because).toContain("they have not spoken to you yet");
    expect(list.some((x) => x.affordance.action.type === "look")).toBe(false);
  });

  it("never suggests attacking someone out of nowhere", async () => {
    const s = await loadCampaign(CAMPAIGN);
    expect(suggest(s).some((x) => x.affordance.action.type === "attack")).toBe(false);
  });

  it("stops suggesting what the player already tried this scene", async () => {
    const s = await loadCampaign(CAMPAIGN);
    const first = suggest(s);
    const tried = first.map((x) => actionKeyOf(x.affordance));
    const second = suggest(s, { triedThisScene: tried });
    // At least one slot turns over rather than repeating the same four.
    expect(second.map((x) => actionKeyOf(x.affordance))).not.toEqual(tried);
  });

  it("keeps the shortlist varied — never four of the same kind", async () => {
    const s = await loadCampaign(CAMPAIGN);
    const counts = new Map<string, number>();
    for (const x of suggest(s)) counts.set(x.affordance.group, (counts.get(x.affordance.group) ?? 0) + 1);
    for (const n of counts.values()) expect(n).toBeLessThanOrEqual(2);
  });

  it("reaches the player even when the model declines to phrase them", async () => {
    const s = await loadCampaign(CAMPAIGN);
    const llm = new MockLLM({ seed: "chips" });
    const out = await takeLLMTurn(llm, s, "look around", {});
    expect(out.suggestedActions.length).toBeGreaterThanOrEqual(2);
    // And the shortlist reached the prompt as instructions, not as invention.
    expect(out.debug.context!.user).toContain("SUGGEST THESE");
  });
});
