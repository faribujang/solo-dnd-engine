import { describe, expect, it } from "vitest";
import { MAX_CASCADE_DEPTH, reduce } from "../../src/engine/reduce.js";
import { adjustAttitude, newEffectCtx } from "../../src/engine/effects.js";
import { rootEvent, tinyWorld } from "../helpers/world.js";
import { ATTITUDE_CLAMP_PER_TURN } from "../../src/schema/relationship.js";
import { stable } from "../../src/state/jsonFileStore.js";

describe("the reducer is pure", () => {
  it("never mutates the state it is given", () => {
    const s = tinyWorld();
    const before = stable(s);
    reduce(s, rootEvent("attack", [{ t: "damage", entity_id: "npc_b", amount: 3, damage_type: "slashing" }]));
    expect(stable(s)).toBe(before);
  });

  it("is a function: same input, same output", () => {
    const s = tinyWorld();
    const ev = rootEvent("effect", [
      { t: "set_flag", key: "x", value: 1 },
      { t: "give_item", entity_id: "pc_a", item_def_id: "item_def_coin", qty: 5 , from_entity_id: null },
    ]);
    expect(stable(reduce(s, ev).state)).toBe(stable(reduce(s, ev).state));
  });
});

describe("damage and death", () => {
  it("spends temp HP first and floors current HP at zero", () => {
    const s = tinyWorld();
    s.entities["npc_b"]!.hp.temp = 3;
    const r = reduce(s, rootEvent("attack", [
      { t: "damage", entity_id: "npc_b", amount: 5, damage_type: "slashing" },
    ]));
    const b = r.state.entities["npc_b"]!;
    expect(b.hp.temp).toBe(0);
    expect(b.hp.current).toBe(6);   // 8 max, 3 temp absorbed, 2 got through
    expect(b.alive).toBe(true);
  });

  it("emits a death event when HP reaches zero, and journals it as a cascade", () => {
    const s = tinyWorld();
    const r = reduce(s, rootEvent("attack", [
      { t: "damage", entity_id: "npc_b", amount: 99, damage_type: "slashing" },
    ]));
    expect(r.state.entities["npc_b"]!.alive).toBe(false);
    expect(r.state.entities["npc_b"]!.hp.current).toBe(0);

    const death = r.journal.find((e) => e.type === "death");
    expect(death).toBeDefined();
    expect(death!.derived_from).toBe("evt_r0001");
    expect(death!.target_ids).toEqual(["npc_b"]);
  });

  it("cascades from a death through an on_death trigger", () => {
    const s = tinyWorld({
      entityTriggers: {
        npc_b: [{
          id: "t_b_dies", on: "death", match: { target_ids: ["npc_b"] }, once: true,
          then: [
            { t: "set_flag", key: "b_is_dead", value: true },
            { t: "faction_rep", faction_id: "fac_guild", delta: -30 },
          ],
        }],
      },
    });

    const r = reduce(s, rootEvent("attack", [
      { t: "damage", entity_id: "npc_b", amount: 99, damage_type: "slashing" },
    ]));

    expect(r.state.world.flags["b_is_dead"]).toBe(true);
    expect(r.state.world.factions["fac_guild"]!.rep_with_pc).toBe(-30);
    expect(r.fired).toContain("ent:npc_b:death:t_b_dies");
  });

  it("spills faction reputation onto surviving members, damped", () => {
    const s = tinyWorld({
      entityTriggers: {
        npc_b: [{
          id: "t_b_dies", on: "death", match: { target_ids: ["npc_b"] }, once: true,
          then: [{ t: "faction_rep", faction_id: "fac_guild", delta: -30 }],
        }],
      },
    });
    const r = reduce(s, rootEvent("attack", [
      { t: "damage", entity_id: "npc_b", amount: 99, damage_type: "slashing" },
    ]));

    // -30 * 0.3 = -9, applied to each member's feelings about the PC.
    expect(r.state.relationships["npc_c->pc_a"]!.dims.affinity).toBe(-9);
    expect(r.state.relationships["npc_c->pc_a"]!.history[0]!.reason).toContain("Guild");
  });
});

