import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { reduce, reduceAll } from "../../src/engine/reduce.js";
import { takeTurn } from "../../src/engine/session.js";
import { reactionsTo, situationsIn, tierOf, wouldLeave } from "../../src/rules/approval.js";
import { leversOf, DIFFICULTY } from "../../src/rules/difficulty.js";
import { inspirationOf } from "../../src/rules/inspiration.js";
import { findPath, reachable } from "../../src/engine/pathfind.js";
import { buyPrice, formatCoin, sellPrice } from "../../src/rules/economy.js";
import { campaignComplete, planSuccession } from "../../src/engine/succession.js";
import { lintThreeClues, validateGenerated } from "../../src/content/generate.js";
import { mapModel, palette, screen, sheetModel, timelineModel } from "../../src/view/models.js";
import { flatten, linkText } from "../../src/view/link.js";
import { Rng, seedToState } from "../../src/rules/rng.js";
import { stable } from "../../src/state/jsonFileStore.js";
import { rootEvent } from "../helpers/world.js";
import type { GameState } from "../../src/schema/state.js";

const CAMPAIGN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../content/campaign/drowned_bell");
const load = async (): Promise<GameState> => {
  const s = structuredClone(await loadCampaign(CAMPAIGN));
  s.meta.session_zero.dice = "committed";
  return s;
};

// ═══════════════════════════════════════════════════════════ PHASE 5: PARTY

describe("phase 5: companions are people, not a policy", () => {
  it("two companions watch the same act and disagree about it", async () => {
    const s = await load();
    // Put Garret in the party too, so both witness the same thing.
    s.meta.party_ids = ["pc_main", "cmp_sela", "npc_garret"];
    s.entities["npc_garret"]!.kind = "companion";
    s.entities["npc_garret"]!.location_id = "loc_flagon";

    const ev = rootEvent("skill_check", [], {
      actor_id: "pc_main", location_id: "loc_flagon",
      payload: { skill: "intimidation", outcome: "success" },
      witnesses: ["cmp_sela", "npc_garret"],
    });

    const reactions = reactionsTo(s, ev);
    const sela = reactions.find((r) => r.companion_id === "cmp_sela")!;
    const garret = reactions.find((r) => r.companion_id === "npc_garret")!;

    // The asymmetry IS the feature: leaning on someone costs you with the priest and
    // earns you the guard's respect.
    expect(sela.dims.affinity!).toBeLessThan(0);
    expect(garret.dims.respect!).toBeGreaterThan(0);
  });

  it("only companions who were there form an opinion", async () => {
    const s = await load();
    s.entities["cmp_sela"]!.location_id = "loc_lane";   // elsewhere
    const ev = rootEvent("skill_check", [], {
      actor_id: "pc_main", location_id: "loc_flagon",
      payload: { skill: "deception", outcome: "success" }, witnesses: [],
    });
    expect(reactionsTo(s, ev)).toHaveLength(0);
  });

  it("reads situations off the event rather than asking the narrator", async () => {
    const s = await load();
    s.entities["mon_bonepicker"]!.flags["surrendered"] = true;
    const kill = rootEvent("death", [], {
      location_id: "loc_bell_crypt", payload: { entity_id: "mon_bonepicker" },
    });
    expect(situationsIn(s, kill)).toContain("killed_surrendered");

    const fair = rootEvent("death", [], {
      location_id: "loc_bell_crypt", payload: { entity_id: "npc_garret" },
    });
    expect(situationsIn(s, fair)).toContain("killed_creature");
  });

  it("approval moves through the reducer and shows as a tier, not a number", async () => {
    let s = await load();
    const before = tierOf(s, "cmp_sela");
    for (let i = 0; i < 6; i++) {
      s = reduce(s, rootEvent("skill_check", [], {
        id: `evt_r000${i + 1}`, turn: i + 1, actor_id: "pc_main", location_id: "loc_flagon",
        payload: { skill: "intimidation", outcome: "success" }, witnesses: ["cmp_sela"],
      })).state;
    }
    expect(tierOf(s, "cmp_sela")).not.toBe(before);
    expect(typeof tierOf(s, "cmp_sela")).toBe("string");
  });

  it("a companion pushed far enough would leave", async () => {
    const s = await load();
    s.relationships["cmp_sela->pc_main"] = {
      subject: "cmp_sela", object: "pc_main",
      dims: { affinity: -60, trust: -40, fear: 0, respect: 0 }, opinion: "", tags: [], history: [],
    };
    expect(wouldLeave(s, "cmp_sela")).toBe(true);
  });
});

