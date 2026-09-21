import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { buildContext } from "../../src/context/build.js";
import { pc } from "../../src/state/selectors.js";
import { scoreFacts, selectFacts } from "../../src/context/selectFacts.js";
import type { GameState } from "../../src/schema/state.js";

const CAMPAIGN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../content/campaign/drowned_bell",
);

let cached: GameState;
const load = async () => (cached ??= await loadCampaign(CAMPAIGN));
const fresh = async () => structuredClone(await load());

describe("the context builder", () => {
  it("is deterministic — same state, same prompt", async () => {
    const s = await fresh();
    expect(buildContext(s).user).toBe(buildContext(s).user);
  });

  it("carries no conversation history: the prompt is rebuilt from state alone", async () => {
    const s = await fresh();
    const a = buildContext(s, { recent: ["> earlier thing", "some prose"] });
    const b = buildContext(s);
    // Removing the caller's transcript changes only the RECENT section. Nothing else in
    // the prompt remembers anything, which is what makes drift impossible.
    expect(a.sections.find((x) => x.id === "canon")!.body)
      .toBe(b.sections.find((x) => x.id === "canon")!.body);
    expect(b.sections.some((x) => x.id === "recent")).toBe(false);
  });

  it("stays inside its token budget and reports what it shed", async () => {
    const s = await fresh();
    const huge = Array.from({ length: 200 }, (_, i) => `Turn ${i}: a long line of remembered prose about the room and everyone in it.`);
    // The budget trims SECTIONS; the system prompt is fixed overhead it cannot touch.
    // So the stress budget has to leave room for it, or this asserts that a ~2,200-token
    // instruction set fits in 2,500 tokens alongside a scene, which is not a real test.
    // tests/context/prompt-size.test.ts is what guards the overhead itself.
    const ctx = buildContext(s, { recent: huge, maxTokens: 4000 });

    expect(ctx.totalTokens).toBeLessThanOrEqual(4100);
    expect(ctx.shed).toContain("recent");
  });

  it("sheds whole lines, never half an object", async () => {
    const s = await fresh();
    const huge = Array.from({ length: 300 }, (_, i) => `Turn ${i}: prose.`);
    const ctx = buildContext(s, { recent: huge, maxTokens: 2000 });
    const recent = ctx.sections.find((x) => x.id === "recent");
    if (recent) {
      for (const line of recent.body.split("\n")) {
        expect(line).toMatch(/^Turn \d+: prose\.$/);
      }
    }
  });

  it("never sheds the resolved mechanics, however tight the budget", async () => {
    const s = await fresh();
    const ctx = buildContext(s, {
      mechanics: "stealth (DC 13): d20 4+7 = 11 — FAILURE.",
      recent: Array.from({ length: 400 }, () => "noise noise noise noise noise"),
      maxTokens: 900,
    });
    const mech = ctx.sections.find((x) => x.id === "mechanics");
    expect(mech?.body).toContain("FAILURE");
  });

  it("puts CANON before everything else in the prompt", async () => {
    const s = await fresh();
    const ctx = buildContext(s);
    expect(ctx.user.indexOf("## CANON")).toBeGreaterThanOrEqual(0);
    expect(ctx.user.indexOf("## CANON")).toBeLessThan(ctx.user.indexOf("## SCENE"));
  });

  it("tells the model, in the system prompt, that it may not invent numbers", async () => {
    const s = await fresh();
    const ctx = buildContext(s);
    expect(ctx.system).toMatch(/never state or change a number/i);
    expect(ctx.system).toMatch(/failed roll stays\s+failed/i);
  });
});

describe("what an NPC block reveals", () => {
  it("shows how they feel, in numbers and in prose", async () => {
    const s = await fresh();
    const npcs = buildContext(s).sections.find((x) => x.id === "npcs")!.body;
    expect(npcs).toContain("Thorne Blackwater");
    expect(npcs).toMatch(/affinity 22/);
    expect(npcs).toContain("Watched her grow up behind his bar");
  });

  it("only tells the DM what that NPC actually knows", async () => {
    const s = await fresh();
    const npcs = buildContext(s).sections.find((x) => x.id === "npcs")!.body;

    // Thorne knows about his own debt; the prompt may say so when he is present.
    expect(npcs).toContain("Thorne Blackwater");

    // Garret's secret — that he was posted to watch for Vessa by name — is known only to
    // Garret, who is not in this room. It must not appear anywhere in the prompt.
    expect(buildContext(s).user).not.toContain("told to watch for Vessa Quill by name");
  });
});

