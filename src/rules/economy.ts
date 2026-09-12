import type { GameState } from "../schema/state.js";
import type { ItemDef } from "../schema/item.js";
import { priceMultiplierPct } from "./social.js";
import { skillModifier } from "./checks.js";

/**
 * MONEY.
 *
 * Currency is copper internally and gp/sp/cp on screen, because integer arithmetic that
 * never rounds is worth more than a pretty type. Prices already move with how a merchant
 * feels about you (rules/social.ts); this adds the rest of a shop.
 */

export const CP_PER_SP = 10;
export const CP_PER_GP = 100;

export function formatCoin(cp: number): string {
  if (cp <= 0) return "0 cp";
  const gp = Math.floor(cp / CP_PER_GP);
  const sp = Math.floor((cp % CP_PER_GP) / CP_PER_SP);
  const rem = cp % CP_PER_SP;
  return [gp && `${gp} gp`, sp && `${sp} sp`, rem && `${rem} cp`].filter(Boolean).join(" ");
}

export function purseOf(s: GameState, entityId: string): number {
  const n = s.entities[entityId]?.flags["cp"];
  return typeof n === "number" ? n : 0;
}

/** What a merchant asks. Affinity moves it; a merchant who likes you charges less. */
export function buyPrice(s: GameState, merchantId: string, def: ItemDef, qty = 1): number {
  const rel = s.relationships[`${merchantId}->${s.meta.pc_id}`];
  return Math.max(1, Math.round((def.value_cp * priceMultiplierPct(rel)) / 100)) * qty;
}

/**
 * What a merchant pays. Half is the 5e convention, and worse for goods they do not deal in
 * — a blacksmith is not interested in your spellbook, and the price says so.
 */
export function sellPrice(s: GameState, merchantId: string, def: ItemDef, dealsIn: readonly string[] = []): number {
  const rel = s.relationships[`${merchantId}->${s.meta.pc_id}`];
  const interested = dealsIn.length === 0 || def.tags.some((t) => dealsIn.includes(t)) || dealsIn.includes(def.kind);
  const base = def.value_cp * (interested ? 0.5 : 0.25);
  return Math.max(1, Math.round((base * priceMultiplierPct(rel)) / 100));
}

/**
 * Haggling: a Persuasion check against a DC set by the merchant's Insight. Success shifts
 * the price one band; a failure that is not merely a miss sours them slightly, because a
 * merchant remembers being worked on.
 */
export function haggleDC(s: GameState, merchantId: string): number {
  const m = s.entities[merchantId];
  if (!m) return 15;
  return 10 + Math.max(0, skillModifier(m, "insight"));
}

export const HAGGLE_SHIFT_PCT = 10;

export function afterHaggle(price: number, degree: string): number {
  if (degree === "critical_success") return Math.max(1, Math.round(price * (1 - HAGGLE_SHIFT_PCT * 2 / 100)));
  if (degree === "success") return Math.max(1, Math.round(price * (1 - HAGGLE_SHIFT_PCT / 100)));
  if (degree === "success_at_cost") return price;                    // they hold firm, no harm
  return Math.round(price * (1 + HAGGLE_SHIFT_PCT / 100));           // they mark it up for the cheek
}

/**
 * Shop stock is REAL item instances owned by a container, not a menu. Buying the last
 * healing draught means there is not one — which is the difference between a shop and a
 * vending machine, and it is what makes finding a well-stocked town feel like something.
 */
export function stockOf(s: GameState, containerId: string) {
  return Object.values(s.items)
    .filter((i) => i.owner.t === "container" && i.owner.id === containerId)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** How often a shop restocks, in in-world minutes. */
export const RESTOCK_MINUTES = 1440 * 3;