describe("phase 5: inspiration", () => {
  it("is granted, capped by difficulty, and once per scene", async () => {
    let s = await load();
    expect(inspirationOf(s.entities["pc_main"]!)).toBe(0);

    s = reduce(s, rootEvent("effect", [{ t: "grant_inspiration", entity_id: "pc_main", reason: "flaw" }])).state;
    expect(inspirationOf(s.entities["pc_main"]!)).toBe(1);

    // Twice in the same scene is once.
    s = reduce(s, rootEvent("effect", [{ t: "grant_inspiration", entity_id: "pc_main", reason: "bond" }], { id: "evt_r0002", turn: 2 })).state;
    expect(inspirationOf(s.entities["pc_main"]!)).toBe(1);

    s.world.scene_id = "scene_0002";
    s = reduce(s, rootEvent("effect", [{ t: "grant_inspiration", entity_id: "pc_main", reason: "ideal" }], { id: "evt_r0003", turn: 3 })).state;
    expect(inspirationOf(s.entities["pc_main"]!)).toBe(2);   // normal difficulty caps at 2

    s.world.scene_id = "scene_0003";
    s = reduce(s, rootEvent("effect", [{ t: "grant_inspiration", entity_id: "pc_main", reason: "ideal" }], { id: "evt_r0004", turn: 4 })).state;
    expect(inspirationOf(s.entities["pc_main"]!)).toBe(2);   // capped
  });
});

describe("phase 5: difficulty actually does something", () => {
  it("moves DCs, karma, inspiration and what happens when you die", () => {
    expect(DIFFICULTY.story.dc_shift).toBeLessThan(DIFFICULTY.hard.dc_shift);
    expect(DIFFICULTY.story.inspiration_cap).toBeGreaterThan(DIFFICULTY.ironman.inspiration_cap);
    expect(DIFFICULTY.ironman.karmic_strength).toBe(0);
    expect(DIFFICULTY.ironman.rewind_allowed).toBe(false);
    expect(DIFFICULTY.ironman.death_options).toContain("permadeath");
    expect(DIFFICULTY.story.death_options).not.toContain("permadeath");
  });

  it("a story-mode DC is easier than an ironman one for the same band", async () => {
    const easy = await load(); easy.meta.session_zero.difficulty = "story";
    const hard = await load(); hard.meta.session_zero.difficulty = "ironman";
    const a = takeTurn(easy, { type: "skill_check", skill: "investigation", band: "medium" });
    const b = takeTurn(hard, { type: "skill_check", skill: "investigation", band: "medium" });
    expect(a.journal[0]!.rolls[0]!.target!).toBeLessThan(b.journal[0]!.rolls[0]!.target!);
    expect(leversOf(easy).dc_shift).toBe(-2);
  });
});

// ═════════════════════════════════════════════════════════ PHASE 6: WORLD

