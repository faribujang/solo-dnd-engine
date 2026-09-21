import { describe, expect, it } from "vitest";
import { tinyWorld, rootEvent } from "../helpers/world.js";
import { resolve } from "../../src/engine/turn.js";
import { reduce } from "../../src/engine/reduce.js";
import { toAction } from "../../src/llm/intent.js";
import { Intent } from "../../src/llm/contracts.js";
import { affordances } from "../../src/rules/affordances.js";
import { suggest } from "../../src/rules/suggest.js";
import { Location } from "../../src/schema/location.js";
import type { GameState } from "../../src/schema/state.js";

/**
 * The room as something you play, not something you are told about.
 *
 * Features sat in the schema from the first commit as scenery with a list of verb names
 * that nothing in the engine ever read. Wickmoor shipped nineteen locations and not one
 * thing to pry, cut or climb, which is the mechanical reason a hundred turns of play
 * collapsed into conversation: talking was the only verb the world rewarded.
 */
function room(): GameState {
  const s = tinyWorld();
  s.locations["loc_1"] = Location.parse({
    ...s.locations["loc_1"],
    features: [
      {
        id: "feat_boards",
        name: "The floor housing",
        desc: "Salt-rotted boards over the crane's footing.",
        aliases: ["the boards", "the floor"],
        state: {},
        interactions: [
          {
            verb: "pry",
            label: "Pry up the rotted boards",
            skill: "athletics",
            band: "easy",
            once: true,
            on_success: [{ t: "set_flag", key: "under_the_housing", value: true }],
          },
          { verb: "listen", skill: "perception", band: "trivial" },
          {
            verb: "cut",
            skill: "athletics",
            band: "medium",
            requires_item_tag: "cutting",
            on_success: [{ t: "set_flag", key: "cut_through", value: true }],
          },
        ],
      },
    ],
  });
  return s;
}

const say = (over: Partial<Intent>) => Intent.parse({ action: "interact", confidence: 0.9, ...over });

