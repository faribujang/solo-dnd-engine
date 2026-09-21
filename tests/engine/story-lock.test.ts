import { describe, expect, it } from "vitest";
import { tinyWorld } from "../helpers/world.js";
import { reduce } from "../../src/engine/reduce.js";
import { rootEvent } from "../helpers/world.js";
import { STORY_LOCK_FLAG } from "../../src/engine/effects.js";
import { answer, classify } from "../../src/engine/questions.js";

/**
 * A schedule is a default. The story overrides it.
 *
 * The bug this exists to prevent: the raid on Wickmoor fired exactly as authored, moving
 * the player's abducted sister to the north road — and then the ambient scheduler walked
 * her straight back onto the village green, because her schedule said "the green, every
 * hour of the day". The player then spent sixty turns hunting somebody the world believed
 * was standing behind them. Nothing in 434 tests noticed, because every part worked.
 */
describe("the daily routine cannot undo the plot", () => {
  const withSchedule = (flags: Record<string, boolean> = {}) => {
    const s = tinyWorld();
    const e = s.entities["npc_c"]!;
    e.location_id = "loc_1";
    e.schedule = [{ from_hour: 0, location_id: "loc_1", to_hour: 24 }];
    e.flags = { ...e.flags, ...flags };
    return s;
  };

  // Time has to actually move for the scheduler to run.
  const tick = (s: ReturnType<typeof withSchedule>) =>
    reduce(s, rootEvent("time_pass", [{ t: "advance_time", minutes: 120 }])).state;

  it("walks an ordinary NPC back to where they are meant to be", () => {
    const s = withSchedule();
    s.entities["npc_c"]!.location_id = "loc_2";
    expect(tick(s).entities["npc_c"]!.location_id).toBe("loc_1");
  });

  it("leaves somebody the story has taken off the board exactly where it put them", () => {
    const s = withSchedule({ [STORY_LOCK_FLAG]: true });
    s.entities["npc_c"]!.location_id = "loc_2";
    expect(tick(s).entities["npc_c"]!.location_id).toBe("loc_2");
  });

  it("does not march the dead to their posts", () => {
    const s = withSchedule();
    s.entities["npc_c"]!.location_id = "loc_2";
    s.entities["npc_c"]!.alive = false;
    expect(tick(s).entities["npc_c"]!.location_id).toBe("loc_2");
  });
});

/**
 * "Where is Jory?" — asked twice in the first playthrough about the companion standing
 * next to the player, and answered "I do not know where Jory is" both times, because
 * there was no `where` question and it fell through to a roll-call of the room.
 */
describe("asking where somebody is", () => {
  it("says so plainly when they are standing right here", () => {
    const s = tinyWorld();
    const a = answer(s, "where", "npc_b");
    expect(a.lines.join(" ")).toMatch(/here, with you/);
  });

  it("does not invent a location for somebody whose whereabouts you were never told", () => {
    const s = tinyWorld();   // npc_c is in loc_2, and nothing has told the player that
    const a = answer(s, "where", "npc_c");
    expect(a.lines.join(" ")).toMatch(/do not know where/);
    expect(a.lines.join(" ")).not.toMatch(/Two/);
  });

  it("uses what a known fact told you, and says it is second-hand", () => {
    const s = tinyWorld();
    s.facts.push({
      id: "fact_1", text: "npc_c keeps to Two.", kind: "world", subjects: ["npc_c", "loc_2"],
      importance: 3, secret: false, known_by: ["pc_a"], turn_learned: 1, source: "authored",
    } as never);
    expect(answer(s, "where", "npc_c").lines.join(" ")).toMatch(/at Two, as far as you know/);
  });

  it("does not put the dead on the map", () => {
    const s = tinyWorld();
    s.entities["npc_c"]!.alive = false;
    expect(answer(s, "where", "npc_c").lines.join(" ")).toMatch(/is dead/);
  });

  it("reads 'where is Jory' as a question about a person", () => {
    expect(classify("where is jory")).toMatchObject({ kind: "where", subject: "jory" });
    expect(classify("where's cotter vane?")).toMatchObject({ kind: "where", subject: "cotter vane" });
    // ...but not a question about the player's own position.
    expect(classify("where am i")?.kind).not.toBe("where");
  });
});
