import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { validateNarration } from "../../src/llm/validate.js";
import type { Narration } from "../../src/llm/contracts.js";
import type { GameState } from "../../src/schema/state.js";

const CAMPAIGN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../content/campaign/drowned_bell",
);

const CTX = { presentEntityIds: ["pc_main", "npc_thorne"], locationId: "loc_flagon" };

function narration(over: Partial<Narration> = {}): Narration {
  return {
    narration: "The room is as you left it.",
    facts: [], attitude_deltas: [], opinion_updates: [],
    proposals: [], suggested_actions: [], scene_change: null,
    new_thread: null, settled_thread: null,
    ...over,
  };
}

let base: GameState;
const state = async () => (base ??= await loadCampaign(CAMPAIGN));

describe("the narrator whitelist", () => {
  it("refuses engine-only effects even if one somehow arrives", async () => {
    // Reachable in production, not merely defence-in-depth: the wire schema accepts any
    // tagged proposal precisely so this check is the one that runs. See WireProposal.
    const n = narration({
      proposals: [{ t: "damage", entity_id: "pc_main", amount: 6, damage_type: "psychic" } as never],
    });
    const v = validateNarration(await state(), n, CTX);
    expect(v.effects).toHaveLength(0);
    expect(v.rejects[0]!.reason).toMatch(/engine-only/);
  });

  it("never lets the narrator move the player character", async () => {
    const n = narration({
      proposals: [{ t: "move_entity", entity_id: "pc_main", location_id: "loc_lane" }],
    });
    const v = validateNarration(await state(), n, CTX);
    expect(v.effects).toHaveLength(0);
    expect(v.rejects[0]!.reason).toMatch(/may not move the player/);
  });

  it("allows moving an NPC, which is the narrator's business", async () => {
    const n = narration({
      proposals: [{ t: "move_entity", entity_id: "npc_thorne", location_id: "loc_lane" }],
    });
    const v = validateNarration(await state(), n, CTX);
    expect(v.effects).toEqual([{ t: "move_entity", entity_id: "npc_thorne", location_id: "loc_lane" }]);
    expect(v.rejects).toHaveLength(0);
  });
});

describe("unresolvable references", () => {
  it("drops a lead attached to a quest nobody wrote", async () => {
    const n = narration({
      proposals: [{ t: "add_lead", quest_id: "q_invented", text: "x", points_to_location_id: null }],
    });
    const v = validateNarration(await state(), n, CTX);
    expect(v.effects).toHaveLength(0);
    expect(v.rejects[0]!.reason).toMatch(/unknown quest/);
  });

  it("drops a reveal of a place that does not exist", async () => {
    const n = narration({ proposals: [{ t: "reveal_location", location_id: "loc_the_moon" }] });
    const v = validateNarration(await state(), n, CTX);
    expect(v.rejects[0]!.reason).toMatch(/unknown location/);
  });

  it("drops an exit reveal for a direction the room does not have", async () => {
    const n = narration({ proposals: [{ t: "reveal_exit", location_id: "loc_flagon", dir: "sideways" }] });
    const v = validateNarration(await state(), n, CTX);
    expect(v.rejects[0]!.reason).toMatch(/no exit "sideways"/);
  });

  it("refuses a flag key that is not a safe identifier", async () => {
    const n = narration({ proposals: [{ t: "set_flag", key: "Drop Table; --", value: true }] });
    const v = validateNarration(await state(), n, CTX);
    expect(v.effects).toHaveLength(0);
    expect(v.rejects[0]!.reason).toMatch(/snake_case/);
  });
});

describe("names the narrator used", () => {
  it("resolves a character by their spoken name", async () => {
    const n = narration({
      attitude_deltas: [{ subject: "Thorne Blackwater", object: "you", dims: { trust: 3 }, reason: "kindness" }],
    });
    const v = validateNarration(await state(), n, CTX);
    expect(v.effects).toEqual([
      { t: "adjust_attitude", subject: "npc_thorne", object: "pc_main", dims: { trust: 3 }, reason: "kindness" },
    ]);
  });

  it("refuses an opinion from someone who is not in the room", async () => {
    const n = narration({
      attitude_deltas: [{ subject: "Garret Ashe", object: "you", dims: { fear: 5 }, reason: "from afar" }],
    });
    const v = validateNarration(await state(), n, CTX);
    expect(v.effects).toHaveLength(0);
    expect(v.rejects[0]!.reason).toMatch(/not present/);
  });
});

