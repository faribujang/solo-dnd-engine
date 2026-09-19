import type { Entity } from "../schema/entity.js";
import type { GameState } from "../schema/state.js";
import { objectiveState } from "../rules/objectives.js";
import type { Combatant, CombatState } from "../schema/combat.js";
import type { Rng } from "../rules/rng.js";
import type { Action } from "./turn.js";
import { rollD20 } from "../rules/dice.js";
import { abilityModOf, initiativeModifier } from "../rules/checks.js";
import { canAct, canMove, conditionFlags } from "../rules/conditions.js";
import { spellsFor } from "../content/srd/spells.js";

/**
 * Combat bookkeeping and the CPU policies. Pure code — no LLM anywhere near a creature's
 * decision, because a companion that "decides" to stand still while you bleed out is not
 * drama, it is a bug.
 */

export function currentCombatant(c: CombatState): Combatant {
  return c.order[c.current]!;
}

export function isHostile(a: Combatant, b: Combatant): boolean {
  return a.side !== b.side;
}

export function combatantOf(c: CombatState, entityId: string): Combatant | undefined {
  return c.order.find((x) => x.entity_id === entityId);
}

/** Living, present, un-fled members of a side. */
export function activeSide(s: GameState, c: CombatState, side: Combatant["side"]): Combatant[] {
  return c.order.filter((x) => {
    const e = s.entities[x.entity_id];
    return x.side === side && !x.fled && e?.alive && (side === "enemy" ? e.hp.current > 0 : true);
  });
}

/** Combat ends when one side has nobody left standing (downed party members still count
 *  as present, since the fight is not over while they can be saved). */
export function combatOver(s: GameState, c: CombatState): "party" | "enemy" | null {
  /**
   * The objective is asked FIRST, and that ordering is the whole feature.
   *
   * A fight whose point is "hold the door for three rounds" must end when the door has
   * been held — not when somebody finally dies. Checking elimination first would mean an
   * encounter designed around surviving could only ever be resolved by killing, which is
   * the thing objectives exist to stop.
   */
  const objective = objectiveState(s, c);
  if (objective === "won") return "party";
  if (objective === "lost") return "enemy";

  const enemies = activeSide(s, c, "enemy");
  const party = activeSide(s, c, "party").filter((x) => (s.entities[x.entity_id]?.hp.current ?? 0) > 0);

  // An objective may declare that wiping out the other side is NOT a win — an escape is
  // not achieved by killing everyone who was chasing you, it is achieved by leaving.
  if (enemies.length === 0) return c.objective && !c.objective.killing_also_wins ? null : "party";
  if (party.length === 0) return "enemy";
  return null;
}

/** Roll initiative for everyone and produce the order. Ties: higher dex, then party. */
export function rollInitiative(s: GameState, rng: Rng, participants: Array<{ entity_id: string; side: Combatant["side"] }>): Combatant[] {
  const rolled = participants.map((p) => {
    const e = s.entities[p.entity_id]!;
    const roll = rollD20(rng, { purpose: "initiative", mods: initiativeModifier(e), target: null });
    return { entity_id: p.entity_id, side: p.side, initiative: roll.total, economy: freshEconomy(e), fled: false, dex: e.abilities.dex };
  });
  rolled.sort((a, b) => b.initiative - a.initiative || b.dex - a.dex || (a.side === "party" ? -1 : 1));
  return rolled.map(({ dex: _d, ...c }) => c);
}

export function freshEconomy(e: Entity) {
  const flags = conditionFlags(e);
  return {
    action: !flags.incapacitated,
    bonus: !flags.incapacitated,
    reaction: !flags.incapacitated,
    moves: flags.immobile ? 0 : 1,
    dodging: false,
    disengaged: false,
  };
}

/** Zone adjacency within a location. */
export function adjacentZones(s: GameState, locationId: string, zoneId: string | null): string[] {
  const loc = s.locations[locationId];
  const z = loc?.zones.find((x) => x.id === zoneId);
  return z?.adjacent ?? [];
}

export function sameZone(a: Entity, b: Entity): boolean {
  return a.location_id === b.location_id && (a.zone_id ?? "") === (b.zone_id ?? "");
}

export function inReach(s: GameState, a: Entity, b: Entity, range: "self" | "touch" | "near" | "far"): boolean {
  if (a.location_id !== b.location_id) return false;
  if (range === "far") return true;
  if (range === "self") return a.id === b.id;
  if (sameZone(a, b)) return true;
  if (range === "near") return adjacentZones(s, a.location_id, a.zone_id).includes(b.zone_id ?? "");
  return false;
}