describe("the attitude clamp", () => {
  it("honours authored effects in full — an author who writes +40 means +40", () => {
    // The ±10 clamp exists to restrain the LLM narrator, not hand-written content. Silently
    // delivering +10 where a quest reward says +40 would be an invisible content bug.
    const s = tinyWorld();
    const r = reduce(s, rootEvent("dialogue", [
      { t: "adjust_attitude", subject: "npc_b", object: "pc_a", dims: { trust: 40 }, reason: "a great service" },
    ]));
    expect(r.state.relationships["npc_b->pc_a"]!.dims.trust).toBe(40);
  });

  it("caps an untrusted source at ±10 per turn no matter how many effects push it", () => {
    const s = tinyWorld();
    const ctx = newEffectCtx(rootEvent("dialogue", []), null, true);   // clamped, as phase 1 will
    const draft = structuredClone(s);
    adjustAttitude(draft, ctx, "npc_b", "pc_a", { trust: 40 }, "one");
    adjustAttitude(draft, ctx, "npc_b", "pc_a", { trust: 40 }, "two");
    expect(draft.relationships["npc_b->pc_a"]!.dims.trust).toBe(ATTITUDE_CLAMP_PER_TURN);
  });

  it("records every applied change in append-only history", () => {
    const s = tinyWorld();
    const r = reduce(s, rootEvent("dialogue", [
      { t: "adjust_attitude", subject: "npc_b", object: "pc_a", dims: { trust: 4 }, reason: "kindness" },
      { t: "adjust_attitude", subject: "npc_b", object: "pc_a", dims: { affinity: -2 }, reason: "a slight" },
    ]));
    const h = r.state.relationships["npc_b->pc_a"]!.history;
    expect(h).toHaveLength(2);
    expect(h[0]!.reason).toBe("kindness");
    expect(h[1]!.dims.affinity).toBe(-2);
  });

  it("never lets a dimension leave the -100..100 range", () => {
    const s = tinyWorld();
    s.relationships["npc_b->pc_a"] = {
      subject: "npc_b", object: "pc_a",
      dims: { affinity: 96, trust: 0, fear: 0, respect: 0 }, opinion: "", tags: [], history: [],
    };
    const r = reduce(s, rootEvent("dialogue", [
      { t: "adjust_attitude", subject: "npc_b", object: "pc_a", dims: { affinity: 10 }, reason: "x" },
    ]));
    expect(r.state.relationships["npc_b->pc_a"]!.dims.affinity).toBe(100);
  });
});

describe("the cycle guard", () => {
  it("stops a ping-ponging loop instead of hanging", () => {
    // Two re-armable triggers that shove the PC back and forth between rooms. Each move
    // emits an enter_location, which re-arms the other one: a genuine infinite cascade.
    const s = tinyWorld({
      triggers: [
        {
          id: "t_push_east", on: "enter_location", once: false,
          match: { location_id: "loc_1" },
          then: [{ t: "move_entity", entity_id: "pc_a", location_id: "loc_2" }],
        },
        {
          id: "t_push_west", on: "enter_location", once: false,
          match: { location_id: "loc_2" },
          then: [{ t: "move_entity", entity_id: "pc_a", location_id: "loc_1" }],
        },
      ],
    });

    const r = reduce(s, rootEvent("move", [
      { t: "move_entity", entity_id: "pc_a", location_id: "loc_2" },
    ]));

    expect(r.truncated).toBe(true);
    // The guard bounds the work; it does not silently swallow it. Every bounce is journaled.
    expect(r.journal.filter((e) => e.type === "enter_location").length)
      .toBeLessThanOrEqual(MAX_CASCADE_DEPTH);
  });

  it("treats a redundant status change as a no-op rather than a new cascade", () => {
    const s = tinyWorld();
    s.quests["q_x"] = {
      id: "q_x", title: "X", giver_entity_id: null, status: "active", updated_turn: 0,
      visibility: "known", summary: "", dm_notes: "", current_step_id: null, steps: [],
      leads: [], rewards: { xp: 0, gold: 0, item_def_ids: [], relationship_deltas: [] },
      deadline_world_minute: null, failure_triggers: [], requires: [], blocks: [],
    };
    const r = reduce(s, rootEvent("effect", [
      { t: "set_quest_status", quest_id: "q_x", status: "active" },
    ]));
    expect(r.journal.filter((e) => e.type === "quest_update")).toHaveLength(0);
    expect(r.truncated).toBe(false);
  });

  it("does not trip on ordinary cascades", () => {
    const s = tinyWorld({
      entityTriggers: {
        npc_b: [{
          id: "t_b_dies", on: "death", match: { target_ids: ["npc_b"] }, once: true,
          then: [{ t: "set_flag", key: "done", value: true }],
        }],
      },
    });
    const r = reduce(s, rootEvent("attack", [
      { t: "damage", entity_id: "npc_b", amount: 99, damage_type: "slashing" },
    ]));
    expect(r.truncated).toBe(false);
  });
});

