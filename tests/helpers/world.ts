import type { Effect, Trigger } from "../../src/schema/dsl.js";
import { GameEvent } from "../../src/schema/event.js";
import { GameState } from "../../src/schema/state.js";

/** A deliberately tiny world, so an engine test asserts one thing and not a campaign. */
export function tinyWorld(overrides: Partial<{
  triggers: Trigger[];
  entityTriggers: Record<string, Trigger[]>;
}> = {}): GameState {
  return GameState.parse({
    meta: {
      id: "camp_test", title: "Test", pc_id: "pc_a", seed: "t",
      turn: 0, next_ids: {},
    },
    world: {
      world_minute: 600,
      flags: {},
      factions: {
        fac_guild: { id: "fac_guild", name: "Guild", rep_with_pc: 0, member_ids: ["npc_b", "npc_c"] },
      },
      triggers: overrides.triggers ?? [],
    },
    entities: {
      pc_a: ent("pc_a", "pc", "loc_1", { hp: { current: 20, max: 20, temp: 0 } }),
      npc_b: ent("npc_b", "npc", "loc_1", {
        hp: { current: 8, max: 8, temp: 0 },
        on_death: overrides.entityTriggers?.["npc_b"] ?? [],
      }),
      npc_c: ent("npc_c", "npc", "loc_2", {}),
    },
    locations: {
      loc_1: { id: "loc_1", name: "One", short_desc: "one", exits: [{ dir: "east", to: "loc_2" }] },
      loc_2: { id: "loc_2", name: "Two", short_desc: "two", exits: [{ dir: "west", to: "loc_1" }] },
    },
    item_defs: {
      item_def_coin: { id: "item_def_coin", name: "Coin", kind: "treasure", stackable: true },
    },
    items: {},
    quests: {},
    relationships: {},
    facts: [],
  });
}

function ent(id: string, kind: string, loc: string, extra: Record<string, unknown>) {
  return {
    id, kind, name: id, location_id: loc,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    hp: { current: 10, max: 10, temp: 0 }, ac: 10,
    resources: { hit_dice: { max: 1, used: 0 } },
    ...extra,
  };
}

/** A root event carrying pre-resolved effects, exactly as the resolver would emit it. */
export function rootEvent(
  type: GameEvent["type"],
  effects: Effect[],
  extra: Partial<GameEvent> = {},
): GameEvent {
  return GameEvent.parse({
    id: "evt_r0001",
    turn: 1,
    world_minute: 600,
    type,
    actor_id: "pc_a",
    location_id: "loc_1",
    direct_effects: effects,
    ...extra,
  });
}