/**
 * Hit chance, for the roll card and the affordance bar. Baldur's Gate 3 shows this and it
 * is the single most useful number a newcomer can see: it turns "why did I miss" into
 * "I took a 45% shot and it didn't land".
 */
export function hitChance(toHit: number, ac: number, advantage: "none" | "advantage" | "disadvantage"): number {
  // Need raw >= ac - toHit; nat 20 always hits, nat 1 always misses.
  const need = Math.max(2, Math.min(20, ac - toHit));
  const p = (21 - need) / 20;
  if (advantage === "advantage") return Math.round((1 - (1 - p) ** 2) * 100);
  if (advantage === "disadvantage") return Math.round(p * p * 100);
  return Math.round(p * 100);
}

// ------------------------------------------------------------------ policies

/**
 * What a CPU-controlled combatant does on its turn. Returns the action to resolve.
 * Deterministic given state and rng; never consults a model.
 */
export function choosePolicyAction(s: GameState, c: CombatState, self: Entity, rng: Rng): Action {
  const me = combatantOf(c, self.id)!;
  const hostiles = c.order
    .filter((x) => isHostile(me, x) && !x.fled)
    .map((x) => s.entities[x.entity_id]!)
    .filter((e) => e.alive && e.hp.current > 0);
  const allies = c.order
    .filter((x) => !isHostile(me, x) && x.entity_id !== self.id)
    .map((x) => s.entities[x.entity_id]!)
    .filter((e) => e.alive);

  if (!canAct(self)) return { type: "end_turn" };

  // --- morale: flee when badly hurt and it is not hopeless to run.
  const policy = self.ai_policy ?? (self.kind === "monster" ? "aggressive" : "cautious");
  const hpFrac = self.hp.current / self.hp.max;
  const fleeAt = policy === "cautious" ? 0.35 : policy === "skirmish" ? 0.25 : self.kind === "monster" ? 0.2 : 0;
  if (fleeAt > 0 && hpFrac <= fleeAt && me.economy.action && rng.chance(0.75)) {
    return { type: "flee" };
  }

  // --- support: heal whoever is worst off, if we can.
  if (policy === "support" && me.economy.action) {
    const spells = spellsFor(self.class_id, self.level);
    const heal = spells.find((sp) => sp.resolution.kind === "auto" && "heal" in sp.resolution && hasSlot(self, sp.level));
    const worst = [...allies, self].filter((e) => e.hp.current < e.hp.max * 0.4).sort((a, b) => a.hp.current / a.hp.max - b.hp.current / b.hp.max)[0];
    if (heal && worst && inReach(s, self, worst, heal.range)) {
      return { type: "cast", spell_id: heal.id, target_id: worst.id };
    }
  }

  // --- pick a target
  if (hostiles.length === 0) return { type: "end_turn" };
  const reachable = hostiles.filter((h) => sameZone(self, h));
  const byLowestHp = (list: Entity[]) => [...list].sort((a, b) => a.hp.current - b.hp.current)[0]!;

  if (me.economy.action && reachable.length > 0) {
    // Casters with an attack spell prefer it; everyone else swings.
    const spells = spellsFor(self.class_id, self.level).filter((sp) => sp.resolution.kind !== "auto" || ("damage" in sp.resolution && sp.resolution.damage));
    const best = spells.filter((sp) => sp.level > 0 && hasSlot(self, sp.level) && !sp.area).sort((a, b) => b.level - a.level)[0]
      ?? spells.find((sp) => sp.level === 0);
    const target = byLowestHp(reachable);
    if (best && self.resources.spell_slots && (best.level === 0 || hasSlot(self, best.level)) && rng.chance(0.7)) {
      return { type: "cast", spell_id: best.id, target_id: target.id };
    }
    return { type: "attack", target_id: target.id };
  }

  // --- nobody in reach: close the distance, or dash if already moved.
  if (me.economy.moves > 0 && canMove(self)) {
    const target = byLowestHp(hostiles);
    const adj = adjacentZones(s, self.location_id, self.zone_id);
    if (target.zone_id && adj.includes(target.zone_id)) return { type: "move_zone", zone_id: target.zone_id };
    if (adj.length) return { type: "move_zone", zone_id: adj[0]! };
  }
  if (me.economy.action) return { type: "dash" };

  return { type: "end_turn" };
}

export function hasSlot(e: Entity, level: number): boolean {
  if (level === 0) return true;
  const t = e.resources.spell_slots[String(level)];
  return !!t && t.used < t.max;
}

export function castingAbility(e: Entity): "int" | "wis" | "cha" {
  if (e.class_id === "cls_wizard") return "int";
  if (e.class_id === "cls_cleric") return "wis";
  return "cha";
}

export function castingMod(e: Entity): number {
  return abilityModOf(e, castingAbility(e));
}
