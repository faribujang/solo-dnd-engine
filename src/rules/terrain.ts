import { z } from "zod";
import type { GameState } from "../schema/state.js";
import type { Entity } from "../schema/entity.js";


/**
 * GROUND THAT MATTERS.
 *
 * Every fight in this engine happened on the same floor. A zone was `{id, name, adjacent}`
 * — a label and a graph edge — so "the moot stone" and "the burning roof" played
 * identically, and the only variable in any fight was how many hit points each side had.
 * That is why combat felt the same every time: it WAS the same every time.
 *
 * Terrain is the cheapest variety there is, because it changes decisions rather than
 * numbers. Cover makes a zone worth crossing to; a hazard makes one worth pushing somebody
 * into; high ground makes the first move matter. None of it needs new actions — it reprices
 * the ones already there.
 *
 * Deliberately small: five traits, each one sentence, each with a mechanical hook the
 * resolver already understands. A trait a player cannot see the effect of is set dressing.
 */

export const TerrainTrait = z.enum([
  /** Something to get behind. Harder to hit anyone standing here. */
  "cover",
  /** Above everything. Easier to hit anyone who is not. */
  "high",
  /** Mud, rubble, water. Crossing out of here costs your whole move. */
  "broken",
  /** Fire, a drop, machinery. Being here hurts, and being pushed here hurts more. */
  "hazard",
  /** Shadow, smoke, steam. Easier to hide, harder for anyone to pick you out. */
  "dim",
]);
export type TerrainTrait = z.infer<typeof TerrainTrait>;

export interface TerrainEffect {
  label: string;
  /** One line the client shows on the zone, and the narrator is told about. */
  blurb: string;
}

export const TERRAIN: Record<TerrainTrait, TerrainEffect> = {
  cover:  { label: "cover",      blurb: "something solid to put between you and them" },
  high:   { label: "high ground", blurb: "above the rest of it, with the reach that buys" },
  broken: { label: "broken ground", blurb: "rubble and standing water; leaving costs everything you have" },
  hazard: { label: "hazard",     blurb: "you do not want to be standing here, and neither do they" },
  dim:    { label: "dim",        blurb: "smoke and shadow enough to lose a shape in" },
};

/** Damage taken for ending a turn in a hazard. Small — this is pressure, not a trap. */
export const HAZARD_DAMAGE = 2;

export function traitsOf(s: GameState, locationId: string, zoneId: string | null): TerrainTrait[] {
  if (!zoneId) return [];
  const zone = s.locations[locationId]?.zones.find((z) => z.id === zoneId);
  return zone?.terrain ?? [];
}

/**
 * How the ground changes an attack.
 *
 * Defender's cover and attacker's height, as itemised modifiers so they show up on the
 * roll card with their reasons — which is the only way a player learns that crossing to
 * the rubble was worth a turn.
 */
export function attackModifiers(
  s: GameState,
  attacker: Entity,
  defender: Entity,
): Array<{ label: string; value: number }> {
  const out: Array<{ label: string; value: number }> = [];
  const atk = traitsOf(s, attacker.location_id, attacker.zone_id);
  const def = traitsOf(s, defender.location_id, defender.zone_id);

  if (def.includes("cover")) {
    out.push({ label: "their cover", value: -2 });
  }
  if (def.includes("dim")) {
    out.push({ label: "smoke and shadow", value: -2 });
  }
  // High ground only counts when you are above them, not when everybody is up there.
  if (atk.includes("high") && !def.includes("high")) {
    out.push({ label: "high ground", value: 2 });
  }
  return out;
}

/** A line for the narrator and the client about where somebody is standing. */
export function describeZone(s: GameState, locationId: string, zoneId: string | null): string {
  const traits = traitsOf(s, locationId, zoneId);
  if (traits.length === 0) return "";
  return traits.map((t) => TERRAIN[t].blurb).join("; ");
}
