import type { Effect } from "../schema/dsl.js";
import type { EncounterEntry } from "../schema/encounter.js";
import type { GameState } from "../schema/state.js";
import type { Rng } from "../rules/rng.js";
import { leversOf } from "../rules/difficulty.js";
import { hourOfDay } from "../state/selectors.js";

/**
 * Rolling on an encounter table. Called during RESOLUTION with a live Rng, so the outcome
 * is baked onto the event and the reducer stays pure — same contract as everything else
 * that touches dice.
 */

export interface RolledEncounter {
  entry: EncounterEntry;
  /** Where along the journey it interrupted, for the narrator. */
  at_location_id: string;
  effects: Effect[];
}

/**
 * One roll per hour of travel, at the danger level of the ground being crossed.
 *
 * The `quiet` entries are load-bearing rather than filler: a table that always produces
 * *something* makes travel exhausting, and tension needs troughs to have peaks.
 */
export function rollEncounters(
  s: GameState,
  rng: Rng,
  opts: { tableId: string | null; minutes: number; danger: number; atLocationId: string },
): RolledEncounter[] {
  const table = s.encounter_tables[opts.tableId ?? ""];
  if (!table || table.entries.length === 0) return [];

  const levers = leversOf(s);
  const hours = Math.max(1, Math.round(opts.minutes / 60));
  const hour = hourOfDay(s);
  const out: RolledEncounter[] = [];

  for (let h = 0; h < hours; h++) {
    if (!rng.chance(table.chance_per_hour * levers.encounter_budget)) continue;

    const eligible = table.entries.filter((e) => {
      if (e.min_danger > opts.danger) return false;
      if (e.hours.length > 0 && !e.hours.includes(hour)) return false;
      if (e.once && s.world.flags[`enc_${e.id}`] === true) return false;
      return true;
    });
    if (eligible.length === 0) continue;

    const total = eligible.reduce((n, e) => n + e.weight, 0);
    let pick = rng.float() * total;
    const entry = eligible.find((e) => (pick -= e.weight) <= 0) ?? eligible[eligible.length - 1]!;

    const effects: Effect[] = [...entry.then];
    if (entry.once) effects.push({ t: "set_flag", key: `enc_${entry.id}`, value: true });

    out.push({ entry, at_location_id: opts.atLocationId, effects });

    // A fight stops the journey. Everything else is something you pass through.
    if (entry.kind === "combat") break;
  }

  return out;
}

/**
 * CORPSES.
 *
 * A dead creature becomes a container holding what it carried, so a fight leaves something
 * behind and searching a battlefield is worth doing. It decays after a few days so the
 * world does not slowly turn into a warehouse of open coffins.
 */
export const CORPSE_DECAY_MINUTES = 1440 * 3;

export function corpseEffects(s: GameState, entityId: string): Effect[] {
  const e = s.entities[entityId];
  if (!e || e.inventory.length === 0) return [];
  // Their gear drops where they fell. `move_item` rather than minting, so the sword they
  // were carrying is the sword you pick up (§32.4).
  return e.inventory.map((instId) => ({
    t: "move_item" as const,
    instance_id: instId,
    to: { t: "location" as const, id: e.location_id },
  }));
}