describe("once semantics", () => {
  it("fires a `once` trigger exactly one time across separate turns", () => {
    const t = {
      id: "t_first", on: "observe" as const, once: true,
      then: [{ t: "give_item" as const, entity_id: "pc_a", item_def_id: "item_def_coin", qty: 1 , from_entity_id: null }],
    };
    let s = tinyWorld({ triggers: [t] });

    s = reduce(s, rootEvent("observe", [])).state;
    s = reduce(s, rootEvent("observe", [], { id: "evt_r0002", turn: 2 })).state;

    const coins = Object.values(s.items).filter((i) => i.def_id === "item_def_coin");
    expect(coins).toHaveLength(1);
    expect(coins[0]!.qty).toBe(1);
    expect(s.world.fired_trigger_ids).toEqual(["world:t_first"]);
  });
});

describe("the clock", () => {
  it("advances by an event's duration and expires timed conditions", () => {
    const s = tinyWorld();
    s.entities["pc_a"]!.conditions = [
      { id: "poisoned", source_event_id: null, expires_world_minute: 630, expires_round: null },
      { id: "cursed", source_event_id: null, expires_world_minute: null, expires_round: null },
    ];
    const r = reduce(s, rootEvent("time_pass", [], { duration_minutes: 60 }));

    expect(r.state.world.world_minute).toBe(660);
    expect(r.state.entities["pc_a"]!.conditions.map((c) => c.id)).toEqual(["cursed"]);
  });

  it("expires a quest whose deadline has passed", () => {
    const s = tinyWorld();
    s.quests["q_timed"] = {
      id: "q_timed", title: "Timed", giver_entity_id: null, status: "active", updated_turn: 0,
      visibility: "known", summary: "", dm_notes: "", current_step_id: null, steps: [],
      leads: [], rewards: { xp: 0, gold: 0, item_def_ids: [], relationship_deltas: [] },
      deadline_world_minute: 700, failure_triggers: [], requires: [], blocks: [],
    };

    const before = reduce(s, rootEvent("time_pass", [], { duration_minutes: 30 }));
    expect(before.state.quests["q_timed"]!.status).toBe("active");   // 630 < 700

    const after = reduce(s, rootEvent("time_pass", [], { duration_minutes: 200 }));
    expect(after.state.quests["q_timed"]!.status).toBe("expired");   // 800 >= 700
  });

  it("walks NPCs to their scheduled location when the clock moves", () => {
    const s = tinyWorld();
    s.entities["npc_c"]!.schedule = [
      { from_hour: 0, to_hour: 12, location_id: "loc_2" },
      { from_hour: 12, to_hour: 24, location_id: "loc_1" },
    ];
    // 600 minutes = 10:00, so npc_c belongs in loc_2. Push past noon.
    const r = reduce(s, rootEvent("time_pass", [], { duration_minutes: 180 }));  // → 13:00
    expect(r.state.entities["npc_c"]!.location_id).toBe("loc_1");
  });
});

