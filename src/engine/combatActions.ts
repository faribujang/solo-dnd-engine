import type { Roll } from "../schema/common.js";
import type { Effect } from "../schema/dsl.js";
import type { Entity } from "../schema/entity.js";
import type { GameEvent } from "../schema/event.js";
import type { GameState } from "../schema/state.js";
import type { Rng } from "../rules/rng.js";
import { rollD20, rollDamage, rollDice } from "../rules/dice.js";
import { abilityModOf, saveModifier, skillModifier } from "../rules/checks.js";
import { conditionFlags, canAct, canMove } from "../rules/conditions.js";
import { SPELLS, spellDC } from "../content/srd/spells.js";
import {
  adjacentZones, castingMod, combatOver, combatantOf, currentCombatant, hasSlot, inReach,
  isHostile, rollInitiative, sameZone,
} from "./combat.js";
import { featureOfKind, sneakAttackApplies, sneakDice } from "../rules/features.js";

/**
 * Resolution for everything that only makes sense in a fight. Same contract as turn.ts:
 * read state, refuse the impossible, roll, bake outcomes into effects. The reducer applies
 * them without rolling anything.
 */

export type CombatAction =
  | { type: "end_turn" }
  | { type: "dash" }
  | { type: "disengage" }
  | { type: "dodge" }
  | { type: "move_zone"; zone_id: string }
  | { type: "flee" }
  | { type: "cast"; spell_id: string; target_id?: string; zone_id?: string }
  | { type: "shove"; target_id: string; mode: "prone" | "push" };

export interface Partial {
  ok: true;
  type: GameEvent["type"];
  payload: Record<string, unknown>;
  rolls: Roll[];
  effects: Effect[];
  target_ids: string[];
  mechanics: string;
}
export type CombatResult = Partial | { ok: false; reason: string };

const fmt = (r: Roll) => `d20 ${r.raw}${r.mods >= 0 ? "+" : ""}${r.mods} = ${r.total}${r.advantage !== "none" ? ` [${r.advantage}]` : ""}`;

/** Begin a fight from a pending flag or an out-of-combat attack. Initiative is rolled HERE. */
export function beginCombatEffects(s: GameState, rng: Rng, actor: Entity, enemyIds: string[]): { effects: Effect[]; rolls: Roll[]; mech: string } {
  const party = s.meta.party_ids.filter((id) => s.entities[id]?.alive && s.entities[id]?.location_id === actor.location_id);
  const participants = [
    ...party.map((id) => ({ entity_id: id, side: "party" as const })),
    ...enemyIds.filter((id) => s.entities[id]?.alive).map((id) => ({ entity_id: id, side: "enemy" as const })),
  ];
  const order = rollInitiative(s, rng, participants);
  const idx = Math.max(0, order.findIndex((c) => c.entity_id === actor.id));
  const combat = {
    id: `cmb_${String(s.meta.turn + 1).padStart(4, "0")}`,
    location_id: actor.location_id,
    round: 1,
    order,
    current: idx,
    concentration: {},
    log: [],
    started_turn: s.meta.turn + 1,
  };
  const mech = `Initiative: ${order.map((c) => `${s.entities[c.entity_id]!.name} ${c.initiative}`).join(", ")}.`;
  return { effects: [{ t: "begin_combat", combat }], rolls: [], mech };
}

/** Attacks of opportunity against `mover` leaving `fromZone`. */
export function opportunityAttacks(s: GameState, rng: Rng, mover: Entity, lean: number): { effects: Effect[]; rolls: Roll[]; lines: string[] } {
  const c = s.combat;
  const out = { effects: [] as Effect[], rolls: [] as Roll[], lines: [] as string[] };
  if (!c) return out;
  const me = combatantOf(c, mover.id);
  if (!me || me.economy.disengaged) return out;
  for (const other of c.order) {
    if (!isHostile(me, other) || other.fled || !other.economy.reaction) continue;
    const e = s.entities[other.entity_id]!;
    if (!canAct(e) || !sameZone(e, mover)) continue;
    const swing = weaponAttack(s, rng, e, mover, 0);
    out.rolls.push(...swing.rolls);
    out.effects.push({ t: "spend", entity_id: e.id, reaction: true }, ...swing.effects);
    out.lines.push(`${e.name} takes a swing as you go: ${swing.mech}`);
    void lean;
  }
  return out;
}