describe("phase 6: getting around", () => {
  it("finds a route over discovered ground and costs the real time", async () => {
    const s = await load();
    s.locations["loc_bell_gate"]!.discovered = true;
    const p = findPath(s, "loc_flagon", "loc_bell_gate");
    expect(p).not.toBeNull();
    expect(p!.nodes).toEqual(["loc_flagon", "loc_lane", "loc_bell_gate"]);
    expect(p!.minutes).toBe(13);     // 1 out + 12 down
  });

  it("never routes through the undiscovered or a locked door", async () => {
    const s = await load();
    // The crypt is undiscovered and behind both a lock and a hidden stair.
    expect(findPath(s, "loc_flagon", "loc_bell_crypt")).toBeNull();
  });

  it("routes through a scramble but records it, so travel still has to be earned", async () => {
    const s = await load();
    s.locations["loc_bell_gate"]!.discovered = true;
    const p = findPath(s, "loc_flagon", "loc_bell_gate")!;
    expect(p.checks).toHaveLength(1);
    expect(p.checks[0]!.skill).toBe("athletics");
  });

  it("travel spends the time and can be interrupted", async () => {
    const s = await load();
    s.locations["loc_bell_gate"]!.discovered = true;
    const out = takeTurn(s, { type: "travel", location_id: "loc_bell_gate" });
    expect(out.ok).toBe(true);
    expect(out.state.entities["pc_main"]!.location_id).toBe("loc_bell_gate");
    expect(out.state.world.world_minute).toBe(s.world.world_minute + 13);
    expect((out.journal[0]!.payload as { route: string[] }).route).toContain("loc_lane");
  });

  it("refuses to travel somewhere you have not found", async () => {
    const s = await load();
    const out = takeTurn(s, { type: "travel", location_id: "loc_bell_crypt" });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/have not found/);
  });

  it("lists only reachable places", async () => {
    const s = await load();
    const list = reachable(s, "loc_flagon");
    expect(list.map((r) => r.id)).toEqual(["loc_lane"]);
  });
});

describe("phase 6: money", () => {
  it("prices move with how a merchant feels about you", async () => {
    const s = await load();
    const def = s.item_defs["item_def_healing_draught"]!;
    const base = buyPrice(s, "npc_mira", def);

    s.relationships["npc_mira->pc_main"]!.dims.affinity = 80;
    expect(buyPrice(s, "npc_mira", def)).toBeLessThan(base);

    s.relationships["npc_mira->pc_main"]!.dims.affinity = -80;
    expect(buyPrice(s, "npc_mira", def)).toBeGreaterThan(base);
  });

  it("pays less for goods a merchant does not deal in", async () => {
    const s = await load();
    const bell = s.item_defs["item_def_silver_bell"]!;
    expect(sellPrice(s, "npc_mira", bell, ["potion"])).toBeLessThan(sellPrice(s, "npc_mira", bell, ["silver"]));
  });

  it("formats copper as coin", () => {
    expect(formatCoin(0)).toBe("0 cp");
    expect(formatCoin(1234)).toBe("12 gp 3 sp 4 cp");
  });
});

describe("phase 6: what a fight leaves behind", () => {
  it("a dead creature drops what it carried, where it fell", async () => {
    const s = await load();
    s.items["item_inst_spear"] = {
      id: "item_inst_spear", def_id: "item_def_shortsword",
      owner: { t: "entity", id: "npc_garret" }, qty: 1, charges: null,
      attunement: null, nickname: null, condition: "fine", flags: {},
    };
    s.entities["npc_garret"]!.inventory.push("item_inst_spear");

    const out = reduce(s, rootEvent("attack", [
      { t: "damage", entity_id: "npc_garret", amount: 99, damage_type: "slashing" },
    ], { location_id: "loc_bell_gate" })).state;

    expect(out.entities["npc_garret"]!.alive).toBe(false);
    expect(out.items["item_inst_spear"]!.owner).toEqual({ t: "location", id: "loc_bell_gate" });
    expect(out.locations["loc_bell_gate"]!.contains_item_ids).toContain("item_inst_spear");
  });
});

describe("phase 6: clocks tick whether or not you are watching", () => {
  it("advances with the calendar and fires when it fills", async () => {
    let s = await load();
    expect(s.clocks["clk_flood"]!.filled).toBe(0);
    // Four days at one segment a day fills a four-segment clock.
    for (let i = 0; i < 4; i++) {
      s = takeTurn(s, { type: "rest", kind: "long" }).state;   // 480 min
      s = takeTurn(s, { type: "wait", minutes: 720 }).state;
      s = takeTurn(s, { type: "wait", minutes: 240 }).state;
    }
    expect(s.clocks["clk_flood"]!.done).toBe(true);
    expect(s.world.flags["crypt_flooded"]).toBe(true);
  });

  it("a tick is journaled so the player can see it move", async () => {
    const out = reduce(await load(), rootEvent("effect", [{ t: "tick_clock", clock_id: "clk_hand_closes", segments: 2 }]));
    expect(out.state.clocks["clk_hand_closes"]!.filled).toBe(3);
    expect(out.journal.some((e) => e.type === "clock")).toBe(true);
  });
});

