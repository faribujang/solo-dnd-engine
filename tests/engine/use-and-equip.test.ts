import { describe, expect, it } from "vitest";
import { tinyWorld } from "../helpers/world.js";
import { resolve } from "../../src/engine/turn.js";
import { toAction } from "../../src/llm/intent.js";
import { Intent } from "../../src/llm/contracts.js";
import { reduce } from "../../src/engine/reduce.js";
import type { GameState } from "../../src/schema/state.js";

/**
 * A player who is handed gear must be able to draw it, and a player carrying a draught
 * must be able to drink it.
 *
 * Both were refused with "use item is not implemented yet" for the whole of the first
 * playthrough — the engine had `equip` all along, and nothing could reach it, because the
 * intent mapper answered the three item verbs with a stub.
 */

function armed(): GameState {
  const s = tinyWorld();
  s.item_defs["item_def_axe"] = {
    id: "item_def_axe", name: "Woodsman's Axe", kind: "weapon", desc: "", weight: 4, value_cp: 100,
    gift_ok: true, damage: { dice: "1d8", type: "slashing", versatile: null }, ac_base: null, ac_bonus: 0,
    dex_cap: null, properties: [], tags: [], stackable: false, grants: [], on_use: null,
  };
  s.item_defs["item_def_draught"] = {
    id: "item_def_draught", name: "Healing Draught", kind: "consumable", desc: "", weight: 0.5,
    value_cp: 5000, gift_ok: true, damage: null, ac_base: null, ac_bonus: 0, dex_cap: null,
    properties: [], tags: [], stackable: false, grants: [],
    on_use: { heal: "2d4+2", minutes: 1, consumed: true, text: "Iron filings and mint." },
  };
  s.items["itm_axe"] = { id: "itm_axe", def_id: "item_def_axe", owner: { t: "entity", id: "pc_a" }, qty: 1 } as never;
  s.items["itm_draught"] = { id: "itm_draught", def_id: "item_def_draught", owner: { t: "entity", id: "pc_a" }, qty: 1 } as never;
  // owner and inventory are both real: ownership gates the action, inventory is what the
  // remove_item effect walks. A fixture that sets only one of them tests nothing.
  s.entities["pc_a"]!.inventory = ["itm_axe", "itm_draught"];
  return s;
}

const say = (over: Partial<Intent>) =>
  Intent.parse({ action: "use_item", confidence: 0.9, ...over });

describe("drawing and drinking what you carry", () => {
  it("routes a weapon to equip rather than refusing it", () => {
    const r = toAction(armed(), say({ action: "equip", item_name: "the woodsman's axe" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toMatchObject({ type: "equip", item_instance_id: "itm_axe", slot: "main_hand" });
  });

  it("understands 'use the axe' as drawing it, because the ITEM decides the verb", () => {
    const r = toAction(armed(), say({ action: "use_item", item_name: "axe" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toMatchObject({ type: "equip", slot: "main_hand" });
  });

  it("understands 'equip the draught' as drinking it, for the same reason", () => {
    const r = toAction(armed(), say({ action: "equip", item_name: "healing draught" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toMatchObject({ type: "use_item", item_instance_id: "itm_draught" });
  });

  it("names what you are actually carrying when the item is not there", () => {
    const r = toAction(armed(), say({ action: "equip", item_name: "a greatsword" }));
    expect(r.ok).toBe(false);
    if (r.ok || !("clarify" in r)) return;
    expect(r.clarify).toContain("Woodsman's Axe");
    expect(r.clarify).not.toContain("not implemented");
  });

  it("picks it up first when the named thing is lying on the floor", () => {
    const s = armed();
    s.items["itm_rope"] = { id: "itm_rope", def_id: "item_def_coin", owner: { t: "location", id: "loc_1" }, qty: 1 } as never;
    const r = toAction(s, say({ action: "equip", item_name: "coin" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toMatchObject({ type: "take", item_instance_id: "itm_rope" });
  });

  it("drinking heals, spends the draught, and bakes the roll into the event", () => {
    let s = armed();
    s.entities["pc_a"]!.hp.current = 5;
    const out = resolve(s, { type: "use_item", item_instance_id: "itm_draught" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The dice were drawn here, once, and recorded.
    expect(out.event.rolls[0]?.die).toBe("2d4+2");
    expect(out.event.rolls[0]!.total).toBeGreaterThanOrEqual(4);
    s = reduce(s, out.event).state;
    expect(s.entities["pc_a"]!.hp.current).toBeGreaterThan(5);
    // And it is gone from the pack.
    expect(Object.values(s.items).some((i) => i.def_id === "item_def_draught" && i.owner.t === "entity")).toBe(false);
  });

  it("refuses to use what you are not carrying", () => {
    const s = armed();
    s.items["itm_draught"]!.owner = { t: "entity", id: "npc_b" };
    s.entities["pc_a"]!.inventory = ["itm_axe"];
    const out = resolve(s, { type: "use_item", item_instance_id: "itm_draught" });
    expect(out.ok).toBe(false);
  });

  it("an item with nothing written on it is inert, not an error", () => {
    const s = armed();
    s.items["itm_coin"] = { id: "itm_coin", def_id: "item_def_coin", owner: { t: "entity", id: "pc_a" }, qty: 1 } as never;
    s.entities["pc_a"]!.inventory.push("itm_coin");
    const out = resolve(s, { type: "use_item", item_instance_id: "itm_coin" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.mechanics).toContain("Nothing comes of it");
  });
});