/** One weapon attack, with every condition and cover rule applied. */
export function weaponAttack(s: GameState, rng: Rng, attacker: Entity, target: Entity, lean: number): { effects: Effect[]; rolls: Roll[]; mech: string; hit: boolean; damage: number } {
  const weaponInst = attacker.equipped.main_hand ? s.items[attacker.equipped.main_hand] : undefined;
  const weapon = weaponInst ? s.item_defs[weaponInst.def_id] : undefined;
  const finesse = weapon?.properties.includes("finesse") ?? false;
  const ranged = weapon?.properties.includes("ammunition") || weapon?.properties.includes("thrown") || false;
  const ability = finesse && abilityModOf(attacker, "dex") >= abilityModOf(attacker, "str") ? "dex" : "str";
  const abilityBonus = abilityModOf(attacker, ability);
  const toHit = abilityBonus + attacker.proficiency_bonus;

  const af = conditionFlags(attacker);
  const tf = conditionFlags(target);
  const tc = s.combat ? combatantOf(s.combat, target.id) : undefined;
  let adv = 0;
  if (tf.attacks_against_adv) adv++;
  if (tf.attacks_against_disadv || tc?.economy.dodging) adv--;
  if (af.own_attacks_disadv) adv--;
  if (target.flags["guided"] === true) adv++;
  const advantage = adv > 0 ? "advantage" : adv < 0 ? "disadvantage" : "none";

  const atk = rollD20(rng, {
    purpose: "attack", mods: toHit, target: target.ac, isAttack: true, advantage, lean,
    parts: [{ label: ability, value: abilityBonus }, { label: "proficiency", value: attacker.proficiency_bonus }],
  });
  const rolls: Roll[] = [atk];
  const effects: Effect[] = [];
  let mech = `${attacker.name} attacks ${target.name} (AC ${target.ac}): ${fmt(atk)} — `;
  let damage = 0;

  if (atk.success) {
    const crit = atk.critical || tf.melee_hits_crit === true;
    const dmg = rollDamage(rng, weapon?.damage?.dice ?? "1d4", abilityBonus, crit);
    rolls.push(dmg);
    damage = dmg.total;

    // RAGE is a stance, so it adds to every melee swing without being spent again.
    const rageFeat = featureOfKind(attacker, "rage");
    if (attacker.flags["raging"] === true && rageFeat && !ranged) {
      damage += rageFeat.effect.damage_bonus;
      mech += `[rage +${rageFeat.effect.damage_bonus}] `;
    }

    // SNEAK ATTACK. The conditions live in rules/features.ts, because the clause everyone
    // drops — an ally beside the target counts, not only advantage — is the one that makes
    // a rogue want a friend in the fight.
    if (sneakAttackApplies(s, attacker, target, {
      advantage: advantage === "advantage",
      disadvantage: advantage === "disadvantage",
      finesseOrRanged: finesse || ranged,
    })) {
      const n = sneakDice(attacker.level);
      const sneak = rollDamage(rng, `${n}d6`, 0, crit);
      rolls.push(sneak);
      damage += sneak.total;
      // Once per TURN, not per attack. Cleared when their turn comes round again.
      effects.push({ t: "set_entity_flag", entity_id: attacker.id, key: "sneak_used_this_turn", value: true });
      mech += `[sneak ${n}d6 = ${sneak.total}] `;
    }

    effects.push({ t: "damage", entity_id: target.id, amount: damage, damage_type: weapon?.damage?.type ?? "bludgeoning" });
    if (target.flags["guided"] === true) effects.push({ t: "set_entity_flag", entity_id: target.id, key: "guided", value: false });
    effects.push(...concentrationCheck(s, rng, target, damage));
    mech += `${crit ? "CRITICAL HIT" : "hit"} for ${damage} ${weapon?.damage?.type ?? "bludgeoning"}.`;
  } else {
    mech += atk.fumble ? "critical miss." : "miss.";
  }
  return { effects, rolls, mech, hit: atk.success === true, damage };
}

/** Taking damage while concentrating forces a CON save: DC 10 or half the damage. */
export function concentrationCheck(s: GameState, rng: Rng, target: Entity, damage: number): Effect[] {
  const c = s.combat;
  if (!c || !c.concentration[target.id] || damage <= 0) return [];
  const dc = Math.max(10, Math.floor(damage / 2));
  const save = rollD20(rng, { purpose: "concentration", mods: saveModifier(target, "con"), target: dc });
  if (save.success) return [];
  return [{ t: "set_concentration", entity_id: target.id, spell_id: null }];
}

