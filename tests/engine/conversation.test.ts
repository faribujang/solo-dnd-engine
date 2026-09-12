import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { takeTurn } from "../../src/engine/session.js";
import { pressOutcome, readApproaches, topicsFor, wouldWalkAway, FRICTION_LIMIT, type Topic } from "../../src/engine/conversation.js";
import { affordances } from "../../src/rules/affordances.js";
import { buildContext } from "../../src/context/build.js";
import { screen } from "../../src/view/models.js";
import { reduceAll } from "../../src/engine/reduce.js";
import { stable } from "../../src/state/jsonFileStore.js";
import type { GameState } from "../../src/schema/state.js";

const CAMPAIGN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../content/campaign/drowned_bell");
const load = async (): Promise<GameState> => {
  const s = structuredClone(await loadCampaign(CAMPAIGN));
  s.meta.session_zero.dice = "committed";
  return s;
};

describe("topics assemble themselves from state", () => {
  it("offers what you both know about, without a dialogue tree", async () => {
    const s = await load();
    const topics = topicsFor(s, "npc_thorne");

    // Always: the person themselves.
    expect(topics.some((t) => t.kind === "self")).toBe(true);
    // A quest he gives.
    expect(topics.some((t) => t.id === "t_quest_q_thornes_debt")).toBe(true);
    // And nothing was authored to make either of those exist.
    expect(topics.length).toBeGreaterThan(2);
  });

  it("grows as the campaign does — learn something, and there is more to ask", async () => {
    const s = await load();
    const before = topicsFor(s, "npc_mira").length;

    s.facts.push({
      id: "fact_new", turn: 1, world_minute: 1020,
      text: "The bell's inscription names a family that still lives upriver.",
      kind: "lore", subjects: ["npc_garret"], location_id: null, quest_ids: [],
      importance: 3, secret: false, known_by: ["pc_main"], source: "narrator", superseded_by: null, seal: null,
    });

    expect(topicsFor(s, "npc_mira").length).toBeGreaterThan(before);
  });

  it("makes reticence a DC, not a wall — and says so by name", async () => {
    const s = await load();
    // Thorne's debt is his secret and he barely trusts her. That is a HARD ASK, not a
    // refusal: at a real table the d20 is always on the table, and a game that answers
    // "you may not roll" where a DM would say "make it a 17" is the worse game.
    const guarded = topicsFor(s, "npc_mira").filter((t) => t.access.kind === "guarded");
    expect(guarded.length).toBeGreaterThan(0);
    const dcCold = (guarded[0]!.access as { dc: number }).dc;
    expect(guarded[0]!.closed_reason).toMatch(/DC \d+/);

    // Trust does not unlock the topic — it moves the number, visibly and by name.
    s.relationships["npc_mira->pc_main"]!.dims.trust = 60;
    const warm = topicsFor(s, "npc_mira").find((t) => t.id === guarded[0]!.id)!;
    const dcWarm = warm.access.kind === "guarded" ? warm.access.dc : 0;
    expect(dcWarm).toBeLessThan(dcCold);

    // Thorne's debt is the campaign's one real seal, and it names its own key.
    const sealed = topicsFor(s, "npc_thorne").find((t) => t.access.kind === "sealed");
    expect(sealed).toBeDefined();
    expect(sealed!.access.kind === "sealed" && sealed!.access.opens_when).toMatch(/Garret|settled/);
  });

  it("presses a sealed topic for the KEY, never the secret", async () => {
    const s = await load();
    // A seal is the rare case where no total buys it. The schema will not let one exist
    // without naming what would lift it, so pressing one always has somewhere to go.
    const sealed: Topic = {
      id: "t_sealed", kind: "fact", label: "ask about the debt", subject_id: "npc_thorne",
      reveals: ["f_debt"], gated_on_fact: null, asked: false, open: false,
      closed_reason: "he will not discuss his debts",
      access: { kind: "sealed", why: "he will not discuss his debts", opens_when: "his brother is out of the Ashen Hand's book" },
    };

    // Rolling well does not open the door. It shows you where the key is kept — which is
    // a better outcome than most successes, and it is what keeps the d20 alive.
    const crit = pressOutcome(sealed, "critical_success");
    expect(crit.kind).toBe("slip");
    expect(crit.kind === "slip" && crit.lead).toMatch(/Ashen Hand/);

    // Nothing below a critical buys anything but friction.
    expect(pressOutcome(sealed, "success").kind).toBe("refused");
    expect(pressOutcome(sealed, "failure").kind).toBe("refused");

    // A guarded topic, by contrast, yields to any success — including the cost band.
    const guarded: Topic = { ...sealed, access: { kind: "guarded", dc: 15, why: "barely knows you", skill: "persuasion" } };
    expect(pressOutcome(guarded, "success_at_cost").kind).toBe("told");
    expect(pressOutcome(guarded, "failure").kind).toBe("deflected");
  });

  it("remembers what you already asked", async () => {
    let s = await load();
    const first = topicsFor(s, "npc_thorne").find((t) => t.kind === "self")!;
    expect(first.asked).toBe(false);

    s = takeTurn(s, { type: "talk", target_id: "npc_thorne", topic_id: first.id }).state;
    expect(topicsFor(s, "npc_thorne").find((t) => t.id === first.id)!.asked).toBe(true);
  });
});