describe("knowledge", () => {
  it("teaches a produced fact to the event's witnesses and nobody else", () => {
    const s = tinyWorld();
    s.facts.push({
      id: "fact_0001", turn: 0, world_minute: 600, text: "A body was found.",
      kind: "world", subjects: [], location_id: "loc_1", quest_ids: [],
      importance: 4, secret: false, known_by: ["pc_a"], source: "authored", superseded_by: null, seal: null,
    });

    const r = reduce(s, rootEvent("observe", [], {
      fact_ids: ["fact_0001"],
      witnesses: ["npc_b"],
    }));

    expect(r.state.entities["npc_b"]!.known_fact_ids).toContain("fact_0001");
    expect(r.state.entities["npc_c"]!.known_fact_ids).not.toContain("fact_0001");
    expect(r.state.facts[0]!.known_by).toEqual(["pc_a", "npc_b"]);
  });

  it("does not teach the dead", () => {
    const s = tinyWorld();
    s.entities["npc_b"]!.alive = false;
    s.facts.push({
      id: "fact_0001", turn: 0, world_minute: 600, text: "x", kind: "world", subjects: [],
      location_id: null, quest_ids: [], importance: 1, secret: false, known_by: [],
      source: "authored", superseded_by: null, seal: null,
    });
    const r = reduce(s, rootEvent("observe", [], { fact_ids: ["fact_0001"], witnesses: ["npc_b"] }));
    expect(r.state.entities["npc_b"]!.known_fact_ids).not.toContain("fact_0001");
  });
});

describe("items", () => {
  it("stacks stackable definitions rather than creating parallel instances", () => {
    const s = tinyWorld();
    const r1 = reduce(s, rootEvent("item_transfer", [
      { t: "give_item", entity_id: "pc_a", item_def_id: "item_def_coin", qty: 3 , from_entity_id: null },
    ]));
    const r2 = reduce(r1.state, rootEvent("item_transfer", [
      { t: "give_item", entity_id: "pc_a", item_def_id: "item_def_coin", qty: 4 , from_entity_id: null },
    ], { id: "evt_r0002", turn: 2 }));

    const coins = Object.values(r2.state.items).filter((i) => i.def_id === "item_def_coin");
    expect(coins).toHaveLength(1);
    expect(coins[0]!.qty).toBe(7);
  });

  it("removes an emptied instance from inventory and from the item table", () => {
    const s = tinyWorld();
    const given = reduce(s, rootEvent("item_transfer", [
      { t: "give_item", entity_id: "pc_a", item_def_id: "item_def_coin", qty: 2 , from_entity_id: null },
    ])).state;

    const taken = reduce(given, rootEvent("item_transfer", [
      { t: "remove_item", entity_id: "pc_a", item_def_id: "item_def_coin", qty: 2 },
    ], { id: "evt_r0002", turn: 2 })).state;

    expect(taken.entities["pc_a"]!.inventory).toHaveLength(0);
    expect(Object.values(taken.items)).toHaveLength(0);
  });
});

describe("picking things up", () => {
  it("MOVES an existing object rather than minting a copy of it", async () => {
    // Regression: `take` once emitted give_item, which creates a new instance from the
    // definition. The original stayed on the floor, so the world quietly gained a second
    // one every time the player picked anything up.
    const { loadCampaign } = await import("../../src/content/loadCampaign.js");
    const { takeTurn } = await import("../../src/engine/session.js");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const dir = path.join(
      path.dirname(fileURLToPath(import.meta.url)), "../../content/campaign/drowned_bell",
    );
    const s0 = await loadCampaign(dir);
    const before = Object.values(s0.items).filter((i) => i.def_id === "item_def_rusted_key").length;

    // Walk to the lane and take the key that is lying there.
    const moved = takeTurn(s0, { type: "move", dir: "out" });
    const took = takeTurn(moved.state, { type: "take", item_instance_id: "item_inst_key" });
    expect(took.ok).toBe(true);

    const s = took.state;
    const keys = Object.values(s.items).filter((i) => i.def_id === "item_def_rusted_key");

    expect(keys, "the key must not be duplicated").toHaveLength(before);
    expect(keys[0]!.id).toBe("item_inst_key");
    expect(keys[0]!.owner).toEqual({ t: "entity", id: "pc_main" });

    // And both mirrors of `owner` agree with it.
    expect(s.entities["pc_main"]!.inventory).toContain("item_inst_key");
    expect(s.locations["loc_lane"]!.contains_item_ids).not.toContain("item_inst_key");
  });
});
