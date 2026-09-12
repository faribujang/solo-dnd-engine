import type { Entity } from "../schema/entity.js";
import type { Fact } from "../schema/fact.js";
import type { ItemInstance } from "../schema/item.js";
import type { Location } from "../schema/location.js";
import type { Quest } from "../schema/quest.js";
import type { Relationship } from "../schema/relationship.js";
import type { GameState } from "../schema/state.js";
import { relKey } from "../schema/relationship.js";
import { MINUTES_PER_DAY } from "../schema/world.js";

/** Read-only derivations. Nothing here mutates, and nothing here is stored. */

export function pc(s: GameState): Entity {
  const e = s.entities[s.meta.pc_id];
  if (!e) throw new Error(`PC entity ${s.meta.pc_id} missing from state`);
  return e;
}

export function entity(s: GameState, id: string): Entity | undefined {
  return s.entities[id];
}

export function mustEntity(s: GameState, id: string): Entity {
  const e = s.entities[id];
  if (!e) throw new Error(`Unknown entity: ${id}`);
  return e;
}

export function location(s: GameState, id: string): Location | undefined {
  return s.locations[id];
}

export function mustLocation(s: GameState, id: string): Location {
  const l = s.locations[id];
  if (!l) throw new Error(`Unknown location: ${id}`);
  return l;
}

/** DERIVED, never stored. Two sources of truth for occupancy is how worlds desync. */
export function entitiesAt(s: GameState, locationId: string): Entity[] {
  return Object.values(s.entities)
    .filter((e) => e.location_id === locationId)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Living, non-PC entities in the room — the ones the DM should be voicing. */
export function npcsPresent(s: GameState, locationId: string): Entity[] {
  return entitiesAt(s, locationId).filter((e) => e.alive && e.id !== s.meta.pc_id);
}

export function relationship(s: GameState, subject: string, object: string): Relationship | undefined {
  return s.relationships[relKey(subject, object)];
}

export function itemsOwnedBy(s: GameState, entityId: string): ItemInstance[] {
  return Object.values(s.items)
    .filter((i) => i.owner.t === "entity" && i.owner.id === entityId)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function itemsAt(s: GameState, locationId: string): ItemInstance[] {
  return Object.values(s.items)
    .filter((i) => i.owner.t === "location" && i.owner.id === locationId)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Does this entity hold at least `min` of the given item definition? */
export function countOfDef(s: GameState, entityId: string, defId: string): number {
  return itemsOwnedBy(s, entityId)
    .filter((i) => i.def_id === defId)
    .reduce((n, i) => n + i.qty, 0);
}

export function activeQuests(s: GameState): Quest[] {
  return Object.values(s.quests)
    .filter((q) => q.status === "active")
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function questStep(q: Quest, stepId: string) {
  return q.steps.find((st) => st.id === stepId);
}

/**
 * Facts the player actually holds.
 *
 * Strictly `known_by`. A fact that is not marked secret is not therefore known — it just
 * means nothing stops it spreading. An author who writes a rumour only the scholar has
 * heard means exactly that, and the player has to go and ask her.
 */
export function factsKnownToPc(s: GameState): Fact[] {
  return factsKnownTo(s, s.meta.pc_id);
}

export function factsKnownTo(s: GameState, entityId: string): Fact[] {
  return s.facts.filter((f) => !f.superseded_by && f.known_by.includes(entityId));
}

export function factById(s: GameState, id: string): Fact | undefined {
  return s.facts.find((f) => f.id === id);
}

/** Clock derivations. One monotonic minute counter drives all of these. */
export function hourOfDay(s: GameState): number {
  return Math.floor((s.world.world_minute % MINUTES_PER_DAY) / 60);
}

export function dayNumber(s: GameState): number {
  return Math.floor(s.world.world_minute / MINUTES_PER_DAY) + s.world.calendar.epoch_day;
}

export function timeOfDayLabel(s: GameState): string {
  const h = hourOfDay(s);
  if (h < 5) return "deep night";
  if (h < 8) return "dawn";
  if (h < 12) return "morning";
  if (h < 14) return "midday";
  if (h < 18) return "afternoon";
  if (h < 21) return "evening";
  return "night";
}

/** Where an NPC's schedule says they should be at the current hour. */
export function scheduledLocation(s: GameState, e: Entity): string | null {
  if (e.schedule.length === 0) return null;
  const h = hourOfDay(s);
  for (const block of e.schedule) {
    const { from_hour: f, to_hour: t } = block;
    const inBlock = f <= t ? h >= f && h < t : h >= f || h < t; // handles wrap past midnight
    if (inBlock) return block.location_id;
  }
  return null;
}

/** Exits the player can currently see. */
export function visibleExits(s: GameState, loc: Location) {
  return loc.exits.filter(
    (x) => x.revealed || x.hidden_until_flag === null || s.world.flags[x.hidden_until_flag] === true,
  );
}