/**
 * CUNNING ACTION, and why it is worth the indirection.
 *
 * A rogue's Dash, Disengage and Hide cost a BONUS action instead of an action. That one
 * line is most of what makes a rogue feel like a rogue at the table: everyone else chooses
 * between moving and swinging, and the rogue does both.
 *
 * Rather than special-casing "if rogue" in three places, the feature declares which actions
 * it moves onto the bonus economy (rules/features.ts), and this reads the declaration. A
 * class that gets the same trick later is data, not another branch.
 */
function economyFor(actor: Entity, actionType: string): "action" | "bonus" {
  const feat = featureOfKind(actor, "bonus_action_unlocks");
  return feat?.effect.actions.includes(actionType) ? "bonus" : "action";
}

/** Spend whichever pip this action actually costs for this character. */
function spendFor(actor: Entity, actionType: string): Effect {
  return economyFor(actor, actionType) === "bonus"
    ? { t: "spend", entity_id: actor.id, bonus: true }
    : { t: "spend", entity_id: actor.id, action: true };
}

export function resolveCombat(s: GameState, actor: Entity, action: CombatAction, rng: Rng, lean: number): CombatResult {
  const c = s.combat;
  if (!c) return { ok: false, reason: "You are not in a fight." };
  const me = combatantOf(c, actor.id);
  if (!me) return { ok: false, reason: `${actor.name} is not part of this fight.` };
  if (currentCombatant(c).entity_id !== actor.id) {
    return { ok: false, reason: `It is ${s.entities[currentCombatant(c).entity_id]!.name}'s turn.` };
  }

  switch (action.type) {
    case "end_turn":
      return { ok: true, type: "effect", payload: { end_turn: true }, rolls: [], effects: [{ t: "next_turn" }], target_ids: [], mechanics: `${actor.name} ends their turn.` };

    case "dash": {
      const pip = economyFor(actor, "dash");
      if (pip === "bonus" && !me.economy.bonus) return { ok: false, reason: "You have already used your bonus action." };
      if (pip === "action" && !me.economy.action) return { ok: false, reason: "You have already used your action." };
      if (!canMove(actor)) return { ok: false, reason: "You cannot move." };
      return { ok: true, type: "effect", payload: { dash: true, cunning: pip === "bonus" }, rolls: [],
        effects: [spendFor(actor, "dash"), { t: "grant_moves", entity_id: actor.id, moves: 1 }],
        target_ids: [], mechanics: `Dash: your ${pip} action buys another zone of movement.` };
    }

    case "disengage": {
      const pip = economyFor(actor, "disengage");
      if (pip === "bonus" && !me.economy.bonus) return { ok: false, reason: "You have already used your bonus action." };
      if (pip === "action" && !me.economy.action) return { ok: false, reason: "You have already used your action." };
      return { ok: true, type: "effect", payload: { disengage: true, cunning: pip === "bonus" }, rolls: [],
        effects: [spendFor(actor, "disengage"), { t: "mark", entity_id: actor.id, disengaged: true }],
        target_ids: [], mechanics: `Disengage: your ${pip} action means leaving a zone will not provoke attacks this turn.` };
    }

    case "dodge":
      if (!me.economy.action) return { ok: false, reason: "You have already used your action." };
      return { ok: true, type: "effect", payload: { dodge: true }, rolls: [],
        effects: [{ t: "spend", entity_id: actor.id, action: true }, { t: "mark", entity_id: actor.id, dodging: true }],
        target_ids: [], mechanics: "Dodge: attacks against you have disadvantage until your next turn." };

    case "move_zone": {
      if (me.economy.moves <= 0) return { ok: false, reason: "You have no movement left. Dash to move again." };
      if (!canMove(actor)) return { ok: false, reason: "You cannot move." };
      const adj = adjacentZones(s, actor.location_id, actor.zone_id);
      if (!adj.includes(action.zone_id)) return { ok: false, reason: `You cannot reach that from here. Adjacent: ${adj.join(", ") || "nothing"}.` };
      const oa = opportunityAttacks(s, rng, actor, lean);
      const zoneName = s.locations[actor.location_id]!.zones.find((z) => z.id === action.zone_id)?.name ?? action.zone_id;
      return { ok: true, type: "move", payload: { zone: action.zone_id, opportunity_attacks: oa.lines.length }, rolls: oa.rolls,
        effects: [...oa.effects, { t: "spend", entity_id: actor.id, moves: 1 }, { t: "set_zone", entity_id: actor.id, zone_id: action.zone_id }],
        target_ids: [], mechanics: [`Move to ${zoneName}.`, ...oa.lines].join(" ") };
    }

    case "flee": {
      if (!me.economy.action) return { ok: false, reason: "You have already used your action." };
      if (!canMove(actor)) return { ok: false, reason: "You cannot move." };
      const oa = opportunityAttacks(s, rng, actor, lean);
      return { ok: true, type: "effect", payload: { flee: true }, rolls: oa.rolls,
        effects: [...oa.effects, { t: "spend", entity_id: actor.id, action: true }, { t: "mark", entity_id: actor.id, fled: true }, { t: "next_turn" }],
        target_ids: [], mechanics: [`${actor.name} flees the fight.`, ...oa.lines].join(" ") };
    }

    case "cast":
      return resolveCast(s, actor, action, rng, lean, me.economy);

    case "shove": {
      // 5e RAW: a shove REPLACES one of your attacks, so at these levels it costs your
      // action. BG3 makes it a bonus action, which is faster and is not the book — and
      // "do not bastardise D&D" was the brief.
      if (!me.economy.action) return { ok: false, reason: "You have already used your action." };
      const target = s.entities[action.target_id];
      if (!target || !target.alive) return { ok: false, reason: "There is nobody there to shove." };
      if (!sameZone(actor, target)) return { ok: false, reason: `${target.name} is not in reach.` };
      if (!canAct(actor)) return { ok: false, reason: "You cannot act." };

      // Contested: your Athletics against their Athletics OR Acrobatics, defender's choice,
      // which in practice means the better of the two.
      const atk = rollD20(rng, { purpose: "shove", mods: skillModifier(actor, "athletics"), target: null, lean });
      const defMod = Math.max(skillModifier(target, "athletics"), skillModifier(target, "acrobatics"));
      const def = rollD20(rng, { purpose: "shove_defence", mods: defMod, target: null });
      const won = atk.total > def.total;

      const effects: Effect[] = [{ t: "spend", entity_id: actor.id, action: true }];
      let mech = `Shove ${target.name}: ${atk.total} vs ${def.total} — `;

      if (!won) {
        mech += "they hold their ground.";
      } else if (action.mode === "prone") {
        effects.push({ t: "add_condition", entity_id: target.id, condition_id: "prone", duration_minutes: 0, rounds: 0 });
        mech += "knocked prone.";
      } else {
        const away = adjacentZones(s, actor.location_id, actor.zone_id).find((z) => z !== target.zone_id);
        if (away) { effects.push({ t: "set_zone", entity_id: target.id, zone_id: away }); mech += `pushed into ${away}.`; }
        else { effects.push({ t: "add_condition", entity_id: target.id, condition_id: "prone", duration_minutes: 0, rounds: 0 }); mech += "nowhere to push them, so they go down instead."; }
      }

      return { ok: true, type: "attack", payload: { shove: true, mode: action.mode, won },
        rolls: [atk, def], effects, target_ids: [target.id], mechanics: mech };
    }
  }
}

