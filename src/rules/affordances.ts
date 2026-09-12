import type { Skill } from "../schema/common.js";
import type { GameState } from "../schema/state.js";
import type { Action } from "../engine/turn.js";
import { abilityModOf, skillModifier } from "./checks.js";
import { collectSkillModifiers, combineModifiers } from "./modifiers.js";
import { countOfDef, itemsAt, itemsOwnedBy, mustEntity, npcsPresent, relationship, visibleExits } from "../state/selectors.js";
import { adjacentZones, combatantOf, currentCombatant, hasSlot, hitChance, inReach, sameZone, castingMod } from "../engine/combat.js";
import { conditionFlags, canMove } from "./conditions.js";
import { spellsFor, spellDC } from "../content/srd/spells.js";
import { canFastTravel, reachable } from "../engine/pathfind.js";
import { readApproaches, topicsFor } from "../engine/conversation.js";

/**
 * THE AFFORDANCE ENGINE.
 *
 * Baldur's Gate 3 teaches 5e through affordances: the bar shows what you can do, what it
 * costs, and what it will buy. You cannot take an illegal action because illegal actions
 * are not offered. You learn the rules by watching the budget move.
 *
 * This module enumerates YES in advance, where the resolver only says NO after the fact.
 * Everything it needs already exists — the resolver knows what is legal, the modifier
 * layer knows why a DC moved — so this is an inversion, not a second rules engine.
 *
 *   The buttons teach you the rules. The text box lets you exceed them.
 *
 * Unavailable actions are returned with `available: false` and a reason, never omitted.
 * "No 2nd-level slots remaining" teaches the resource; hiding the option teaches nothing.
 */

export type Cost = "action" | "bonus" | "movement" | "reaction" | "free" | "time";

export interface Affordance {
  action: Action;
  label: string;
  cost: Cost;
  /** The arithmetic the player is signing up for: "+7 stealth, dim light −2 DC". */
  detail: string;
  available: boolean;
  why_unavailable?: string;
  /** One line of rules, shown the first time this concept appears. Keyed for `taught`. */
  teaches?: { key: string; text: string };
  group: "move" | "talk" | "check" | "attack" | "item" | "rest" | "self" | "spell" | "turn";
  /** Hit chance in percent, where an attack roll is involved. */
  hit_chance?: number;
}

const TEACH = {
  skill_check: { key: "skill_check", text: "A check is d20 + your skill modifier against a Difficulty Class the DM sets. Meet or beat it and you succeed." },
  advantage: { key: "advantage", text: "Advantage rolls two d20s and keeps the higher. Disadvantage keeps the lower. They cancel each other out." },
  attack: { key: "attack", text: "An attack is d20 + ability + proficiency against the target's Armour Class. A natural 20 always hits and doubles the damage dice." },
  short_rest: { key: "short_rest", text: "A short rest is an hour. Spend hit dice to heal. A long rest is eight hours and restores everything." },
  death_save: { key: "death_save", text: "At 0 HP you are dying. Each turn roll a d20: 10 or more is a success. Three successes and you stabilise; three failures and you die." },
  locked: { key: "locked", text: "A locked way needs its key, or another way through." },
} as const;

