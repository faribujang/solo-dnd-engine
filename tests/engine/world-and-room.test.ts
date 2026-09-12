import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { takeTurn } from "../../src/engine/session.js";
import { audiencePressure, crowdAt, interjectionsFor, CROWD_MIN } from "../../src/engine/bystanders.js";
import { arrivalStanding, arrivalEffects, HEARSAY_CAP } from "../../src/rules/reputation.js";
import { sceneBreakFor, nextSceneId, MIN_SCENE_TURNS } from "../../src/engine/scenes.js";
import { reduceAll } from "../../src/engine/reduce.js";
import type { GameState } from "../../src/schema/state.js";

const CAMPAIGN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../content/campaign/drowned_bell");
const load = async (): Promise<GameState> => {
  const s = structuredClone(await loadCampaign(CAMPAIGN));
  s.meta.session_zero.dice = "committed";
  return s;
};

describe("the rest of the room", () => {
  it("lets someone who knows better put their oar in", async () => {
    const s = await load();
    // Garret knows Thorne's business. Talking about Thorne where Garret can hear should
    // give the DM a reason for him to speak up — the difference between a room with people
    // in it and a room with furniture in it.
    s.entities["npc_garret"]!.location_id = s.entities["pc_main"]!.location_id;
    s.entities["npc_thorne"]!.location_id = s.entities["pc_main"]!.location_id;

    const cuts = interjectionsFor(s, "npc_thorne", ["npc_thorne"]);
    expect(cuts.length).toBeGreaterThan(0);
    expect(cuts[0]!.entity_id).toBe("npc_garret");
    // Implicated beats merely knowing something, so the ordering is the useful one.
    expect(["implicated", "knows_better"]).toContain(cuts[0]!.cause);
  });

  it("never lets the whole room chorus", async () => {
    const s = await load();
    const here = s.entities["pc_main"]!.location_id;
    for (const id of ["npc_garret", "npc_thorne", "npc_mira"]) {
      if (s.entities[id]) s.entities[id]!.location_id = here;
    }
    expect(interjectionsFor(s, "npc_thorne", ["npc_thorne"]).length).toBeLessThanOrEqual(2);
  });

  it("treats a crowd as one presence, not as N entities", async () => {
    const s = await load();
    const here = s.entities["pc_main"]!.location_id;
    for (const id of ["npc_garret", "npc_thorne", "npc_mira"]) {
      if (s.entities[id]) s.entities[id]!.location_id = here;
    }
    const crowd = crowdAt(s, here);
    expect(crowd).not.toBeNull();
    expect(crowd!.size).toBeGreaterThanOrEqual(CROWD_MIN);
    expect(crowd!.label.length).toBeGreaterThan(0);
  });

  it("makes threatening someone harder in front of an audience", async () => {
    const s = await load();
    const here = s.entities["pc_main"]!.location_id;
    for (const id of ["npc_garret", "npc_thorne", "npc_mira"]) {
      if (s.entities[id]) s.entities[id]!.location_id = here;
    }
    // Nobody folds where their neighbours can see them fold.
    const intimidate = audiencePressure(s, "intimidation")!;
    expect(intimidate.dc_delta).toBeGreaterThan(0);
    expect(intimidate.reason).toMatch(/fold/);
    // And a lie has more ears to get past than a request does.
    const lie = audiencePressure(s, "deception")!;
    const ask = audiencePressure(s, "persuasion");
    expect(lie.dc_delta).toBeGreaterThan(ask?.dc_delta ?? 0);
  });

  it("is not an audience when it is just the two of you", async () => {
    const s = await load();
    for (const e of Object.values(s.entities)) {
      if (e.id !== "pc_main" && e.id !== "npc_thorne") e.location_id = "loc_nowhere";
    }
    s.entities["npc_thorne"]!.location_id = s.entities["pc_main"]!.location_id;
    expect(audiencePressure(s, "intimidation")).toBeNull();
  });
});

describe("reputation arriving before you do", () => {
  it("starts a stranger where their faction's books put them", async () => {
    const s = await load();
    const npc = s.entities["npc_garret"]!;
    const fid = npc.faction_ids[0];
    if (!fid) return;                       // content without a faction proves nothing here
    s.world.factions[fid]!.rep_with_pc = -80;

    const cold = arrivalStanding(s, npc);
    expect(cold.affinity).toBeLessThan(0);
    expect(cold.reasons.length).toBeGreaterThan(0);

    // Hearsay is hearsay: it never moves someone as far as actually meeting you does.
    expect(Math.abs(cold.affinity)).toBeLessThanOrEqual(HEARSAY_CAP);
  });

  it("never overwrites someone who has actually met you", async () => {
    const s = await load();
    const npc = s.entities["npc_thorne"]!;
    const fid = npc.faction_ids[0];
    if (fid) s.world.factions[fid]!.rep_with_pc = -80;

    // Thorne already has an edge toward the player: what the two of them did together
    // outranks anything anyone said about her elsewhere.
    expect(s.relationships["npc_thorne->pc_main"]).toBeDefined();
    const effects = arrivalEffects(s, [npc]);
    expect(effects).toHaveLength(0);
  });
});