function resolveCast(s: GameState, caster: Entity, a: Extract<CombatAction, { type: "cast" }>, rng: Rng, lean: number, econ: { action: boolean; bonus: boolean }): CombatResult {
  const sp = SPELLS[a.spell_id];
  if (!sp) return { ok: false, reason: "That spell is not in this game yet." };
  if (!caster.class_id || !sp.classes.includes(caster.class_id)) return { ok: false, reason: `${caster.name} does not know ${sp.name}.` };
  if (!hasSlot(caster, sp.level)) return { ok: false, reason: `No ${ordinal(sp.level)}-level slots remaining.` };
  if (sp.cost === "action" && !econ.action) return { ok: false, reason: "You have already used your action." };
  if (sp.cost === "bonus" && !econ.bonus) return { ok: false, reason: "You have already used your bonus action." };
  if (!canAct(caster)) return { ok: false, reason: "You cannot act." };

  const effects: Effect[] = [];
  const rolls: Roll[] = [];
  const lines: string[] = [];
  if (sp.level > 0) effects.push({ t: "spend_slot", entity_id: caster.id, level: sp.level });
  effects.push({ t: "spend", entity_id: caster.id, ...(sp.cost === "bonus" ? { bonus: true } : { action: true }) });
  if (sp.concentration) effects.push({ t: "set_concentration", entity_id: caster.id, spell_id: sp.id });

  const mod = castingMod(caster);
  const dc = spellDC(caster.proficiency_bonus, mod);

  // Targets: one creature, or everyone hostile in a zone for area spells.
  let targets: Entity[];
  if (sp.area) {
    const zone = sp.range === "touch" ? caster.zone_id : (a.zone_id ?? s.entities[a.target_id ?? ""]?.zone_id ?? caster.zone_id);
    targets = Object.values(s.entities).filter((e) => e.alive && e.location_id === caster.location_id && (e.zone_id ?? "") === (zone ?? "") && e.id !== caster.id);
    if (sp.range === "near" && zone !== caster.zone_id && !adjacentZones(s, caster.location_id, caster.zone_id).includes(zone ?? "")) {
      return { ok: false, reason: "That zone is out of reach." };
    }
  } else {
    const t = a.target_id ? s.entities[a.target_id] : sp.range === "self" ? caster : undefined;
    if (!t) return { ok: false, reason: `${sp.name} needs a target.` };
    if (!inReach(s, caster, t, sp.range)) return { ok: false, reason: `${t.name} is out of reach for ${sp.name}.` };
    targets = [t];
  }

  for (const t of targets) {
    const r = sp.resolution;
    if (r.kind === "attack") {
      const atk = rollD20(rng, { purpose: `spell:${sp.id}`, mods: mod + caster.proficiency_bonus, target: t.ac, isAttack: true, lean });
      rolls.push(atk);
      if (atk.success) {
        const dmg = rollDamage(rng, r.damage, 0, atk.critical);
        rolls.push(dmg);
        effects.push({ t: "damage", entity_id: t.id, amount: dmg.total, damage_type: r.type }, ...concentrationCheck(s, rng, t, dmg.total));
        if (sp.id === "spell_guiding_bolt") effects.push({ t: "set_entity_flag", entity_id: t.id, key: "guided", value: true });
        lines.push(`${sp.name} at ${t.name}: ${fmt(atk)} — ${atk.critical ? "CRITICAL" : "hit"} for ${dmg.total} ${r.type}.`);
      } else lines.push(`${sp.name} at ${t.name}: ${fmt(atk)} — miss.`);
    } else if (r.kind === "save") {
      const tf = conditionFlags(t);
      const autoFail = tf.auto_fail_str_dex_saves && (r.ability === "str" || r.ability === "dex");
      const save = autoFail
        ? { purpose: "save", die: "d20", raw: 1, raw_second: null, mods: 0, total: 1, target: dc, success: false, critical: false, fumble: false, advantage: "none" as const, degree: "failure" as const, parts: [] }
        : rollD20(rng, { purpose: `save:${r.ability}`, mods: saveModifier(t, r.ability), target: dc });
      rolls.push(save);
      let line = `${sp.name}: ${t.name} ${r.ability.toUpperCase()} save ${fmt(save)} vs DC ${dc} — ${save.success ? "saved" : "FAILED"}`;
      if (r.damage) {
        const dmg = rollDamage(rng, r.damage, 0, false);
        rolls.push(dmg);
        const amount = save.success ? (r.half_on_save ? Math.floor(dmg.total / 2) : 0) : dmg.total;
        if (amount > 0) effects.push({ t: "damage", entity_id: t.id, amount, damage_type: r.type ?? "force" }, ...concentrationCheck(s, rng, t, amount));
        line += `, ${amount} ${r.type}`;
      }
      if (!save.success && r.condition) {
        effects.push({ t: "add_condition", entity_id: t.id, condition_id: r.condition, duration_minutes: 0, rounds: r.condition_rounds ?? 1 });
        line += `, ${r.condition}`;
      }
      lines.push(line + ".");
    } else {
      if (r.heal) {
        const amount = Math.max(1, rollDice(rng, r.heal) + mod);
        effects.push({ t: "heal", entity_id: t.id, amount });
        lines.push(`${sp.name} on ${t.name}: heals ${amount}.`);
      } else if (r.damage) {
        const amount = rollDice(rng, r.damage);
        effects.push({ t: "damage", entity_id: t.id, amount, damage_type: r.type ?? "force" }, ...concentrationCheck(s, rng, t, amount));
        lines.push(`${sp.name} at ${t.name}: ${amount} ${r.type}, no save.`);
      } else if (r.buff) {
        effects.push({ t: "set_entity_flag", entity_id: t.id, key: r.buff, value: true });
        lines.push(`${sp.name} on ${t.name}.`);
      }
    }
  }

  return { ok: true, type: "cast", payload: { spell_id: sp.id, level: sp.level, dc, targets: targets.map((t) => t.id) },
    rolls, effects, target_ids: targets.map((t) => t.id), mechanics: lines.join(" ") };
}

function ordinal(n: number): string { return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`; }

export { combatOver };