export function affordances(s: GameState, actorId: string = s.meta.pc_id): Affordance[] {
  const actor = mustEntity(s, actorId);
  const loc = s.locations[actor.location_id]!;
  const out: Affordance[] = [];

  if (s.combat) return combatAffordances(s, actorId);

  // Down is down: the only affordance is the death save.
  if (actor.hp.current === 0) {
    out.push({
      action: { type: "death_save" }, label: "Roll a death save", cost: "action",
      detail: `d20 vs 10 · ${actor.death_saves.successes} successes, ${actor.death_saves.failures} failures`,
      available: !actor.stable, group: "self", teaches: TEACH.death_save,
      ...(actor.stable ? { why_unavailable: "You are stable. Someone must heal or wake you." } : {}),
    });
    return out;
  }

  // ---- movement
  for (const x of visibleExits(s, loc)) {
    const dest = s.locations[x.to];
    const locked = !!x.locked_by && countOfDef(s, actor.id, x.locked_by) < 1;
    let detail = `${x.travel_minutes} min`;
    if (x.requires_check) detail += ` · ${x.requires_check.skill} check (${x.requires_check.band})`;
    out.push({
      action: { type: "move", dir: x.dir }, label: `Go ${x.dir}${dest ? ` — ${dest.name}` : ""}`,
      cost: "time", detail, available: !locked && !!dest, group: "move",
      ...(locked ? { why_unavailable: `Locked. You need ${s.item_defs[x.locked_by!]?.name ?? "a key"}.`, teaches: TEACH.locked } : {}),
    });
  }

  // ---- people
  for (const e of npcsPresent(s, loc.id)) {
    const inParty = s.meta.party_ids.includes(e.id);
    out.push({ action: { type: "talk", target_id: e.id }, label: `Talk to ${e.name}`, cost: "action", detail: "5 min", available: true, group: "talk" });

    // What there is to talk ABOUT. Derived from what you know and what they know, so the
    // list grows with the campaign rather than being written branch by branch.
    for (const t of topicsFor(s, e.id).slice(0, 6)) {
      out.push({
        action: { type: "talk", target_id: e.id, topic_id: t.id, topic: t.label },
        label: t.label.charAt(0).toUpperCase() + t.label.slice(1),
        cost: "time",
        detail: t.asked ? "you have asked before" : t.kind,
        // A guarded topic is AVAILABLE — it just costs a check. Only a seal greys it out,
        // and a seal always says what would lift it.
        available: t.access.kind !== "sealed", group: "talk",
        ...(t.access.kind === "sealed"
          ? { why_unavailable: `${t.access.why} — ${t.access.opens_when}` }
          : {}),
        ...(t.access.kind === "guarded"
          ? { teaches: { key: "trust_gates", text: "Trust moves the DC, it does not decide the answer. Someone who barely knows you is harder to get things out of — not impossible." } }
          : t.access.kind === "sealed"
            ? { teaches: { key: "sealed_topics", text: "Some things no roll buys. Press anyway: rolling well will not get you the secret, but it can get you the key to it." } }
            : {}),
      });
    }

    const rel = relationship(s, e.id, actor.id);
    const reads = new Map(readApproaches(s, e.id).map((r) => [r.approach, r]));
    for (const skill of ["persuasion", "deception", "intimidation"] as const) {
      const mods = collectSkillModifiers({ actor, skill, location: loc, relationship: rel });
      const { dc_delta, advantage } = combineModifiers(mods);
      const read = reads.get(skill === "persuasion" ? "persuade" : skill === "deception" ? "deceive" : "intimidate");
      out.push({
        action: { type: "skill_check", skill, band: "medium", target_id: e.id },
        label: `${cap(skill)} ${e.name}`, cost: "action",
        detail: fmtCheck(skillModifier(actor, skill), dc_delta, advantage, mods.map((m) => m.reason)),
        // A check that cannot succeed is not offered as a roll. Letting someone roll
        // Persuasion on something the NPC will never do wastes their turn and teaches
        // them the dice do not matter.
        available: read?.possible ?? true, group: "check",
        ...(read && !read.possible ? { why_unavailable: read.why_not ?? "" } : {}),
        teaches: advantage !== "none" ? TEACH.advantage : TEACH.skill_check,
      });
    }

    const weaponInst = actor.equipped.main_hand ? s.items[actor.equipped.main_hand] : undefined;
    const weapon = weaponInst ? s.item_defs[weaponInst.def_id] : undefined;
    const finesse = weapon?.properties.includes("finesse") ?? false;
    const abil = finesse && abilityModOf(actor, "dex") >= abilityModOf(actor, "str") ? "dex" : "str";
    const toHit = abilityModOf(actor, abil) + actor.proficiency_bonus;
    // Attacking a companion is legal — you can type it — but the bar never proposes it.
    if (inParty) continue;
    out.push({
      action: { type: "attack", target_id: e.id }, label: `Attack ${e.name}`, cost: "action",
      detail: `${weapon?.damage?.dice ?? "1d4"}${fmtMod(abilityModOf(actor, abil))} ${weapon?.damage?.type ?? "bludgeoning"} · ${fmtMod(toHit)} to hit vs AC ${e.ac}`,
      available: e.alive, group: "attack", teaches: TEACH.attack,
      ...(e.alive ? {} : { why_unavailable: `${e.name} is dead.` }),
    });
  }

  // ---- the room
  const searchable: Skill[] = ["investigation", "perception"];
  for (const skill of searchable) {
    const mods = collectSkillModifiers({ actor, skill, location: loc });
    const { dc_delta, advantage } = combineModifiers(mods);
    out.push({
      action: { type: "skill_check", skill, band: "medium", tag: skill === "investigation" ? "search" : "listen" },
      label: skill === "investigation" ? "Search here" : "Listen and watch", cost: "action",
      detail: fmtCheck(skillModifier(actor, skill), dc_delta, advantage, mods.map((m) => m.reason)),
      available: true, group: "check", teaches: advantage !== "none" ? TEACH.advantage : TEACH.skill_check,
    });
  }
  out.push({ action: { type: "look" }, label: "Look around", cost: "free", detail: "", available: true, group: "self" });

  for (const i of itemsAt(s, loc.id)) {
    const def = s.item_defs[i.def_id];
    out.push({ action: { type: "take", item_instance_id: i.id }, label: `Take ${def?.name ?? i.def_id}`, cost: "action", detail: "", available: true, group: "item" });
  }

  // ---- what the things you are carrying let you do
  //
  // The Hitchhiker's fix: never make the player guess whether the game modelled their
  // crowbar. Carrying one puts "Pry open the door" on the bar, with the tool named.
  for (const inst of itemsOwnedBy(s, actor.id)) {
    const def = s.item_defs[inst.def_id];
    if (!def) continue;
    for (const g of def.grants) {
      let applies = false;
      let note = "";
      if (g.requires.t === "location_flag") {
        applies = loc.flags[g.requires.key] === true;
      } else if (g.requires.t === "feature") {
        const f = loc.features.find((x) => x.interactions.includes(g.requires.t === "feature" ? g.requires.interaction : ""));
        applies = !!f;
        if (f) note = ` — ${f.name}`;
      } else {
        const locked = visibleExits(s, loc).find((x) => x.locked_by && countOfDef(s, actor.id, x.locked_by) < 1);
        applies = !!locked;
        if (locked) note = ` — the way ${locked.dir}`;
      }
      if (!applies) continue;
      out.push({
        action: { type: "skill_check", skill: g.skill, band: g.band, tag: g.tag },
        label: `${g.verb}${note}`,
        cost: "action",
        detail: `${g.skill} ${fmtMod(skillModifier(actor, g.skill))}${g.advantage ? " · advantage" : ""} · using your ${def.name.toLowerCase()}`,
        available: true, group: "check",
        teaches: { key: `grant_${g.tag}`, text: `Carrying the right tool opens up actions you would not otherwise have. Your ${def.name.toLowerCase()} makes this possible.` },
      });
    }
  }

  // ---- gear
  for (const i of itemsOwnedBy(s, actor.id)) {
    const def = s.item_defs[i.def_id];
    if (!def) continue;
    const equipped = Object.values(actor.equipped).includes(i.id);
    const slot = def.kind === "armor" ? "armor" : def.kind === "shield" ? "off_hand" : def.kind === "weapon" ? "main_hand" : null;
    if (!slot) continue;
    out.push({
      action: { type: "equip", item_instance_id: i.id, slot: equipped ? null : slot },
      label: `${equipped ? "Unequip" : "Equip"} ${def.name}`, cost: "free",
      detail: def.ac_base != null ? `AC ${def.ac_base}${def.dex_cap != null ? ` + dex (max ${def.dex_cap})` : " + dex"}` : def.damage ? `${def.damage.dice} ${def.damage.type}` : "",
      available: true, group: "item",
    });
  }

  // ---- rest
  const hd = actor.resources.hit_dice;
  out.push({
    action: { type: "rest", kind: "short" }, label: "Short rest", cost: "time",
    detail: `1 hour · ${hd.max - hd.used} hit ${hd.max - hd.used === 1 ? "die" : "dice"} left`,
    available: hd.used < hd.max || actor.hp.current === actor.hp.max, group: "rest", teaches: TEACH.short_rest,
    ...(hd.used >= hd.max && actor.hp.current < actor.hp.max ? { why_unavailable: "No hit dice left. A long rest restores them." } : {}),
  });
  out.push({ action: { type: "rest", kind: "long" }, label: "Long rest", cost: "time", detail: "8 hours · full HP, all hit dice", available: true, group: "rest", teaches: TEACH.short_rest });

  // ---- fast travel, over ground already covered
  const gate = canFastTravel(s);
  for (const { id, path } of reachable(s, loc.id).slice(0, 6)) {
    const dest = s.locations[id]!;
    out.push({
      action: { type: "travel", location_id: id },
      label: `Travel to ${dest.name}`,
      cost: "time",
      detail: `${path.minutes} min${path.danger >= 2 ? ` · risky ground` : ""}`,
      available: gate.ok, group: "move",
      ...(gate.ok ? {} : { why_unavailable: gate.reason }),
      teaches: { key: "fast_travel", text: "You can travel straight to anywhere you have already been. It costs the real time, so deadlines still run — it saves you the retyping, not the journey." },
    });
  }

  return out;
}

