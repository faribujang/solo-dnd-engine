import type { GameState } from "../schema/state.js";
import type { Effect } from "../schema/dsl.js";
import { visibleExits } from "../state/selectors.js";

/**
 * FAST TRAVEL, over discovered ground only.
 *
 * Hadean Lands' fix for the oldest text-adventure friction: nobody should have to retype
 * NORTH, EAST, NORTH through rooms they have already read. Tap a place you have been and
 * walk there.
 *
 * What it is NOT is teleportation. The journey costs its real travel time, which means
 * deadlines still bite, NPC schedules still move, and clocks still tick — so choosing to
 * cross the map is a decision rather than a menu selection.
 */

export interface Path {
  /** Locations in order, starting with where you are. */
  nodes: string[];
  /** Direction taken at each step; one shorter than `nodes`. */
  dirs: string[];
  minutes: number;
  /** Highest danger level crossed, for the encounter roll. */
  danger: number;
  /**
   * Checks the route crosses, in order. Fast travel is a convenience, not a bypass: the
   * scramble down to the shrine is still a scramble, and failing it stops you there.
   */
  checks: Array<{ at: string; from: string; skill: string; band: string }>;
}

/**
 * Breadth-first over DISCOVERED locations, minimising travel time.
 *
 * Discovered-only is the important constraint: fast travel is a convenience for ground you
 * have covered, never a way to skip the finding of a place. A location you have heard of
 * but not visited is not on the network.
 */
export function findPath(s: GameState, from: string, to: string): Path | null {
  if (from === to) return { nodes: [from], dirs: [], minutes: 0, danger: 0, checks: [] };

  const seen = new Set<string>([from]);
  // [node, path so far, dirs so far, minutes, worst danger]
  type Node = [string, string[], string[], number, number, Path["checks"]];
  const queue: Node[] = [[from, [from], [], 0, 0, []]];

  while (queue.length > 0) {
    // Cheapest-first, so the path we return is the fastest rather than the fewest rooms.
    queue.sort((a, b) => a[3] - b[3]);
    const [at, nodes, dirs, minutes, danger, checks] = queue.shift()!;
    const loc = s.locations[at];
    if (!loc) continue;

    for (const exit of visibleExits(s, loc)) {
      const dest = s.locations[exit.to];
      if (!dest || seen.has(exit.to)) continue;
      if (!dest.discovered) continue;                       // never route through the unknown
      if (exit.locked_by) continue;                        // a locked door is a scene, not a step
      if (dest.flags["no_fast_travel"] === true) continue;

      seen.add(exit.to);
      const next: Node = [
        exit.to,
        [...nodes, exit.to],
        [...dirs, exit.dir],
        minutes + exit.travel_minutes,
        Math.max(danger, dest.danger_level),
        exit.requires_check
          ? [...checks, { at: exit.to, from: at, skill: exit.requires_check.skill, band: exit.requires_check.band }]
          : checks,
      ];
      if (exit.to === to) return { nodes: next[1], dirs: next[2], minutes: next[3], danger: next[4], checks: next[5] };
      queue.push(next);
    }
  }
  return null;
}

/** Everywhere you could get to from here without opening anything. */
export function reachable(s: GameState, from: string): Array<{ id: string; path: Path }> {
  return Object.keys(s.locations)
    .filter((id) => id !== from && s.locations[id]!.discovered)
    .map((id) => ({ id, path: findPath(s, from, id) }))
    .filter((x): x is { id: string; path: Path } => x.path !== null)
    .sort((a, b) => a.path.minutes - b.path.minutes);
}

/**
 * The journey as effects. One journaled action rather than a dozen, but the whole route is
 * in the payload so the map can draw it and the narrator can describe the crossing.
 */
export function travelEffects(s: GameState, path: Path): Effect[] {
  const out: Effect[] = [];
  for (const node of path.nodes.slice(1)) {
    out.push({ t: "move_entity", entity_id: s.meta.pc_id, location_id: node });
  }
  // Companions travelling with you arrive too. A split party is a different thing (§26).
  for (const id of s.meta.party_ids) {
    if (id === s.meta.pc_id) continue;
    const e = s.entities[id];
    if (e?.alive && e.group_id === s.entities[s.meta.pc_id]?.group_id) {
      out.push({ t: "move_entity", entity_id: id, location_id: path.nodes[path.nodes.length - 1]! });
    }
  }
  return out;
}

/** Whether fast travel is available at all right now, and why not if it is not. */
export function canFastTravel(s: GameState): { ok: true } | { ok: false; reason: string } {
  if (s.combat) return { ok: false, reason: "Not in the middle of a fight." };
  const p = s.entities[s.meta.pc_id];
  if (!p) return { ok: false, reason: "No character." };
  if (p.hp.current === 0) return { ok: false, reason: "You are in no condition to travel." };
  if (s.locations[p.location_id]?.flags["no_fast_travel"] === true) {
    return { ok: false, reason: "You will have to walk out of here the way you came." };
  }
  return { ok: true };
}