describe("talking is a state, not a one-shot", () => {
  it("entering a conversation records who, and what they want", async () => {
    const s = await load();
    const out = takeTurn(s, { type: "talk", target_id: "npc_thorne", topic: "the bell" });
    expect(out.ok).toBe(true);
    expect(out.state.conversation?.with_id).toBe("npc_thorne");
    // His agenda comes from his own goal and flaw, not from a script.
    expect(out.state.conversation?.their_agenda).toMatch(/They want|weakness/i);
  });

  it("walking out ends it", async () => {
    let s = await load();
    s = takeTurn(s, { type: "talk", target_id: "npc_thorne" }).state;
    expect(s.conversation).not.toBeNull();
    s = takeTurn(s, { type: "move", dir: "out" }).state;
    expect(s.conversation).toBeNull();
  });

  it("pressing the same subject raises friction, and they can end it", async () => {
    let s = await load();
    const t = topicsFor(s, "npc_thorne").find((x) => x.kind === "self")!;
    for (let i = 0; i < FRICTION_LIMIT + 2; i++) {
      const out = takeTurn(s, { type: "talk", target_id: "npc_thorne", topic_id: t.id });
      if (!out.ok) {
        expect(out.message).toMatch(/had enough/);
        return;
      }
      s = out.state;
    }
    expect(wouldWalkAway(s.conversation)).toBe(true);
  });

  it("what they know becomes what you know, when they are willing", async () => {
    let s = await load();
    // She has to think you are worth telling. That is the gate, and it is trust — not a roll.
    s.relationships["npc_mira->pc_main"]!.dims.trust = 30;
    s = takeTurn(s, { type: "move", dir: "out" }).state;   // she is out in the lane
    // fact_seed_0003 is Mira's, not secret, and Vessa does not have it.
    expect(s.entities["pc_main"]!.known_fact_ids).not.toContain("fact_seed_0003");
    const topic = topicsFor(s, "npc_mira").find((t) => t.reveals.includes("fact_seed_0003"));
    expect(topic, "she should have something to tell").toBeDefined();

    const out = takeTurn(s, { type: "talk", target_id: "npc_mira", topic_id: topic!.id });
    expect(out.ok).toBe(true);
    expect(out.state.entities["pc_main"]!.known_fact_ids).toContain("fact_seed_0003");
  });
});