/**
 * The action bar. Action / Bonus / Movement / Reaction are distinct pips; each option says
 * which pip it spends, and a spent pip greys everything that needed it — with the reason.
 */
export function combatAffordances(s: GameState, actorId: string): Affordance[] {
  const c = s.combat!;
  const actor = mustEntity(s, actorId);
  const me = combatantOf(c, actor.id);
  const out: Affordance[] = [];
  if (!me) return out;
  const myTurn = currentCombatant(c).entity_id === actor.id;
  const notYours = myTurn ? undefined : `It is ${s.entities[currentCombatant(c).entity_id]!.name}'s turn.`;
  const gate = (need: "action" | "bonus" | "moves" | null, extra?: string): { available: boolean; why_unavailable?: string } => {
    if (notYours) return { available: false, why_unavailable: notYours };
    if (extra) return { available: false, why_unavailable: extra };
    if (need === "action" && !me.economy.action) return { available: false, why_unavailable: "You have used your action this turn." };
    if (need === "bonus" && !me.economy.bonus) return { available: false, why_unavailable: "You have used your bonus action this turn." };
    if (need === "moves" && me.economy.moves <= 0) return { available: false, why_unavailable: "No movement left. Dash spends your action for another zone." };
    return { available: true };
  };

  if (actor.hp.current === 0) {
    out.push({ action: { type: "death_save" }, label: "Roll a death save", cost: "action",
      detail: `d20 vs 10 · ${actor.death_saves.successes}✓ ${actor.death_saves.failures}✗`, group: "self", teaches: TEACH.death_save, ...gate(null, actor.stable ? "You are stable." : undefined) });
    return out;
  }

  const flags = conditionFlags(actor);
  const weaponInst = actor.equipped.main_hand ? s.items[actor.equipped.main_hand] : undefined;
  const weapon = weaponInst ? s.item_defs[weaponInst.def_id] : undefined;
  const finesse = weapon?.properties.includes("finesse") ?? false;
  const abil = finesse && abilityModOf(actor, "dex") >= abilityModOf(actor, "str") ? "dex" : "str";
  const toHit = abilityModOf(actor, abil) + actor.proficiency_bonus;

  for (const cb of c.order) {
    if (cb.side === me.side || cb.fled) continue;
    const t = s.entities[cb.entity_id]!;
    if (!t.alive) continue;
    const tf = conditionFlags(t);
    let adv = 0; if (tf.attacks_against_adv) adv++; if (tf.attacks_against_disadv || cb.economy.dodging) adv--; if (flags.own_attacks_disadv) adv--;
    const advantage = adv > 0 ? "advantage" : adv < 0 ? "disadvantage" : "none";
    const reach = sameZone(actor, t);
    const pct = hitChance(toHit, t.ac, advantage);
    out.push({ action: { type: "attack", target_id: t.id }, label: `Attack ${t.name}`, cost: "action",
      detail: `${pct}% to hit · ${weapon?.damage?.dice ?? "1d4"}${fmtMod(abilityModOf(actor, abil))} ${weapon?.damage?.type ?? "bludgeoning"}${advantage !== "none" ? ` · ${advantage}` : ""}`,
      hit_chance: pct, group: "attack", teaches: TEACH.attack,
      ...gate("action", reach ? undefined : `${t.name} is in another zone. Move first.`) });
  }

  for (const sp of spellsFor(actor.class_id, actor.level)) {
    const slotOk = hasSlot(actor, sp.level);
    const need = sp.cost === "bonus" ? "bonus" : "action";
    const dc = spellDC(actor.proficiency_bonus, castingMod(actor));
    const targets = sp.range === "self" ? [actor]
      : Object.values(s.entities).filter((e) => e.alive && e.location_id === actor.location_id && e.id !== actor.id && inReach(s, actor, e, sp.range)
          && (sp.resolution.kind === "auto" && "heal" in sp.resolution ? c.order.some((x) => x.entity_id === e.id && x.side === me.side) : c.order.some((x) => x.entity_id === e.id && x.side !== me.side)));
    const detail = sp.resolution.kind === "attack" ? `spell attack ${fmtMod(castingMod(actor) + actor.proficiency_bonus)} · ${sp.resolution.damage} ${sp.resolution.type}`
      : sp.resolution.kind === "save" ? `${sp.resolution.ability.toUpperCase()} save DC ${dc}${sp.resolution.damage ? ` · ${sp.resolution.damage} ${sp.resolution.type}` : ""}${sp.resolution.condition ? ` · ${sp.resolution.condition}` : ""}`
      : "heal" in sp.resolution && sp.resolution.heal ? `heals ${sp.resolution.heal}${fmtMod(castingMod(actor))}` : sp.resolution.damage ? `${sp.resolution.damage} ${sp.resolution.type}, no roll` : "buff";
    const slotWhy = slotOk ? undefined : sp.level === 0 ? undefined : `No level-${sp.level} slots left.`;
    if (sp.area || targets.length === 0) {
      out.push({ action: { type: "cast", spell_id: sp.id, ...(sp.area ? { zone_id: actor.zone_id ?? undefined } : {}) } as Affordance["action"],
        label: `Cast ${sp.name}${sp.level ? ` (L${sp.level})` : ""}`, cost: sp.cost === "bonus" ? "bonus" : "action", detail, group: "spell",
        teaches: { key: `spell_${sp.resolution.kind}`, text: sp.teach }, ...gate(need, slotWhy ?? (targets.length === 0 && !sp.area ? "Nobody in reach." : undefined)) });
    } else {
      for (const t of targets.slice(0, 4)) {
        out.push({ action: { type: "cast", spell_id: sp.id, target_id: t.id }, label: `Cast ${sp.name}${sp.level ? ` (L${sp.level})` : ""} → ${t.name}`,
          cost: sp.cost === "bonus" ? "bonus" : "action", detail, group: "spell", teaches: { key: `spell_${sp.resolution.kind}`, text: sp.teach }, ...gate(need, slotWhy) });
      }
    }
  }

  for (const z of adjacentZones(s, actor.location_id, actor.zone_id)) {
    const name = s.locations[actor.location_id]!.zones.find((x) => x.id === z)?.name ?? z;
    const threatened = c.order.some((x) => x.side !== me.side && !x.fled && x.economy.reaction && sameZone(actor, s.entities[x.entity_id]!) && (s.entities[x.entity_id]!.hp.current > 0));
    out.push({ action: { type: "move_zone", zone_id: z }, label: `Move to ${name}`, cost: "movement",
      detail: threatened && !me.economy.disengaged ? "provokes an opportunity attack" : "", group: "move",
      ...gate("moves", canMove(actor) ? undefined : "You cannot move.") });
  }

  out.push({ action: { type: "dash" }, label: "Dash", cost: "action", detail: "+1 zone of movement", group: "turn", ...gate("action") });
  out.push({ action: { type: "disengage" }, label: "Disengage", cost: "action", detail: "leave without provoking", group: "turn", ...gate("action") });
  out.push({ action: { type: "dodge" }, label: "Dodge", cost: "action", detail: "attacks on you have disadvantage", group: "turn", ...gate("action") });
  out.push({ action: { type: "flee" }, label: "Flee the fight", cost: "action", detail: "may provoke; you are out of the fight", group: "turn", ...gate("action") });
  out.push({ action: { type: "end_turn" }, label: "End turn", cost: "free", detail: `round ${c.round}`, group: "turn", ...gate(null) });
  return out;
}

/** Only the affordances whose `teaches` key has not been shown yet. */
export function untaught(s: GameState, list: readonly Affordance[]): Affordance[] {
  return list.filter((a) => a.teaches && !s.meta.taught.includes(a.teaches.key));
}

function fmtCheck(mod: number, dcDelta: number, adv: string, reasons: string[]): string {
  const parts = [`d20 ${fmtMod(mod)}`];
  if (dcDelta !== 0) parts.push(`DC ${fmtMod(dcDelta)}`);
  if (adv !== "none") parts.push(adv);
  if (reasons.length) parts.push(`(${reasons.join("; ")})`);
  return parts.join(" · ");
}
function fmtMod(n: number): string { return n >= 0 ? `+${n}` : `${n}`; }
function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
