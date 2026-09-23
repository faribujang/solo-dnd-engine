import { describe, expect, it } from "vitest";
import { tinyWorld, rootEvent } from "../helpers/world.js";
import { reduce } from "../../src/engine/reduce.js";
import { questModel } from "../../src/view/models.js";
import { Quest } from "../../src/schema/quest.js";
import type { GameState } from "../../src/schema/state.js";

/**
 * A quest is a running account, not a title and a status.
 *
 * It used to show its summary, its current objective, and every lead it had ever
 * collected, flat — which says what you are doing and nothing about how you got here or
 * what you just learned. Entries arrive in the order things happened, so reading down one
 * reconstructs the story.
 */
function withQuest(): GameState {
  const s = tinyWorld();
  s.quests["q_x"] = Quest.parse({
    id: "q_x", title: "The Smoke", status: "active", visibility: "known",
    summary: "Something is burning.", current_step_id: "s1",
    steps: [
      { id: "s1", desc: "Find out who is gone.", status: "active" },
      { id: "s2", desc: "Follow them north.", status: "locked" },
    ],
  });
  return s;
}

const fire = (s: GameState, effects: Parameters<typeof rootEvent>[1]) =>
  reduce(s, rootEvent("effect", effects)).state;

describe("a quest's running account", () => {
  it("records the objective it moves to", () => {
    const s = fire(withQuest(), [{ t: "advance_quest", quest_id: "q_x", step_id: "s2" }]);
    expect(s.quests["q_x"]!.entries.map((e) => e.text)).toContain("Follow them north.");
    expect(s.quests["q_x"]!.entries.at(-1)!.kind).toBe("step");
  });

  it("records a lead as it arrives", () => {
    const s = fire(withQuest(), [
      { t: "add_lead", quest_id: "q_x", text: "The north cut keeps tracks.", points_to_location_id: null, source_entity_id: null },
    ]);
    expect(s.quests["q_x"]!.entries.map((e) => e.text)).toContain("The north cut keeps tracks.");
  });

  it("records what the player LEARNED, and only what they learned", () => {
    let s = withQuest();
    s = fire(s, [{
      t: "add_fact", text: "Eight horses went north, shod alike.", subjects: [],
      importance: 4, secret: false, known_by: [s.meta.pc_id], quest_ids: ["q_x"],
    }]);
    expect(s.quests["q_x"]!.entries.map((e) => e.text)).toContain("Eight horses went north, shod alike.");

    // A fact the player has not learned is not their journal entry, however true it is.
    s = fire(s, [{
      t: "add_fact", text: "The courier is already dead.", subjects: [],
      importance: 5, secret: true, known_by: ["npc_b"], quest_ids: ["q_x"],
    }]);
    expect(s.quests["q_x"]!.entries.map((e) => e.text)).not.toContain("The courier is already dead.");
  });

  it("does not write the same line twice when an effect re-fires", () => {
    let s = withQuest();
    const lead = { t: "add_lead" as const, quest_id: "q_x", text: "Ask at the tollgate.", points_to_location_id: null, source_entity_id: null };
    s = fire(s, [lead]);
    s = fire(s, [lead]);
    expect(s.quests["q_x"]!.entries.filter((e) => e.text === "Ask at the tollgate.")).toHaveLength(1);
  });

  it("reaches the client in the order it happened", () => {
    let s = withQuest();
    s = fire(s, [{ t: "add_lead", quest_id: "q_x", text: "First.", points_to_location_id: null, source_entity_id: null }]);
    s = fire(s, [{ t: "advance_quest", quest_id: "q_x", step_id: "s2" }]);
    const model = questModel(s).find((q) => q.id === "q_x")!;
    expect(model.entries.map((e) => e.text)).toEqual(["First.", "Follow them north."]);
  });
});
