import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { takeTurn } from "../../src/engine/session.js";
import { topicsFor } from "../../src/engine/conversation.js";
import { arrivalStanding } from "../../src/rules/reputation.js";
import { BACKGROUND_SOCIAL, insightsFor, socialTagsOf, backgroundOf } from "../../src/rules/backgrounds.js";
import { BACKGROUNDS } from "../../src/content/srd/data.js";
import { buildContext } from "../../src/context/build.js";
import type { GameState } from "../../src/schema/state.js";

const CAMPAIGN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../content/campaign/drowned_bell");
const load = async (): Promise<GameState> => {
  const s = structuredClone(await loadCampaign(CAMPAIGN));
  s.meta.session_zero.dice = "committed";
  return s;
};

describe("where you came from", () => {
  it("gives every playable background a social profile", () => {
    // A background with mechanics but no social reading is the thing this file exists to
    // fix. If one is added to the SRD table it needs a row here too.
    for (const id of Object.keys(BACKGROUNDS)) {
      expect(BACKGROUND_SOCIAL[id], `${id} has no social profile`).toBeDefined();
      expect(BACKGROUND_SOCIAL[id]!.standing.length).toBeGreaterThan(0);
    }
  });

  it("reads the same past differently depending on who is reading it", async () => {
    const s = await load();
    expect(backgroundOf(s.entities["pc_main"]!)).toBe("bg_criminal");

    // Garret is the Hand's man; Mira reads for a living. The same history is a credential
    // to one and a warning to the other, and both are correct.
    const toFence = arrivalStanding(s, s.entities["npc_garret"]!);
    expect(toFence.trust).toBeGreaterThan(0);
    expect(toFence.reasons.join(" ")).toMatch(/same trade/);

    // And a lawful reading of the same person goes the other way.
    const guard = structuredClone(s.entities["npc_garret"]!);
    guard.flags["social_tags"] = ["lawful"];
    expect(arrivalStanding(s, guard).trust).toBeLessThan(0);
  });

  it("leaves untagged people neutral, so backgrounds stay opt-in for an author", async () => {
    const s = await load();
    const nobody = structuredClone(s.entities["npc_garret"]!);
    nobody.flags["social_tags"] = [];
    nobody.faction_ids = [];
    const st = arrivalStanding(s, nobody);
    expect(st.affinity).toBe(0);
    expect(st.trust).toBe(0);
  });

  it("ignores social tags that are not in the vocabulary", async () => {
    const s = await load();
    const e = structuredClone(s.entities["npc_garret"]!);
    e.flags["social_tags"] = ["criminal", "wizard-ish", 42];
    expect(socialTagsOf(e)).toEqual(["criminal"]);
  });
});

describe("lines only you can say", () => {
  it("offers an insight as a topic, and only to the right sort of person", async () => {
    const s = await load();
    s.entities["npc_garret"]!.location_id = s.entities["pc_main"]!.location_id;

    // An outlaw talking to the Hand's man has something to work with.
    const withFence = topicsFor(s, "npc_garret").filter((t) => t.kind === "insight");
    expect(withFence.length).toBeGreaterThan(0);
    expect(withFence[0]!.label).toMatch(/^\[CRIMINAL\]/);
    // It is not a check. You are not rolling to know your own past.
    expect(withFence[0]!.access.kind).toBe("open");

    // The scholar is not in that world, so the door simply is not there.
    const withScholar = topicsFor(s, "npc_mira").filter((t) => t.kind === "insight");
    expect(withScholar).toHaveLength(0);
  });

  it("buys common ground, then will not be played twice", async () => {
    let s = await load();
    s.entities["npc_garret"]!.location_id = s.entities["pc_main"]!.location_id;

    const before = s.relationships["npc_garret->pc_main"]?.dims.trust ?? 0;
    const topic = topicsFor(s, "npc_garret").find((t) => t.kind === "insight")!;

    const out = takeTurn(s, { type: "talk", target_id: "npc_garret", topic_id: topic.id });
    expect(out.ok).toBe(true);
    s = out.state;

    // Trust, through the ordinary path — which is what moves every DC in the conversation.
    // An insight is not a special-case bonus that only backgrounds get.
    expect(s.relationships["npc_garret->pc_main"]!.dims.trust).toBeGreaterThan(before);

    // The moment of recognition is the point. One you can repeat is a button, not a beat.
    expect(topicsFor(s, "npc_garret").some((t) => t.id === topic.id)).toBe(false);
    expect(insightsFor(s, s.entities["npc_garret"]!).some((i) => `t_insight_${i.id}` === topic.id)).toBe(false);
  });

  it("charges for the ones that cost something", async () => {
    let s = await load();
    // A noble pulling rank on a commoner works, and the commoner remembers that they did.
    s.entities["pc_main"]!.flags["background_id"] = "bg_noble";
    s.entities["npc_thorne"]!.location_id = s.entities["pc_main"]!.location_id;

    const rank = topicsFor(s, "npc_thorne").find((t) => t.label.includes("pull rank"))!;
    expect(rank).toBeDefined();

    const beforeAff = s.relationships["npc_thorne->pc_main"]!.dims.affinity;
    const out = takeTurn(s, { type: "talk", target_id: "npc_thorne", topic_id: rank.id });
    s = out.state;

    expect(s.relationships["npc_thorne->pc_main"]!.dims.trust).toBeGreaterThan(0);
    expect(s.relationships["npc_thorne->pc_main"]!.dims.affinity).toBeLessThan(beforeAff);
  });

  it("tells the DM the intent, not the mechanic", async () => {
    let s = await load();
    s.entities["npc_garret"]!.location_id = s.entities["pc_main"]!.location_id;
    s = takeTurn(s, { type: "talk", target_id: "npc_garret" }).state;

    const ctx = buildContext(s);
    expect(ctx.user).toContain("WHERE THEY CAME FROM");
    // The prompt must describe what the player is DOING, so the line reads as earned
    // rather than as a menu option fired at an NPC.
    expect(ctx.user).toMatch(/idiom|one of them/i);
    expect(ctx.user).toMatch(/reads socially as/);
  });
});