describe("fact retrieval", () => {
  it("keeps importance-5 facts even when the budget is nearly zero", async () => {
    const s = await fresh();
    s.facts.push({
      id: "fact_critical", turn: 1, world_minute: 1020,
      text: "The bell must never be rung before midwinter.",
      kind: "lore", subjects: [], location_id: null, quest_ids: [],
      importance: 5, secret: false, known_by: ["pc_main"], source: "authored", superseded_by: null, seal: null,
    });

    const picked = selectFacts(s, {
      presentEntityIds: ["pc_main"], currentLocationId: "loc_flagon",
      activeQuestIds: [], budgetTokens: 1, currentTurn: 5,
    });
    expect(picked.map((p) => p.fact.id)).toContain("fact_critical");
  });

  it("hides a secret from anyone who has not learned it", async () => {
    const s = await fresh();
    const asPc = selectFacts(s, {
      presentEntityIds: ["pc_main", "npc_garret"], currentLocationId: "loc_bell_gate",
      activeQuestIds: [], budgetTokens: 4000, currentTurn: 1,
    });
    // fact_seed_0004 is Garret's secret and known_by lists only Garret.
    expect(asPc.map((p) => p.fact.id)).not.toContain("fact_seed_0004");

    const asGarret = selectFacts(s, {
      presentEntityIds: ["pc_main", "npc_garret"], currentLocationId: "loc_bell_gate",
      activeQuestIds: [], budgetTokens: 4000, currentTurn: 1, knowerId: "npc_garret",
    });
    expect(asGarret.map((p) => p.fact.id)).toContain("fact_seed_0004");
  });

  it("ranks a fact about someone in the room above an equally important one that is not", async () => {
    const s = await fresh();
    const common = {
      turn: 2, world_minute: 1020, kind: "npc" as const, location_id: null,
      quest_ids: [], importance: 3, secret: false, known_by: ["pc_main"],
      source: "authored" as const, superseded_by: null, seal: null,
    };
    // Identical in every respect except who they are about, so the only thing that can
    // separate them is presence.
    s.facts.push({ ...common, id: "fact_here", text: "He keeps a second ledger.", subjects: ["npc_thorne"] });
    s.facts.push({ ...common, id: "fact_away", text: "She keeps a second ledger.", subjects: ["npc_mira"] });

    const scored = scoreFacts(s, {
      presentEntityIds: ["pc_main", "npc_thorne"], currentLocationId: "loc_flagon",
      activeQuestIds: [], budgetTokens: 4000, currentTurn: 3,
    });

    const here = scored.find((x) => x.fact.id === "fact_here")!;
    const away = scored.find((x) => x.fact.id === "fact_away")!;

    expect(here.score).toBeGreaterThan(away.score);
    expect(here.because.join()).toContain("about someone present");
    expect(away.because.join()).not.toContain("about someone present");
  });

  it("never returns a superseded fact", async () => {
    const s = await fresh();
    s.facts[0]!.superseded_by = "fact_seed_0002";
    const picked = selectFacts(s, {
      presentEntityIds: ["pc_main"], currentLocationId: "loc_flagon",
      activeQuestIds: [], budgetTokens: 4000, currentTurn: 1,
    });
    expect(picked.map((p) => p.fact.id)).not.toContain(s.facts[0]!.id);
  });

  it("reads oldest first, so canon tells the story in order", async () => {
    const s = await fresh();
    const picked = selectFacts(s, {
      presentEntityIds: ["pc_main", "npc_thorne"], currentLocationId: "loc_flagon",
      activeQuestIds: [], budgetTokens: 4000, currentTurn: 10,
    });
    const turns = picked.map((p) => p.fact.turn);
    expect([...turns].sort((a, b) => a - b)).toEqual(turns);
  });
});

describe("shedding drops whole items, never half of one", () => {
  it("never leaves a fragment whose first line reads as a whole entry", async () => {
    const s = await fresh();
    // Crowd the room. A village green with a family in it overruns the NPC budget, which is
    // the ordinary case rather than a pathological one.
    const here = pc(s).location_id;
    for (const e of Object.values(s.entities)) {
      if (e.id !== s.meta.pc_id) e.location_id = here;
    }
    for (let i = 0; i < 12; i++) {
      const clone = structuredClone(s.entities["npc_thorne"]!);
      clone.id = `npc_filler_${String(i).padStart(2, "0")}`;
      clone.name = `Filler ${i}`;
      clone.location_id = here;
      s.entities[clone.id] = clone;
    }

    const ctx = buildContext(s, { maxTokens: 1800 });
    const npcs = ctx.sections.find((x) => x.id === "npcs");
    if (!npcs) return;                       // shed entirely is a legal outcome

    // Every line that is not indented must be an entry head. A stray continuation line at
    // the front gets trimmed by whoever reads the block and then reads as a person — which
    // is exactly how the DM once narrated a private fact as somebody standing in the room.
    for (const line of npcs.body.split("\n")) {
      if (line === "" || line.startsWith("  ")) continue;
      expect(line, `"${line.slice(0, 60)}" is a fragment, not an entry`).toMatch(/ — /);
    }
    expect(npcs.body.split("\n")[0]).not.toMatch(/^(Knows|Voice|Traits|Flaw|Feels|Their view)/);
  });

  it("keeps whole entries rather than trimming every one of them", async () => {
    const s = await fresh();
    const full = buildContext(s).sections.find((x) => x.id === "npcs");
    const tight = buildContext(s, { maxTokens: 1500 }).sections.find((x) => x.id === "npcs");
    if (!full || !tight) return;
    // Whatever survives should be as complete as it was before the budget bit.
    const heads = (b: string) => b.split("\n").filter((l) => l !== "" && !l.startsWith("  ")).length;
    expect(heads(tight.body)).toBeLessThanOrEqual(heads(full.body));
    expect(tight.body.split("\n")[0]).toMatch(/ — /);
  });
});