describe("a check that cannot work is not offered as a roll", () => {
  it("reads what each approach would actually achieve", async () => {
    const s = await load();
    const reads = readApproaches(s, "npc_thorne");
    expect(reads.map((r) => r.approach)).toEqual(["persuade", "deceive", "intimidate"]);
    for (const r of reads) expect(r.stakes.length).toBeGreaterThan(0);
  });

  it("greys intimidation on someone already terrified, with the reason", async () => {
    const s = await load();
    s.relationships["npc_thorne->pc_main"]!.dims.fear = 70;
    const bar = affordances(s).find((a) => a.action.type === "skill_check" && a.action.skill === "intimidation" && a.action.target_id === "npc_thorne");
    expect(bar!.available).toBe(false);
    expect(bar!.why_unavailable).toMatch(/already frightened/);
  });

  it("greys persuasion on someone past reasoning with", async () => {
    const s = await load();
    s.relationships["npc_thorne->pc_main"]!.dims.affinity = -80;
    const bar = affordances(s).find((a) => a.action.type === "skill_check" && a.action.skill === "persuasion" && a.action.target_id === "npc_thorne");
    expect(bar!.available).toBe(false);
    expect(bar!.why_unavailable).toMatch(/past being reasoned with/);
  });
});

describe("the narrator is told it is in a conversation", () => {
  it("gets their agenda and what is still unsaid, but not a script", async () => {
    let s = await load();
    s = takeTurn(s, { type: "talk", target_id: "npc_thorne" }).state;
    const ctx = buildContext(s);
    expect(ctx.user).toContain("IN CONVERSATION WITH THORNE BLACKWATER");
    expect(ctx.user).toMatch(/Still unsaid|They want/);
  });

  it("is told what they are hiding, AND told not to say it", async () => {
    let s = await load();
    s = takeTurn(s, { type: "talk", target_id: "npc_thorne" }).state;
    const ctx = buildContext(s);

    // The DM needs the secret to deflect convincingly — an NPC changing the subject only
    // reads as evasion if the writer knows what is being evaded.
    expect(ctx.user).toContain("KNOWS BUT WILL NOT TELL YOU");
    expect(ctx.user).toContain("Deflect if asked");
    expect(ctx.system).toMatch(/knowing something is not permission to say it/i);

    // And it never reaches the player's own canon.
    const canonSection = ctx.user.split("## SCENE")[0]!;
    expect(canonSection).not.toContain("owes the Ashen Hand");
  });

  it("stops withholding once they trust you", async () => {
    let s = await load();
    s.relationships["npc_thorne->pc_main"]!.dims.trust = 60;
    s = takeTurn(s, { type: "talk", target_id: "npc_thorne" }).state;
    expect(buildContext(s).user).not.toContain("KNOWS BUT WILL NOT TELL YOU");
  });
});

describe("the client gets the conversation too", () => {
  it("exposes who, their disposition, the topics and the friction", async () => {
    let s = await load();
    expect(screen(s).conversation).toBeNull();
    s = takeTurn(s, { type: "talk", target_id: "npc_thorne" }).state;
    const c = screen(s).conversation!;
    expect(c.with.name).toBe("Thorne Blackwater");
    expect(c.with.disposition).toBeTypeOf("string");
    expect(c.topics.length).toBeGreaterThan(0);
    expect(c.friction).toBe(0);
  });
});

describe("conversations replay exactly", () => {
  it("a session of talking reproduces byte-for-byte", async () => {
    const initial = await load();
    let s = initial;
    const journal = [];
    for (const a of [
      { type: "talk" as const, target_id: "npc_thorne" },
      { type: "talk" as const, target_id: "npc_thorne", topic_id: "t_self_npc_thorne" },
      { type: "move" as const, dir: "out" },
      { type: "talk" as const, target_id: "npc_mira" },
    ]) {
      const out = takeTurn(s, a);
      s = out.state;
      journal.push(...out.journal);
    }
    const roots = journal.filter((e) => e.derived_from === null);
    expect(stable(reduceAll(initial, roots).state)).toBe(stable(s));
  });
});