describe("working on the room", () => {
  it("still accepts the old content shape, where a verb was a bare string", () => {
    const s = tinyWorld();
    s.locations["loc_1"] = Location.parse({
      ...s.locations["loc_1"],
      features: [{ id: "f", name: "Mud", state: {}, interactions: ["search"] }],
    });
    expect(s.locations["loc_1"]!.features[0]!.interactions[0]).toMatchObject({ verb: "search" });
  });

  it("resolves the words a player would actually type", () => {
    const r = toAction(room(), say({ feature_name: "the boards", verb: "pry" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toMatchObject({ type: "interact", feature_id: "feat_boards", verb: "pry" });
  });

  it("asks which verb rather than guessing, when the thing takes several", () => {
    const r = toAction(room(), say({ feature_name: "the boards", verb: "burn" }));
    expect(r.ok).toBe(false);
    if (r.ok || !("clarify" in r)) return;
    expect(r.clarify).toContain("pry");
    expect(r.clarify).toContain("listen");
  });

  it("rolls the feature's own skill and difficulty, and applies what was authored", () => {
    let s = room();
    const out = resolve(s, { type: "interact", feature_id: "feat_boards", verb: "pry" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.event.rolls[0]?.purpose).toBe("pry");
    expect(out.event.rolls[0]?.target).toBe(10);          // easy, not the old reflexive 15
    s = reduce(s, out.event).state;
    if (out.event.payload["outcome"] !== "failure") {
      expect(s.world.flags["under_the_housing"]).toBe(true);
      // Once means once, and the record lives on the feature itself.
      expect(s.locations["loc_1"]!.features[0]!.state["did_pry"]).toBe(true);
    }
  });

  it("refuses a tool you do not have instead of making you roll for it", () => {
    const out = resolve(room(), { type: "interact", feature_id: "feat_boards", verb: "cut" });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain("cutting");
  });

  it("puts every interaction on the bar, with what it costs", () => {
    const bar = affordances(room()).filter((a) => a.action.type === "interact");
    expect(bar.map((a) => a.label)).toContain("Pry up the rotted boards");
    // The one needing a tool is SHOWN, greyed, with the reason — that is the half of the
    // puzzle the player can act on.
    const cut = bar.find((a) => a.action.type === "interact" && a.action.verb === "cut")!;
    expect(cut.available).toBe(false);
    expect(cut.why_unavailable).toContain("cutting");
  });

  it("will not repeat something that only happens once", () => {
    const s = room();
    s.locations["loc_1"]!.features[0]!.state["did_pry"] = true;
    const out = resolve(s, { type: "interact", feature_id: "feat_boards", verb: "pry" });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain("already");
  });

  it("says so plainly when the room has nothing to work on", () => {
    const r = toAction(tinyWorld(), say({ feature_name: "the boards", verb: "pry" }));
    expect(r.ok).toBe(false);
    if (r.ok || !("clarify" in r)) return;
    expect(r.clarify).toContain("nothing here");
  });
});

/**
 * The bar decides what a hundred turns of play look like. Talking scored +2 and working
 * on a place scored nothing, so conversation won every ranking, four chips at a time.
 */
describe("the room gets a seat on the suggestion bar", () => {
  it("offers something physical even in a room full of people to talk to", () => {
    const s = room();
    // Four talkable people, which is exactly the situation that used to crowd it out.
    for (const id of ["npc_x1", "npc_x2", "npc_x3"]) {
      s.entities[id] = { ...structuredClone(s.entities["npc_b"]!), id, name: id, location_id: "loc_1" };
    }
    const chips = suggest(s, { limit: 4 });
    expect(chips.some((c) => c.affordance.action.type === "interact")).toBe(true);
  });

  it("does not manufacture one where the room has nothing to offer", () => {
    const chips = suggest(tinyWorld(), { limit: 4 });
    expect(chips.some((c) => c.affordance.action.type === "interact")).toBe(false);
  });
});

/**
 * A room the narrator opens must arrive with something in it.
 *
 * `introduce_place` fixed the cellar that was prose and had no id — and then created
 * empty rooms, which is the same bug one level down: a place whose only move is talking
 * to whoever followed you in.
 */
describe("rooms the narrator opens", () => {
  it("arrives furnished, and the things in it can be reached at once", () => {
    const s = tinyWorld();
    const after = reduce(s, rootEvent("effect", [{
      t: "introduce_place",
      name: "The Winch House", short_desc: "Timber over the bilge.",
      dir: "down the stair", back: "up the stair", light: "dim",
      features: [{
        name: "The winch", desc: "A drum wound with chain.", aliases: ["the drum"],
        verbs: [{ verb: "turn", label: "Turn the winch", skill: "athletics", band: "medium" }],
      }],
    }])).state;

    const made = Object.values(after.locations).find((l) => l.name === "The Winch House")!;
    expect(made).toBeTruthy();
    expect(made.features).toHaveLength(1);
    // Reachable the same turn it was described, by the words the prose used.
    const r = toAction(
      { ...after, entities: { ...after.entities, [after.meta.pc_id]: { ...after.entities[after.meta.pc_id]!, location_id: made.id } } },
      say({ feature_name: "the drum", verb: "turn" }),
    );
    expect(r.ok).toBe(true);
  });

  it("gives a narrator's feature no consequences of its own", () => {
    const s = tinyWorld();
    const after = reduce(s, rootEvent("effect", [{
      t: "introduce_feature",
      location_id: "loc_1",
      feature: {
        name: "The grating", desc: "Rusted thin.", aliases: [],
        verbs: [{ verb: "pry", label: "", skill: "athletics", band: "hard" }],
      },
    }])).state;

    const feat = after.locations["loc_1"]!.features.find((f) => f.name === "The grating")!;
    // The engine rolls it; the DM describes what happened. A narrator may put a winch in
    // the room and may not decide that turning it opens the gate.
    expect(feat.interactions[0]!.on_success).toEqual([]);
    expect(feat.interactions[0]!.on_failure).toEqual([]);
    expect(feat.interactions[0]!.skill).toBe("athletics");
    expect(feat.interactions[0]!.band).toBe("hard");
  });
});
