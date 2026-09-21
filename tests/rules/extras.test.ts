import { describe, expect, it } from "vitest";
import { tinyWorld, rootEvent } from "../helpers/world.js";
import { reduce } from "../../src/engine/reduce.js";
import { censusOf, hasEdges, EXTRA_FADE_MINUTES } from "../../src/rules/cast.js";
import type { GameState } from "../../src/schema/state.js";

/**
 * A DM that must ask permission before putting a clerk behind a counter stops putting
 * clerks behind counters, and the world goes empty. So faces are free, and the budget
 * moved to the only thing that actually costs: who has EDGES.
 */
function withFace(): GameState {
  const s = tinyWorld();
  const ev = rootEvent("effect", [
    {
      t: "introduce_local", name: "The Tollhouse Clerk", descriptor: "ink to the second knuckle",
      pronouns: "they/them", location_id: "loc_1", voice: "flat", trait: "counts under their breath",
    },
  ]);
  return reduce(s, ev).state;
}

const faceIn = (s: GameState) => Object.values(s.entities).find((e) => e.name === "The Tollhouse Clerk");

describe("faces the narrator invents", () => {
  it("arrives as an extra, costing nothing anybody has to remember", () => {
    const s = withFace();
    const them = faceIn(s)!;
    expect(them.tier).toBe("extra");
    expect(censusOf(s).local).toBe(0);
    expect(hasEdges(s, them.id)).toBe(false);
  });

  it("can be spoken to, which is the entire reason they are real", () => {
    const s = withFace();
    // npcsPresent is what the talk path resolves against.
    expect(Object.values(s.entities).some((e) => e.location_id === "loc_1" && e.name === "The Tollhouse Clerk"))
      .toBe(true);
  });

  it("is promoted the moment the player's opinion of them moves", () => {
    let s = withFace();
    const id = faceIn(s)!.id;
    s = reduce(s, rootEvent("dialogue", [
      { t: "adjust_attitude", subject: id, object: s.meta.pc_id, dims: { trust: 4 }, reason: "you were civil" },
    ])).state;
    expect(s.entities[id]!.tier).toBe("local");
    expect(censusOf(s).local).toBe(1);
  });

  it("is promoted by a fact that names them, too", () => {
    let s = withFace();
    const id = faceIn(s)!.id;
    s = reduce(s, rootEvent("effect", [
      { t: "add_fact", text: "The clerk logs every name through the gate.", subjects: [id], importance: 3, secret: false, known_by: [s.meta.pc_id] },
    ])).state;
    expect(s.entities[id]!.tier).toBe("local");
  });

  it("is forgotten once the scene has moved on and nobody ever touched them", () => {
    let s = withFace();
    const id = faceIn(s)!.id;
    // The player leaves, and days pass.
    s.entities[s.meta.pc_id]!.location_id = "loc_2";
    s = reduce(s, rootEvent("time_pass", [{ t: "advance_time", minutes: EXTRA_FADE_MINUTES + 60 }])).state;
    expect(s.entities[id]).toBeUndefined();
  });

  it("is NEVER forgotten once somebody has touched them", () => {
    let s = withFace();
    const id = faceIn(s)!.id;
    s = reduce(s, rootEvent("dialogue", [
      { t: "adjust_attitude", subject: id, object: s.meta.pc_id, dims: { trust: 4 }, reason: "you were civil" },
    ])).state;
    s.entities[s.meta.pc_id]!.location_id = "loc_2";
    s = reduce(s, rootEvent("time_pass", [{ t: "advance_time", minutes: EXTRA_FADE_MINUTES * 5 }])).state;
    expect(s.entities[id]).toBeTruthy();
    expect(s.entities[id]!.tier).toBe("local");
  });

  it("is not forgotten out from under the player while they are standing there", () => {
    let s = withFace();
    const id = faceIn(s)!.id;
    // Same room, however long it takes.
    s = reduce(s, rootEvent("time_pass", [{ t: "advance_time", minutes: EXTRA_FADE_MINUTES * 3 }])).state;
    expect(s.entities[id]).toBeTruthy();
  });
});
