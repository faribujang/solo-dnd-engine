import { z } from "zod";
import type { GameState } from "../schema/state.js";
import type { CombatState } from "../schema/combat.js";

/**
 * WHAT A FIGHT IS FOR.
 *
 * `combatOver` had two endings: everyone on one side is down, or everyone on the other is.
 * That is one encounter, reskinned forever — and it is why the only question a fight ever
 * asked was "can you out-damage them", which a player answers the same way every time.
 *
 * An objective changes the question without changing a single rule. *Hold the door for
 * three rounds* makes retreating correct. *Get to the north road* makes fighting a mistake.
 * *Keep Jory alive* makes the enemy's target selection the whole puzzle. Same dice, same
 * actions, completely different turn.
 *
 * Objectives are AUTHORED, not invented: they are the shape of an encounter, which is a
 * design decision. The narrator may not set one.
 */

export const ObjectiveKind = z.enum([
  /** Survive N rounds. The enemy does not have to die. */
  "hold",
  /** Reach a zone. Crossing the room IS the win. */
  "reach",
  /** Somebody must still be standing at the end. */
  "protect",
  /** Drop one specific enemy; the rest do not matter. */
  "break",
  /** Get out. Leaving is the win, not the failure. */
  "escape",
]);
export type ObjectiveKind = z.infer<typeof ObjectiveKind>;

export const CombatObjective = z.object({
  kind: ObjectiveKind,
  /** Shown to the player, in the fiction: "Hold the bridge until the barge is clear." */
  text: z.string().min(1).max(160),
  /** `hold`: how many rounds. */
  rounds: z.number().int().positive().default(3),
  /** `reach` / `escape`: which zone. */
  zone_id: z.string().nullable().default(null),
  /** `protect`: who must live. `break`: who must fall. */
  entity_id: z.string().nullable().default(null),
  /** Wiping out the other side always wins too, unless the objective says otherwise. */
  killing_also_wins: z.boolean().default(true),
});
export type CombatObjective = z.infer<typeof CombatObjective>;

export type ObjectiveState = "pending" | "won" | "lost";

/**
 * Where the objective stands right now.
 *
 * Pure, and checked every time the fight is asked whether it is over — so an objective
 * cannot be missed by a cascade or a CPU turn that happened to end things first.
 */
export function objectiveState(s: GameState, c: CombatState): ObjectiveState {
  const obj = c.objective;
  if (!obj) return "pending";

  const pcEntity = s.entities[s.meta.pc_id];
  const pcDown = !pcEntity?.alive || pcEntity.hp.current <= 0;

  switch (obj.kind) {
    case "hold":
      // Rounds are one-indexed and increment at the top, so surviving three rounds means
      // reaching the start of the fourth.
      if (pcDown) return "lost";
      return c.round > obj.rounds ? "won" : "pending";

    case "reach":
    case "escape": {
      if (pcDown) return "lost";
      if (!obj.zone_id) return "pending";
      return pcEntity?.zone_id === obj.zone_id ? "won" : "pending";
    }

    case "protect": {
      const ward = obj.entity_id ? s.entities[obj.entity_id] : undefined;
      if (!ward) return "pending";
      // The ward dying is the loss, whatever else happened. That is the point of the verb.
      if (!ward.alive || ward.hp.current <= 0) return "lost";
      if (pcDown) return "lost";
      return c.round > obj.rounds ? "won" : "pending";
    }

    case "break": {
      const quarry = obj.entity_id ? s.entities[obj.entity_id] : undefined;
      if (!quarry) return "pending";
      if (pcDown) return "lost";
      return !quarry.alive || quarry.hp.current <= 0 ? "won" : "pending";
    }
  }
}

/** One line for the combat banner, so the player knows what they are actually doing. */
export function describeObjective(s: GameState, c: CombatState): string {
  const obj = c.objective;
  if (!obj) return "";
  switch (obj.kind) {
    case "hold":
    case "protect": {
      const left = Math.max(0, obj.rounds - c.round + 1);
      return `${obj.text} — ${left} round${left === 1 ? "" : "s"} left`;
    }
    case "reach":
    case "escape": {
      const zone = s.locations[c.location_id]?.zones.find((z) => z.id === obj.zone_id);
      return zone ? `${obj.text} — ${zone.name}` : obj.text;
    }
    case "break":
      return obj.text;
  }
}
