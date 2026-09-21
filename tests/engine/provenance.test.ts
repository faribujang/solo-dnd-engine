import { describe, expect, it } from "vitest";
import { tinyWorld, rootEvent } from "../helpers/world.js";
import { reduce } from "../../src/engine/reduce.js";
import { answer } from "../../src/engine/questions.js";

/**
 * "Did we get any gear from Cotter" was answered "I cannot say" while the player was
 * carrying his Accord steel.
 *
 * The fact ledger knew Cotter OWNED such things; nothing anywhere knew the player had
 * been handed them. Provenance is a property of the object, so it lives on the object.
 */
describe("where a thing came from", () => {
  it("remembers who handed it over", () => {
    const s = reduce(tinyWorld(), rootEvent("effect", [
      { t: "give_item", entity_id: "pc_a", item_def_id: "item_def_coin", qty: 1, from_entity_id: "npc_b" },
    ])).state;
    const coin = Object.values(s.items).find((i) => i.def_id === "item_def_coin")!;
    expect(coin.flags["from_entity_id"]).toBe("npc_b");
  });

  it("remembers it for an object passed hand to hand, too", () => {
    const s0 = tinyWorld();
    s0.items["itm_1"] = { id: "itm_1", def_id: "item_def_coin", owner: { t: "entity", id: "npc_b" }, qty: 1, flags: {},
      charges: null, attunement: null, nickname: null, condition: "fine" } as never;
    s0.entities["npc_b"]!.inventory = ["itm_1"];
    const s = reduce(s0, rootEvent("item_transfer", [
      { t: "move_item", instance_id: "itm_1", to: { t: "entity", id: "pc_a" } },
    ])).state;
    expect(s.items["itm_1"]!.flags["from_entity_id"]).toBe("npc_b");
  });

  it("says so when asked what you are carrying", () => {
    const s = reduce(tinyWorld(), rootEvent("effect", [
      { t: "give_item", entity_id: "pc_a", item_def_id: "item_def_coin", qty: 1, from_entity_id: "npc_b" },
    ])).state;
    expect(answer(s, "carrying").lines.join(" ")).toContain("from npc_b");
  });

  it("consults the pack for a question about having things, not just the fact ledger", () => {
    const s = reduce(tinyWorld(), rootEvent("effect", [
      { t: "give_item", entity_id: "pc_a", item_def_id: "item_def_coin", qty: 1, from_entity_id: "npc_b" },
    ])).state;
    // This is the shape of the question that used to be answered "I cannot say".
    const a = answer(s, "know", "npc_b", "did we get any gear from npc_b");
    expect(a.lines.join(" ")).toContain("You are carrying");
    expect(a.lines.join(" ")).toContain("from npc_b");
  });

  it("leaves an object anonymous when nobody handed it over", () => {
    const s = reduce(tinyWorld(), rootEvent("effect", [
      { t: "give_item", entity_id: "pc_a", item_def_id: "item_def_coin", qty: 1, from_entity_id: null },
    ])).state;
    const coin = Object.values(s.items).find((i) => i.def_id === "item_def_coin")!;
    expect(coin.flags["from_entity_id"]).toBeUndefined();
    expect(answer(s, "carrying").lines.join(" ")).not.toContain("from ");
  });
});