describe("items grant verbs", () => {
  it("thieves' tools offer to pick a lock that is actually there", async () => {
    const s = await load();
    s.entities["pc_main"]!.location_id = "loc_bell_gate";
    s.world.flags["crypt_lever_pulled"] = true;         // the locked stair is now visible
    const bar = palette(s).groups.flatMap((g) => g.items);
    const pick = bar.find((a) => a.label.startsWith("Pick the lock"));
    expect(pick, "carrying tools should offer the lock").toBeDefined();
    expect(pick!.detail).toContain("thieves' tools");
  });

  it("and do not offer it where there is no lock", async () => {
    const s = await load();
    const bar = palette(s).groups.flatMap((g) => g.items);
    expect(bar.some((a) => a.label.startsWith("Pick the lock"))).toBe(false);
  });
});

// ═════════════════════════════════════════════════════ PHASE 7: VIEW MODELS

describe("phase 7: the view layer is the client's whole contract", () => {
  it("builds a screen with no game logic left for the UI to do", async () => {
    const v = screen(await load());
    expect(v.scene.location.name).toBe("The Rusty Flagon");
    expect(v.scene.present.map((p) => p.name)).toContain("Thorne Blackwater");
    expect(v.sheet.ac.total).toBe(14);
    expect(v.sheet.ac.parts.map((p) => p.label)).toEqual(["leather armor", "dex"]);
    expect(v.party[0]!.name).toBe("Sela Vance");
    expect(v.party[0]!.tier).toBeTypeOf("string");
    expect(v.palette.groups.length).toBeGreaterThan(0);
  });

  it("shows the character sheet as its computation, not just its result", async () => {
    const sheet = sheetModel(await load());
    expect(sheet.skills.find((x) => x.key === "stealth")!.expertise).toBe(true);
    expect(sheet.skills.find((x) => x.key === "stealth")!.mod).toBe(7);
    expect(sheet.xp.next).toBe(900);        // level 2 → 3
    expect(sheet.inspiration.cap).toBe(2);
    expect(sheet.purse).toBe("12 gp");
  });

  it("draws a map with fog of war — undiscovered places are absent, not greyed", async () => {
    const s = await load();
    const m = mapModel(s);
    expect(m.nodes.map((n) => n.id)).not.toContain("loc_bell_crypt");
    expect(m.nodes.find((n) => n.id === "loc_flagon")!.pins).toContain("player");
    expect(m.nodes.every((n) => n.x !== undefined)).toBe(true);
    expect(m.edges.length).toBeGreaterThan(0);
  });

  it("links names in prose without the narrator emitting markup", async () => {
    const s = await load();
    const spans = linkText(s, "Thorne Blackwater will not look at you, and the Rusty Flagon is very quiet.");
    expect(spans.find((x) => x.ref?.id === "npc_thorne")).toBeDefined();
    expect(spans.find((x) => x.ref?.id === "loc_flagon")).toBeDefined();
    // And round-trips to exactly the prose it was given.
    expect(flatten(spans)).toBe("Thorne Blackwater will not look at you, and the Rusty Flagon is very quiet.");
  });

  it("honours an explicit [[id]] hint from the narrator, and strips an unknown one", async () => {
    const s = await load();
    expect(flatten(linkText(s, "You find [[npc_thorne]] behind the bar."))).toBe("You find Thorne Blackwater behind the bar.");
    expect(flatten(linkText(s, "You find [[npc_nobody]] here."))).toBe("You find npc_nobody here.");
  });

  it("exposes the cascade chain for the history log", async () => {
    let s = await load();
    const out = takeTurn(s, { type: "move", dir: "out" });
    const rows = timelineModel(out.state, out.journal);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.children.some((c) => c.type === "enter_location")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════ PHASE 8: THE CAMPAIGN

describe("phase 8: succession", () => {
  it("knows when a campaign is finished, and does not fire early", async () => {
    const s = await load();
    expect(campaignComplete(s, "cmp_mudwallow")).toBe(false);
    s.quests["q_missing_bell"]!.status = "complete";
    s.arcs["arc_drowned_bell"]!.status = "complete";
    expect(campaignComplete(s, "cmp_mudwallow")).toBe(true);
  });

  it("writes a legacy, ages the world, and promotes what was left open", async () => {
    const s = await load();
    s.quests["q_missing_bell"]!.status = "complete";
    s.world.factions["fac_ashen_hand"]!.rep_with_pc = -60;

    const plan = planSuccession(s, new Rng(seedToState("succ")), { campaignId: "cmp_mudwallow" });

    // The record: what mattered, not everything that happened.
    expect(plan.legacy.length).toBeGreaterThan(0);
    expect(plan.legacy.some((l) => l.text.includes("was seen through"))).toBe(true);
    expect(plan.legacy.some((l) => l.text.includes("Ashen Hand"))).toBe(true);

    // The skip.
    expect(plan.effects.some((e) => e.t === "advance_time")).toBe(true);
    expect(plan.years).toBe(12);

    // The party becomes stories rather than vanishing.
    expect(plan.effects.some((e) => e.t === "set_entity_flag" && e.key === "retired")).toBe(true);

    // And the thread the arc left open is now a fact nobody knows yet — a hook for the
    // next party to find.
    expect(plan.promoted.map((p) => p.id)).toContain("seed_garrets_sister");
    const seeded = plan.effects.find((e) => e.t === "add_fact" && e.text.includes("sister"));
    expect(seeded).toBeDefined();
    expect((seeded as { known_by: string[] }).known_by).toEqual([]);
  });

  it("is deterministic, so the skip replays like anything else", async () => {
    const s = await load();
    const a = planSuccession(s, new Rng(seedToState("x")), { campaignId: "cmp_mudwallow" });
    const b = planSuccession(s, new Rng(seedToState("x")), { campaignId: "cmp_mudwallow" });
    expect(stable(a.effects)).toBe(stable(b.effects));
  });
});

describe("phase 8: the content lint", () => {
  it("warns where a step has fewer than three routes to it", async () => {
    const s = await load();
    const issues = lintThreeClues(s);
    // The starter campaign is deliberately thin in places; the lint should say so rather
    // than let it pass silently.
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
    for (const i of issues) expect(i.message).toMatch(/route/);
  });

  it("catches content that would ruin a session but is not a broken reference", async () => {
    const s = await load();
    s.locations["loc_flagon"]!.exits = [];
    s.entities["npc_thorne"]!.personality.voice = "";
    const { ok, issues } = validateGenerated(s);
    expect(ok).toBe(false);
    expect(issues.some((i) => i.severity === "error" && i.message.includes("no exits"))).toBe(true);
    expect(issues.some((i) => i.message.includes("no voice"))).toBe(true);
  });

  it("passes the campaign as authored", async () => {
    const { ok } = validateGenerated(await load());
    expect(ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════ still exact

describe("everything above still replays byte-identically", () => {
  it("a session touching approval, clocks, travel and inspiration reproduces exactly", async () => {
    const initial = await load();
    initial.locations["loc_bell_gate"]!.discovered = true;
    let s = initial;
    const journal = [];

    const script: Parameters<typeof takeTurn>[1][] = [
      { type: "look" },
      { type: "talk", target_id: "npc_thorne", topic: "the bell" },
      { type: "skill_check", skill: "intimidation", band: "medium", target_id: "npc_thorne" },
      { type: "move", dir: "out" },
      { type: "travel", location_id: "loc_flagon" },
      { type: "rest", kind: "long" },
      { type: "wait", minutes: 600 },
    ];
    for (const a of script) {
      const out = takeTurn(s, a);
      s = out.state;
      journal.push(...out.journal);
    }

    const roots = journal.filter((e) => e.derived_from === null);
    expect(stable(reduceAll(initial, roots).state)).toBe(stable(s));
  });
});
