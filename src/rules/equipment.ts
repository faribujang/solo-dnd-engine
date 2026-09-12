import type { Entity } from "../schema/entity.js";
import type { GameState } from "../schema/state.js";
import { abilityModOf } from "./checks.js";

/**
 * Armour Class is COMPUTED, never stored as truth.
 *
 * A stored AC and an equipped breastplate will disagree eventually. So `entity.ac` is
 * treated as a cache the engine refreshes whenever equipment changes, and the client shows
 * the computation, not just the result: `11 leather + 3 dex = 14`.
 */

export interface AcBreakdown {
  total: number;
  parts: Array<{ label: string; value: number }>;
}

export function computeAC(s: GameState, e: Entity): AcBreakdown {
  const dex = abilityModOf(e, "dex");
  const parts: AcBreakdown["parts"] = [];

  const armorInst = e.equipped.armor ? s.items[e.equipped.armor] : undefined;
  const armor = armorInst ? s.item_defs[armorInst.def_id] : undefined;

  if (armor?.ac_base != null) {
    parts.push({ label: armor.name.toLowerCase(), value: armor.ac_base });
    const cappedDex = armor.dex_cap == null ? dex : Math.min(dex, armor.dex_cap);
    if (armor.dex_cap === 0) {
      // heavy armour: no dex at all
    } else if (cappedDex !== 0) {
      parts.push({ label: armor.dex_cap != null ? `dex (max ${armor.dex_cap})` : "dex", value: cappedDex });
    }
  } else {
    parts.push({ label: "unarmoured", value: 10 });
    if (dex !== 0) parts.push({ label: "dex", value: dex });
  }

  const offInst = e.equipped.off_hand ? s.items[e.equipped.off_hand] : undefined;
  const off = offInst ? s.item_defs[offInst.def_id] : undefined;
  if (off?.kind === "shield" && off.ac_bonus) parts.push({ label: "shield", value: off.ac_bonus });

  const total = parts.reduce((n, p) => n + p.value, 0);
  return { total, parts };
}

/** Refresh the cached AC on an entity. Called after any equipment change. */
export function refreshAC(s: GameState, e: Entity): void {
  e.ac = computeAC(s, e).total;
}

export const MAX_ATTUNED = 3;

export function attunedCount(s: GameState, entityId: string): number {
  return Object.values(s.items).filter((i) => i.attunement === entityId).length;
}
