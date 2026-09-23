import { describe, expect, it } from "vitest";
import { tinyWorld } from "../helpers/world.js";
import { resolve } from "../../src/engine/turn.js";
import { reduce } from "../../src/engine/reduce.js";
import { rootEvent } from "../helpers/world.js";
import type { GameState } from "../../src/schema/state.js";

/**
 * Hand a thing over, change your mind, take it back off the body.
 *
 * The item ledger's `owner` is the single source of truth for where every object in the
 * world is, and that is what makes this work without any special case: giving moves the
 * owner, dying moves it again, taking moves it back. Nothing tracks "quest items"
 * separately, because nothing needs to.
 */
function armed(): GameState {
  const s = tinyWorld();
  s.item_defs["item_def_letter"] = {
    id: "item_def_letter", name: "A Sealed Letter", kind: "misc", desc: "", weight: 0,
    value_cp: 0, gift_ok: true, damage: null, ac_base: null, ac_bonus: 0, dex_cap: null,
    properties: [], tags: ["quest"], quest_id: null, stackable: false, grants: [], on_use: null,
  };
  s.items["itm_letter"] = {
    id: "itm_letter", def_id: "item_def_letter", owner: { t: "entity", id: "pc_a" },
    qty: 1, charges: null, attunement: null, nickname: null, condition: "fine", flags: {},
  };
  s.entities["pc_a"]!.inventory = ["itm_letter"];
  return s;
}

const play = (s: GameState, action: Parameters<typeof resolve>[1]): GameState => {
  const out = resolve(s, action);
  if (!out.ok) throw new Error(out.reason);
  return reduce(s, out.event).state;
};

describe("a thing you handed over and then wanted back", () => {
  it("follows the owner the whole way: yours, theirs, the floor, yours again", () => {
    let s = armed();

    // 1. Given away. The world knows who has it.
    s = play(s, { type: "give", target_id: "npc_b", item_instance_id: "itm_letter" });
    expect(s.items["itm_letter"]!.owner).toEqual({ t: "entity", id: "npc_b" });
    expect(s.entities["npc_b"]!.inventory).toContain("itm_letter");
    expect(s.entities["pc_a"]!.inventory).not.toContain("itm_letter");

    // 2. They die. What they were carrying falls where they did.
    s = reduce(s, rootEvent("attack", [
      { t: "damage", entity_id: "npc_b", amount: 99, damage_type: "slashing" },
    ])).state;
    expect(s.entities["npc_b"]!.alive).toBe(false);
    expect(s.items["itm_letter"]!.owner).toEqual({ t: "location", id: "loc_1" });
    expect(s.locations["loc_1"]!.contains_item_ids).toContain("itm_letter");

    // 3. Picked up off the body.
    s = play(s, { type: "take", item_instance_id: "itm_letter" });
    expect(s.items["itm_letter"]!.owner).toEqual({ t: "entity", id: "pc_a" });
    expect(s.entities["pc_a"]!.inventory).toContain("itm_letter");
    // And it is not left lying in the room as well, which would be one letter too many.
    expect(s.locations["loc_1"]!.contains_item_ids).not.toContain("itm_letter");
  });

  it("does not let you take what somebody living is still carrying", () => {
    let s = armed();
    s = play(s, { type: "give", target_id: "npc_b", item_instance_id: "itm_letter" });
    const out = resolve(s, { type: "take", item_instance_id: "itm_letter" });
    expect(out.ok).toBe(false);
  });
});
