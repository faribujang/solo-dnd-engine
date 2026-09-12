import type { Condition } from "../schema/dsl.js";
import type { GameState } from "../schema/state.js";
import { countOfDef, questStep, relationship } from "../state/selectors.js";

/**
 * Pure predicate evaluation over game state. Every branch is total — an unknown id
 * evaluates false rather than throwing, because authored content should not be able to
 * crash a running campaign.
 */
export function evaluate(cond: Condition | undefined, s: GameState): boolean {
  if (!cond) return true;

  switch (cond.t) {
    case "flag":
      return deepEqual(s.world.flags[cond.key] ?? null, cond.eq ?? null);

    case "has_item":
      return countOfDef(s, cond.entity_id, cond.item_def_id) >= (cond.min ?? 1);

    case "entity_at":
      return s.entities[cond.entity_id]?.location_id === cond.location_id;

    case "entity_dead":
      return s.entities[cond.entity_id]?.alive === false;

    case "entity_alive":
      return s.entities[cond.entity_id]?.alive === true;

    case "affinity": {
      const rel = relationship(s, cond.subject, cond.object);
      if (!rel) return cond.op === "lte" ? cond.value >= 0 : cond.value <= 0;
      const v = rel.dims[cond.dim];
      return cond.op === "gte" ? v >= cond.value : v <= cond.value;
    }

    case "quest_status":
      return s.quests[cond.quest_id]?.status === cond.status;

    case "quest_step_done": {
      const q = s.quests[cond.quest_id];
      if (!q) return false;
      return questStep(q, cond.step_id)?.status === "complete";
    }

    case "knows_fact":
      return s.entities[cond.entity_id]?.known_fact_ids.includes(cond.fact_id) ?? false;

    case "world_time":
      return cond.op === "after"
        ? s.world.world_minute >= cond.world_minute
        : s.world.world_minute < cond.world_minute;

    case "faction_rep": {
      const f = s.world.factions[cond.faction_id];
      if (!f) return false;
      return cond.op === "gte" ? f.rep_with_pc >= cond.value : f.rep_with_pc <= cond.value;
    }

    case "visited":
      return (s.locations[cond.location_id]?.visited_count ?? 0) >= (cond.min ?? 1);

    case "all":
      return cond.of.every((c) => evaluate(c, s));

    case "any":
      return cond.of.some((c) => evaluate(c, s));

    case "not":
      return !cond.of.some((c) => evaluate(c, s));
  }
}

/** Structural equality for flag comparisons, which may hold arbitrary JSON. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || !ka.every((k, i) => k === kb[i])) return false;
    return ka.every((k) => deepEqual((a as never)[k], (b as never)[k]));
  }
  return false;
}
