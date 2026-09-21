import { describe, expect, it } from "vitest";
import { tinyWorld, rootEvent } from "../helpers/world.js";
import { reduce } from "../../src/engine/reduce.js";
import {
  censusOf, deservesPromotion, EXTRA_FADE_MINUTES, MEMORABLE_DIM, PROMOTION_TALKS,
} from "../../src/rules/cast.js";
import type { GameState } from "../../src/schema/state.js";

/**
 * A DM that must ask permission before putting a clerk behind a counter stops putting
 * clerks behind counters, and the world goes empty. So faces are free.
 *
 * But the promotion rule has to be STRICT, or free faces quietly become an expensive
 * cast: the first version promoted on any attitude change, and every conversation
 * adjusts attitude, so one polite word with a guard spent a permanent slot out of 250.
 * A cap you reach by talking to people is a cap that punishes playing the game.
 */
function withFace(): GameState {
  const s = tinyWorld();
  return reduce(s, rootEvent("effect", [{
    t: "introduce_local", name: "The Tollhouse Clerk", descriptor: "ink to the second knuckle",
    pronouns: "they/them", location_id: "loc_1", voice: "flat", trait: "counts under their breath",
  }])).state;
}

const faceIn = (s: GameState) => Object.values(s.entities).find((e) => e.name === "The Tollhouse Clerk")!;
const chat = (s: GameState, id: string, trust: number) =>
  reduce(s, rootEvent("dialogue", [
    { t: "adjust_attitude", subject: id, object: s.meta.pc_id, dims: { trust }, reason: "you spoke" },
  ])).state;

describe("faces the narrator invents", () => {
  it("arrives as an extra, costing nothing anybody has to remember", () => {
    const s = withFace();
    expect(faceIn(s).tier).toBe("extra");
    expect(censusOf(s).local).toBe(0);
  });

  it("can be spoken to, which is the entire reason they are real", () => {
    const s = withFace();
    expect(faceIn(s).location_id).toBe("loc_1");
    expect(faceIn(s).hp.max).toBeGreaterThan(0);
  });

  it("is NOT promoted by a passing conversation", () => {
    let s = withFace();
    const id = faceIn(s).id;
    s = chat(s, id, 3);
    expect(s.entities[id]!.tier).toBe("extra");
    expect(censusOf(s).local).toBe(0);
  });

  it("is NOT promoted by a bit of passing colour in the fact ledger", () => {
    let s = withFace();
    const id = faceIn(s).id;
    s = reduce(s, rootEvent("effect", [
      { t: "add_fact", text: "The clerk hums while stamping.", subjects: [id], importance: 2, secret: false, known_by: [s.meta.pc_id] },
    ])).state;
    expect(s.entities[id]!.tier).toBe("extra");
  });

  it("IS promoted once the player actually feels something about them", () => {
    let s = withFace();
    const id = faceIn(s).id;
    s = chat(s, id, MEMORABLE_DIM);
    expect(s.entities[id]!.tier).toBe("local");
  });

  it("IS promoted by being come back to in a later scene", () => {
    let s = withFace();
    const id = faceIn(s).id;
    s = chat(s, id, 2);
    expect(s.entities[id]!.tier).toBe("extra");       // one scene is not a relationship
    s.world.scene_id = "scene_0002";
    s = chat(s, id, 2);
    expect(s.entities[id]!.tier).toBe("local");
    expect(PROMOTION_TALKS).toBe(2);
  });

  it("IS promoted by an obligation that names them", () => {
    let s = withFace();
    const id = faceIn(s).id;
    s = reduce(s, rootEvent("effect", [
      { t: "open_thread", text: "Bring the clerk the stamped warrant.", subject_ids: [id], location_id: null, from_entity_id: id },
    ])).state;
    expect(s.entities[id]!.tier).toBe("local");
  });

  it("IS promoted by a fact that is plot rather than texture", () => {
    let s = withFace();
    const id = faceIn(s).id;
    s = reduce(s, rootEvent("effect", [
      { t: "add_fact", text: "The clerk logs every name through the gate for the Syndicate.", subjects: [id], importance: 4, secret: false, known_by: [s.meta.pc_id] },
    ])).state;
    expect(s.entities[id]!.tier).toBe("local");
  });

  it("is forgotten once the scene has moved on and the story never used them", () => {
    let s = withFace();
    const id = faceIn(s).id;
    s = chat(s, id, 3);                                // pleasantries do not save you
    s.entities[s.meta.pc_id]!.location_id = "loc_2";
    s = reduce(s, rootEvent("time_pass", [{ t: "advance_time", minutes: EXTRA_FADE_MINUTES + 60 }])).state;
    expect(s.entities[id]).toBeUndefined();
    // And nothing is left pointing at them.
    expect(Object.keys(s.relationships).some((k) => k.includes(id))).toBe(false);
  });

  it("is NEVER forgotten once the story has actually used them", () => {
    let s = withFace();
    const id = faceIn(s).id;
    s = chat(s, id, MEMORABLE_DIM);
    expect(deservesPromotion(s, id)).toBe(true);
    s.entities[s.meta.pc_id]!.location_id = "loc_2";
    s = reduce(s, rootEvent("time_pass", [{ t: "advance_time", minutes: EXTRA_FADE_MINUTES * 5 }])).state;
    expect(s.entities[id]).toBeTruthy();
    expect(s.entities[id]!.tier).toBe("local");
  });

  it("is not forgotten out from under the player while they are standing there", () => {
    let s = withFace();
    const id = faceIn(s).id;
    s = reduce(s, rootEvent("time_pass", [{ t: "advance_time", minutes: EXTRA_FADE_MINUTES * 3 }])).state;
    expect(s.entities[id]).toBeTruthy();
  });

  it("keeps a whole crowd of faces off the named-cast budget", () => {
    let s = tinyWorld();
    // Thirty people met across a market day, none of whom the story used.
    for (let i = 0; i < 30; i++) {
      s = reduce(s, rootEvent("effect", [{
        t: "introduce_local", name: `Face ${i}`, descriptor: "one of the crowd",
        pronouns: "they/them", location_id: "loc_1", voice: "", trait: "",
      }])).state;
      const them = Object.values(s.entities).find((e) => e.name === `Face ${i}`)!;
      s = chat(s, them.id, 4);
    }
    expect(censusOf(s).extra).toBe(30);
    expect(censusOf(s).local).toBe(0);
  });
});
