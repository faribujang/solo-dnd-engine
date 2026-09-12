import type { GameState } from "../schema/state.js";

/**
 * SCENES — where one stops and the next begins.
 *
 * `world.scene_id` has existed since phase 0 and exactly one rule read it (Inspiration,
 * to stop you earning twice in one scene). Nothing ever advanced it, so every campaign was
 * a single scene four hundred turns long.
 *
 * That is a pacing bug, and pacing is most of what separates a good DM from a competent
 * one. A real table has rhythm: tension, release, travel, downtime. The engine cannot write
 * that rhythm, but it CAN mark where the beats fall — and once the boundaries exist, a
 * great deal falls out of them for free:
 *
 *   - a divider in the feed, so a wall of prose becomes chapters
 *   - the natural place to write a digest, and the only place it is cheap
 *   - ambient beats between scenes rather than interrupting a conversation
 *   - the honest place to offer a save
 *   - "once per scene" becomes a real budget for Inspiration and for luck
 *
 * A boundary is decided by CODE from state, never by the narrator. A model asked "did a
 * scene just end?" will say yes far too often, because saying yes is more interesting.
 */

/** What ended the scene. Kept on the event so the timeline can label the divider. */
export type SceneBreak =
  | "arrived"        // somewhere meaningfully else
  | "fight_over"
  | "rested"
  | "time_passed"    // a long gap — the night, the road
  | "parted";        // a conversation that mattered ended

/** A scene shorter than this is a beat, not a scene. Stops dividers every other turn. */
export const MIN_SCENE_TURNS = 3;

/** Hours of elapsed time that end a scene on their own. */
export const SCENE_GAP_HOURS = 6;

export interface SceneCandidate {
  reason: SceneBreak;
  /** For the divider: "The Rusty Flagon, that evening". */
  label: string;
}

/**
 * Would this end the scene?
 *
 * Deliberately conservative. A false negative costs a divider; a false positive chops the
 * story into confetti and resets every per-scene budget while the player is mid-fight.
 */
export function sceneBreakFor(
  s: GameState,
  what: { kind: SceneBreak; from_location?: string; to_location?: string; minutes?: number },
): SceneCandidate | null {
  // Too soon. Walking through three rooms of a dungeon is one scene.
  if (s.meta.turn - s.world.scene_started_turn < MIN_SCENE_TURNS) return null;

  switch (what.kind) {
    case "arrived": {
      // Only a change of PLACE in the larger sense. Room to room is not a scene change,
      // and treating it as one is how you get a divider every time someone opens a door.
      const from = what.from_location ? settlementOf(s, what.from_location) : null;
      const to = what.to_location ? settlementOf(s, what.to_location) : null;
      if (from === to) return null;
      const name = what.to_location ? s.locations[what.to_location]?.name ?? "somewhere new" : "somewhere new";
      return { reason: "arrived", label: name };
    }

    case "time_passed":
      if ((what.minutes ?? 0) < SCENE_GAP_HOURS * 60) return null;
      return { reason: "time_passed", label: "later" };

    case "fight_over":
      return { reason: "fight_over", label: "afterwards" };

    case "rested":
      return { reason: "rested", label: "the next morning" };

    case "parted":
      return null;   // ending a conversation is a beat, not a scene. Kept for the client.
  }
}

function settlementOf(s: GameState, locationId: string): string | null {
  const st = Object.values(s.settlements).find((x) => x.location_ids.includes(locationId));
  if (st) return st.id;
  // Outside a settlement, the region is the unit. Wilderness to wilderness is one scene.
  return s.locations[locationId]?.region_id ?? null;
}

/** The next scene's id. Monotonic, padded, and stable across a replay. */
export function nextSceneId(s: GameState): string {
  const n = Number.parseInt(s.world.scene_id.replace(/\D/g, ""), 10);
  return `scene_${String((Number.isFinite(n) ? n : 0) + 1).padStart(4, "0")}`;
}