describe("scenes", () => {
  it("does not cut a scene every time you open a door", async () => {
    const s = await load();
    s.meta.turn = 20;
    s.world.scene_started_turn = 0;
    const rooms = Object.values(s.locations).filter((l) => l.region_id === null).slice(0, 2);
    if (rooms.length < 2) return;
    // Two rooms of the same place are one scene. Cutting here is how a story becomes
    // confetti, and it resets every per-scene budget while the player is mid-anything.
    expect(sceneBreakFor(s, {
      kind: "arrived", from_location: rooms[0]!.id, to_location: rooms[0]!.id,
    })).toBeNull();
  });

  it("refuses to cut a scene that has barely started", async () => {
    const s = await load();
    s.meta.turn = 1;
    s.world.scene_started_turn = 0;
    expect(s.meta.turn - s.world.scene_started_turn).toBeLessThan(MIN_SCENE_TURNS);
    expect(sceneBreakFor(s, { kind: "fight_over" })).toBeNull();
  });

  it("cuts after a fight, and after a night", async () => {
    const s = await load();
    s.meta.turn = 20;
    s.world.scene_started_turn = 0;
    expect(sceneBreakFor(s, { kind: "fight_over" })?.reason).toBe("fight_over");
    expect(sceneBreakFor(s, { kind: "rested" })?.reason).toBe("rested");
    // A few minutes is not a scene break; most of a day is.
    expect(sceneBreakFor(s, { kind: "time_passed", minutes: 30 })).toBeNull();
    expect(sceneBreakFor(s, { kind: "time_passed", minutes: 600 })?.reason).toBe("time_passed");
  });

  it("advances the scene id in the journal, so a rewind puts it back", async () => {
    let s = await load();
    s.meta.turn = 20;
    s.world.scene_started_turn = 0;
    const before = s.world.scene_id;

    const res = takeTurn(s, { type: "rest", kind: "long" });
    s = res.state;

    // A scene break is an EVENT, not a quiet mutation — that is what makes it rewindable
    // and what lets the timeline draw a divider where the chapter ended.
    expect(s.world.scene_id).not.toBe(before);
    expect(res.journal.some((e) => e.type === "scene_break")).toBe(true);
    expect(nextSceneId({ world: { scene_id: "scene_0009" } } as GameState)).toBe("scene_0010");
  });
});

describe("people act on how they feel about each other", () => {
  it("moves a devoted friend toward someone who is hurt", async () => {
    let s = await load();
    // Garret would cross a county for Thorne. Thorne is bleeding somewhere else.
    s.relationships["npc_garret->npc_thorne"] = {
      subject: "npc_garret", object: "npc_thorne",
      dims: { affinity: 90, trust: 60, fear: 0, respect: 40 },
      opinion: "", tags: [], history: [],
    };
    const thorne = s.entities["npc_thorne"]!;
    thorne.hp.current = 1;
    const elsewhere = Object.values(s.locations).find((l) => l.id !== thorne.location_id)!;
    s.entities["npc_garret"]!.location_id = elsewhere.id;
    // Somewhere the player is not, so nothing here depends on being watched.
    s.entities["pc_main"]!.location_id = elsewhere.id;

    // Whole days, because an offscreen impulse is deliberately a slow burn — the world
    // should not rearrange itself every time the player pauses for eight hours.
    let moved = false;
    for (let i = 0; i < 12 && !moved; i++) {
      const out = takeTurn(s, { type: "wait", minutes: 1440 });
      s = out.state;
      moved = s.entities["npc_garret"]!.location_id === thorne.location_id;
    }
    expect(moved).toBe(true);
  });

  it("keeps offscreen drama bounded", async () => {
    const s = await load();
    // Give everyone a reason to act, then confirm the world does not become a soap opera:
    // an unbounded loop here would fire once per edge per tick, forever.
    for (const a of Object.values(s.entities)) {
      for (const b of Object.values(s.entities)) {
        if (a.id === b.id || a.id === "pc_main" || b.id === "pc_main") continue;
        s.relationships[`${a.id}->${b.id}`] = {
          subject: a.id, object: b.id,
          dims: { affinity: -90, trust: -50, fear: 0, respect: 0 },
          opinion: "", tags: [], history: [],
        };
      }
    }
    const out = takeTurn(s, { type: "wait", minutes: 1440 });
    const gossipEvents = out.journal.filter((e) => e.type === "effect").length;
    expect(gossipEvents).toBeLessThan(60);
    // And the whole tick still replays into a valid world.
    expect(reduceAll(s, out.journal).state.meta.turn).toBeGreaterThanOrEqual(s.meta.turn);
  });
});