describe("bounds", () => {
  it("clamps an attitude swing to ±10 and says it did", async () => {
    const n = narration({
      attitude_deltas: [{ subject: "npc_thorne", object: "pc_main", dims: { trust: 85 }, reason: "devotion" }],
    });
    const v = validateNarration(await state(), n, CTX);
    expect(v.effects[0]).toMatchObject({ dims: { trust: 10 } });
    expect(v.rejects[0]!.reason).toMatch(/clamped/);
  });

  it("caps how far the narrator may push the clock", async () => {
    const n = narration({ proposals: [{ t: "advance_time", minutes: 900 }] });
    const v = validateNarration(await state(), n, CTX);
    expect(v.effects).toHaveLength(0);
    expect(v.rejects[0]!.reason).toMatch(/cap is 60/);

    const ok = validateNarration(await state(), narration({ proposals: [{ t: "advance_time", minutes: 20 }] }), CTX);
    expect(ok.effects).toEqual([{ t: "advance_time", minutes: 20 }]);
  });

  it("will not let the narrator mint an importance-5 fact", async () => {
    // Importance 5 means "never drop this from context". That is the author's call and the
    // engine's, not something the model should be able to award itself.
    const n = narration({
      facts: [{ text: "A thing of enormous consequence.", kind: "world", subjects: [], importance: 5, quest_id: null, secret: false }],
    });
    const v = validateNarration(await state(), n, CTX);
    expect(v.effects[0]).toMatchObject({ t: "add_fact", importance: 4, quest_ids: [] });
  });

  it("keeps only the first few facts and says how many it dropped", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      text: `Fact number ${i} about the room.`, kind: "world" as const,
      subjects: [], importance: 2, secret: false, quest_id: null,
    }));
    const v = validateNarration(await state(), narration({ facts: many }), CTX);
    expect(v.effects.filter((e) => e.t === "add_fact")).toHaveLength(4);
    expect(v.rejects.some((r) => r.reason.includes("more than 4 facts"))).toBe(true);
  });
});

describe("narration prose", () => {
  it("flags a narrator that starts inventing dice", async () => {
    const n = narration({ narration: "You roll a 17 against DC 15 and slip past." });
    const v = validateNarration(await state(), n, CTX);
    expect(v.rejects.some((r) => r.reason.includes("dice"))).toBe(true);
  });

  it("does not flag ordinary prose", async () => {
    const n = narration({ narration: "You slip past him while he is looking at the water." });
    const v = validateNarration(await state(), n, CTX);
    expect(v.rejects).toHaveLength(0);
  });
});

/**
 * A BAD PROPOSAL COSTS THE PROPOSAL, NOT THE PARAGRAPH.
 *
 * Parsing the whole narration strictly at the transport boundary meant one invented effect
 * name discarded four good paragraphs, and the player was told the Dungeon Master could not
 * be reached — over a field the validator was always going to throw away. Voice is what the
 * model is qualified to produce; effects are checked. These two failures belong apart.
 */
describe("a malformed proposal", () => {
  it("is rejected on its own while the narration survives", async () => {
    const n = narration({
      narration: "The smith does not look up from the anvil.",
      // A tag nobody defined — what a model invents when it is reaching.
      proposals: [{ t: "grant_boon", entity_id: "npc_thorne", boon: "luck" } as never],
    });
    const v = validateNarration(await state(), n, CTX);

    expect(v.narration).toBe("The smith does not look up from the anvil.");
    expect(v.effects).toHaveLength(0);
    expect(v.rejects).toHaveLength(1);
    expect(v.rejects[0]!.reason).toMatch(/engine-only/);
  });

  it("rejects a KNOWN tag whose payload is the wrong shape", async () => {
    const n = narration({
      narration: "Time passes.",
      // `advance_time` is permitted; minutes as a phrase is not.
      proposals: [{ t: "advance_time", minutes: "about ten" } as never],
    });
    const v = validateNarration(await state(), n, CTX);

    expect(v.narration).toBe("Time passes.");
    expect(v.effects).toHaveLength(0);
    expect(v.rejects).toHaveLength(1);
    expect(v.rejects[0]!.reason).toMatch(/malformed/);
  });

  it("still lets a well-formed proposal beside a bad one through", async () => {
    const n = narration({
      proposals: [
        { t: "nonsense_effect", whatever: 1 } as never,
        { t: "set_flag", key: "saw_the_door", value: true },
      ],
    });
    const v = validateNarration(await state(), n, CTX);

    expect(v.rejects).toHaveLength(1);
    expect(v.effects).toEqual([{ t: "set_flag", key: "saw_the_door", value: true }]);
  });
});
