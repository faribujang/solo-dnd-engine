import type { DifficultyBand, Roll, Skill } from "../schema/common.js";
import type { Effect } from "../schema/dsl.js";
import type { GameEvent } from "../schema/event.js";
import type { GameState } from "../schema/state.js";
import { rollD20, rollDamage } from "../rules/dice.js";
import { abilityModOf, dcForBand, skillModifier, skillParts, DEGREE_LABEL } from "../rules/checks.js";
void abilityModOf; void combatOver;
import { collectSkillModifiers, combineModifiers } from "../rules/modifiers.js";
import { Rng, freshNonce, karmicLean, seedFor, seedToState } from "../rules/rng.js";
import { worldTick } from "./ambient.js";
import { leversOf } from "../rules/difficulty.js";
import { agendaOf, backgroundLabel, pressOutcome, SEALED_DC, topicsFor, wouldWalkAway, type PressResult } from "./conversation.js";
import { audiencePressure } from "./bystanders.js";
import { insightsFor } from "../rules/backgrounds.js";
import { canUse, featureById, featureOfKind } from "../rules/features.js";
import { levelUpPlan } from "../rules/character.js";
import { levelForXp } from "../rules/progression.js";
import { CLASSES } from "../content/srd/data.js";
import { hasInspiration } from "../rules/inspiration.js";
import { MONTAGE, crowdFor, describeMontage, harvestable, yieldFor, type MontageKind } from "../rules/montage.js";
import type { Modifier } from "../rules/modifiers.js";

/**
 * Four including the player, per the settled decision in the spec. A fifth is not a party,
 * it is a queue.
 */
export const MAX_PARTY = 4;

/**
 * Trust needed before someone will travel with you. Higher than confiding a secret
 * (SECRET_TRUST, 25), because following someone into danger is the larger commitment.
 */
export const RECRUIT_TRUST = 35;
import { arrivalEffects } from "../rules/reputation.js";
import { canFastTravel, findPath, travelEffects, type Path } from "./pathfind.js";
import { rollEncounters } from "./encounters.js";
import { buyPrice, formatCoin, purseOf, sellPrice, stockOf } from "../rules/economy.js";
import { beginCombatEffects, combatOver, resolveCombat, weaponAttack, type CombatAction } from "./combatActions.js";
import { combatantOf, currentCombatant } from "./combat.js";
import {
  countOfDef, entitiesAt, mustEntity, mustLocation, pc, relationship, visibleExits,
} from "../state/selectors.js";

/**
 * Step 2 of the pipeline: VALIDATE AND RESOLVE.
 *
 * This is the only module that rolls dice. It reads state, refuses illegal actions, rolls,
 * and bakes every outcome into an event as concrete numbers. The reducer that consumes
 * that event contains no randomness at all, which is what makes a replay exact.
 *
 * In phase 1 the LLM's intent parser will emit exactly this `Action` shape. Nothing here
 * changes when it does — the parser replaces the CLI, not the resolver.
 */

export type Action =
  | { type: "move"; dir: string }
  // `tag` names what the check was FOR ("read_ledger", "search"). It lands in the payload
  // so authored triggers can match a specific attempt rather than any skill check at all.
  | { type: "skill_check"; skill: Skill; band: DifficultyBand; target_id?: string; tag?: string; use_inspiration?: boolean }
  | { type: "attack"; target_id: string }
  | { type: "talk"; target_id: string; topic?: string; topic_id?: string }
  | { type: "take"; item_instance_id: string }
  | { type: "give"; target_id: string; item_instance_id: string }
  | { type: "look" }
  | { type: "wait"; minutes: number }
  /**
   * Hours, not a moment. One roll, real time, several beats — see rules/montage.ts.
   * The verb that lets a player say "I spend the morning asking after him" and be
   * answered, instead of being asked which single person they meant.
   */
  | { type: "montage"; kind: MontageKind; topic: string; band: DifficultyBand }
  | { type: "rest"; kind: "short" | "long" }
  | { type: "death_save" }
  | { type: "equip"; item_instance_id: string; slot: "main_hand" | "off_hand" | "armor" | "trinket" | null }
  | { type: "travel"; location_id: string }
  | { type: "buy"; merchant_id: string; item_def_id: string; qty?: number }
  | { type: "sell"; merchant_id: string; item_instance_id: string }
  | { type: "recruit"; target_id: string }
  | { type: "use_feature"; feature_id: string; target_id?: string; amount?: number }
  | { type: "level_up" }
  | CombatAction;

export interface Resolution {
  ok: true;
  event: GameEvent;
  /** Player-facing summary of the mechanics. The narrator gets this verbatim in phase 1. */
  mechanics: string;
}

export interface Refusal {
  ok: false;
  /** Why the action was impossible. Impossible actions are refused, never rolled for. */
  reason: string;
}

export type ResolveResult = Resolution | Refusal;

/** Durations in minutes. Every action costs time; this is what makes deadlines real. */
const DURATION = {
  skill_check: 1,
  attack: 1,
  talk: 5,
  take: 1,
  look: 1,
  short_rest: 60,
  long_rest: 480,
} as const;

export function resolve(s: GameState, action: Action, opts?: { nonce?: string; actorId?: string }): ResolveResult {
  const actor = opts?.actorId ? mustEntity(s, opts.actorId) : pc(s);
  const loc = mustLocation(s, actor.location_id);
  const turn = s.meta.turn + 1;
  // Which entropy the dice draw from is a session-zero choice. `committed` seeds from the
  // situation so a rewind cannot reroll; `true` and `karmic` draw fresh entropy and record
  // it as a nonce so replay is still exact. See schema/campaign.ts and rules/rng.ts.
  const mode = s.meta.session_zero.dice;
  const nonce = opts?.nonce ?? (mode === "committed" ? "" : freshNonce());
  const rng = new Rng(
    mode === "committed"
      ? seedFor(s.meta.seed, turn, actor.id, actionKey(action))
      : seedToState(`${s.meta.seed}|${nonce}`),
  );
  const levers = leversOf(s);
  const lean = mode === "karmic" ? karmicLean(actor.recent_d20s) * (levers.karmic_strength / 0.35) : 0;

  const base: GameEvent = {
    id: `evt_r${String(turn).padStart(4, "0")}`,
    turn,
    world_minute: s.world.world_minute,
    type: "observe",
    actor_id: actor.id,
    location_id: loc.id,
    target_ids: [],
    payload: {},
    rolls: [],
    direct_effects: [],
    attitude_impact: [],
    witnesses: [],
    fact_ids: [],
    duration_minutes: 0,
    rng_nonce: nonce,
    derived_from: null,
    trigger_id: null,
  };

  const finish = (
    e: Partial<GameEvent> & Pick<GameEvent, "type">,
    mechanics: string,
  ): Resolution => ({
    ok: true,
    mechanics,
    event: { ...base, ...e },
  });

  // In a fight, it has to be your turn, and out-of-combat verbs are off the table.
  const COMBAT_ONLY = new Set(["end_turn", "dash", "disengage", "dodge", "move_zone", "flee", "shove"]);
  /**
   * What genuinely cannot happen mid-fight. Note how short this is: improvised skill
   * checks, brief speech and grabbing something off the floor all WORK in combat, because
   * they work at a real table. A fight that only accepts the six verbs on the bar is the
   * thing we said we would not build.
   */
  const NOT_IN_COMBAT = new Set(["rest", "wait", "travel", "buy", "sell", "move"]);
  if (s.combat) {
    if (currentCombatant(s.combat).entity_id !== actor.id && action.type !== "death_save") {
      return { ok: false, reason: `It is ${s.entities[currentCombatant(s.combat).entity_id]!.name}'s turn.` };
    }
    if (NOT_IN_COMBAT.has(action.type)) {
      return { ok: false, reason: action.type === "move"
        ? "Not while they can still reach you — flee if you want out of this."
        : "Not in the middle of a fight." };
    }
  } else if (COMBAT_ONLY.has(action.type)) {
    return { ok: false, reason: "You are not in a fight." };
  }

  // A fight that was queued by a trigger begins now, on the first thing anyone does.
  const pending = s.world.flags["pending_combat"];
  if (!s.combat && Array.isArray(pending) && pending.length) {
    const begin = beginCombatEffects(s, rng, actor, pending as string[]);
    return finish({ type: "combat_start", payload: { enemies: pending }, direct_effects: begin.effects, duration_minutes: 0 }, begin.mech);
  }

  // Down is down. At 0 HP the only things you can do are roll a death save or be helped.
  if (actor.hp.current === 0 && action.type !== "death_save") {
    if (actor.stable) return { ok: false, reason: `${actor.name} is unconscious but stable. Someone must heal or wake them.` };
    return { ok: false, reason: `${actor.name} is dying. Roll a death save.` };
  }

  switch (action.type) {
    // ---------------------------------------------------------- death save
    case "death_save": {
      if (actor.hp.current > 0) return { ok: false, reason: `${actor.name} is not dying.` };
      if (actor.stable) return { ok: false, reason: `${actor.name} is already stable.` };
      const roll = rollD20(rng, { purpose: "death_save", mods: 0, target: 10, lean });
      const outcome = roll.raw === 20 ? "crit_success" : roll.raw === 1 ? "crit_failure" : roll.success ? "success" : "failure";
      const label = { crit_success: "NATURAL 20 — back on your feet with 1 HP", crit_failure: "natural 1 — two failures",
        success: "success", failure: "failure" }[outcome];
      return finish(
        {
          type: "death_save",
          payload: { outcome, successes: actor.death_saves.successes, failures: actor.death_saves.failures },
          rolls: [roll],
          direct_effects: [{ t: "death_save", entity_id: actor.id, outcome }, ...(s.combat ? [{ t: "next_turn" as const }] : [])],
          duration_minutes: 0,
          witnesses: witnessIds(s, loc.id, actor.id),
        },
        `Death save: d20 ${roll.raw} vs 10 — ${label}.`,
      );
    }

    // ---------------------------------------------------------------- equip
    case "equip": {
      const inst = s.items[action.item_instance_id];
      if (!inst || inst.owner.t !== "entity" || inst.owner.id !== actor.id) return { ok: false, reason: "You are not carrying that." };
      const def = s.item_defs[inst.def_id];
      if (action.slot === "armor" && def?.kind !== "armor") return { ok: false, reason: `${def?.name ?? "That"} is not armour.` };
      if (action.slot === "off_hand" && def?.kind !== "shield" && !def?.properties.includes("light")) {
        return { ok: false, reason: `${def?.name ?? "That"} cannot be held in the off hand.` };
      }
      return finish(
        {
          type: "effect",
          payload: { equip: inst.id, slot: action.slot },
          direct_effects: [{ t: "equip", entity_id: actor.id, instance_id: inst.id, slot: action.slot }],
          duration_minutes: 1,
        },
        action.slot ? `Equip ${def?.name ?? inst.id} (${action.slot}).` : `Unequip ${def?.name ?? inst.id}.`,
      );
    }

    // ---------------------------------------------------------------- move
    case "move": {
      const exits = visibleExits(s, loc);
      const exit = exits.find((x) => x.dir.toLowerCase() === action.dir.toLowerCase());
      if (!exit) {
        return { ok: false, reason: `There is no way ${action.dir} from ${loc.name}.` };
      }
      if (!s.locations[exit.to]) {
        return { ok: false, reason: `The way ${exit.dir} leads nowhere yet.` };
      }
      if (exit.locked_by && countOfDef(s, actor.id, exit.locked_by) < 1) {
        const def = s.item_defs[exit.locked_by];
        return { ok: false, reason: `The way ${exit.dir} is locked. You would need ${def?.name ?? "a key"}.` };
      }

      const effects: Effect[] = [];
      let mech = `Move ${exit.dir} to ${s.locations[exit.to]!.name} (${exit.travel_minutes} min).`;

      if (exit.requires_check) {
        const skill = exit.requires_check.skill;
        const dc = dcForBand(exit.requires_check.band, levers.dc_shift);
        const roll = check(s, rng, actor.id, skill, dc, `move_${exit.dir}`, undefined, lean);
        if (roll.degree === "failure") {
          return finish(
            {
              type: "skill_check",
              target_ids: [],
              payload: { skill, dc: roll.target, outcome: "failure", blocked_exit: exit.dir },
              rolls: [roll],
              direct_effects: [],
              duration_minutes: DURATION.skill_check,
              witnesses: [],
            },
            `${skill} check to go ${exit.dir}: ${fmt(roll)} — FAILED. You do not get through.`,
          );
        }
        mech = `${skill} check to go ${exit.dir}: ${fmt(roll)} — passed. ${mech}`;
        base.rolls.push(roll);
      }

      effects.push({ t: "move_entity", entity_id: actor.id, location_id: exit.to });
      if (exit.hidden_until_flag) effects.push({ t: "reveal_exit", location_id: loc.id, dir: exit.dir });
      // Whoever is through that door has already heard of you, if anyone has.
      effects.push(...meetingEffects(s, exit.to));

      return finish(
        {
          type: "move",
          target_ids: [],
          payload: { from: loc.id, to: exit.to, dir: exit.dir },
          rolls: base.rolls,
          direct_effects: effects,
          duration_minutes: exit.travel_minutes,
          witnesses: [],
        },
        mech,
      );
    }

    // ---------------------------------------------------------- skill check
    case "skill_check": {
      if (s.combat) {
        const me = combatantOf(s.combat, actor.id);
        if (me && !me.economy.action) {
          return { ok: false, reason: "You have already used your action this turn." };
        }
      }
      // Inspiration is declared BEFORE the roll and bought for advantage — see
      // rules/inspiration.ts for why this game spends it that way rather than as a reroll.
      const spending = action.use_inspiration === true;
      if (spending && !hasInspiration(actor)) {
        return { ok: false, reason: "You have no Inspiration to spend." };
      }

      const dc = dcForBand(action.band, levers.dc_shift);
      const roll = check(
        s, rng, actor.id, action.skill, dc, action.skill, action.target_id, lean,
        spending ? [{ source: "inspiration", reason: "Inspiration", dc_delta: 0, advantage: "advantage" }] : [],
      );
      const checkEffects: Effect[] = [];
      if (spending) checkEffects.push({ t: "spend_inspiration", entity_id: actor.id });
      // A cost band counts as a success for triggers and for the fiction — the player got
      // what they reached for. The complication is the narrator's to invent, within the
      // constraint that it must not touch a number.
      const got = roll.degree === "failure" ? false : true;
      const payload: Record<string, unknown> = {
        skill: action.skill,
        band: action.band,
        dc: roll.target,
        outcome: roll.degree ?? (roll.success ? "success" : "failure"),
      };
      if (action.tag) {
        payload[action.tag] = true;
        if (got) payload[`success_${action.tag}`] = true;
      }
      if (spending) payload["inspiration_spent"] = true;
      return finish(
        {
          type: "skill_check",
          target_ids: action.target_id ? [action.target_id] : [],
          payload: payload as GameEvent["payload"],
          rolls: [roll],
          // Improvising in a fight is your action, same as swinging. Out of one it is
          // just a minute of your day.
          direct_effects: [
            ...checkEffects,
            ...(s.combat ? [{ t: "spend" as const, entity_id: actor.id, action: true }] : []),
          ],
          duration_minutes: s.combat ? 0 : DURATION.skill_check,
          witnesses: witnessIds(s, loc.id, actor.id),
        },
        `${action.skill} (DC ${roll.target}): ${fmt(roll)} — ${DEGREE_LABEL[roll.degree ?? "failure"]}.`,
      );
    }

    // ------------------------------------------------------------- montage
    case "montage": {
      // A montage is hours of legwork. You cannot do it in the middle of a fight, and the
      // refusal says so plainly rather than listing zones.
      if (s.combat) return { ok: false, reason: "Not in the middle of a fight." };

      const spec = MONTAGE[action.kind];
      const crowd = crowdFor(s, loc.id);
      if (action.kind === "ask_around" && crowd.length === 0) {
        return { ok: false, reason: "There is nobody here to ask." };
      }

      const dc = dcForBand(action.band, levers.dc_shift);
      const roll = check(s, rng, actor.id, spec.skill, dc, `montage_${action.kind}`, undefined, lean);
      const got = roll.degree !== "failure";

      // CODE picks what the hours turned up. The model is handed the list and asked to
      // describe a morning — it never decides what is true, only how it was found out.
      const available = harvestable(s, action.topic, crowd);
      const learned = available.slice(0, yieldFor(roll.degree, got));

      const effects: Effect[] = learned.map((f) => ({ t: "teach_fact", entity_id: actor.id, fact_id: f.id }));

      const payload: Record<string, unknown> = {
        kind: action.kind,
        topic: action.topic,
        skill: spec.skill,
        dc: roll.target,
        outcome: roll.degree ?? (got ? "success" : "failure"),
        learned_fact_ids: learned.map((f) => f.id),
        asked: crowd.length,
        // What the narrator needs to write the montage: the beats, in order, as facts.
        beats: learned.map((f) => f.text),
      };
      payload[`montage_${action.kind}`] = true;
      if (got) payload[`success_montage_${action.kind}`] = true;

      return finish(
        {
          type: "skill_check",
          target_ids: [],
          payload: payload as GameEvent["payload"],
          rolls: [roll],
          direct_effects: effects,
          // The cost, and the whole reason this is not free: clocks run for every minute.
          duration_minutes: spec.minutes,
          witnesses: witnessIds(s, loc.id, actor.id),
        },
        describeMontage(s, action.kind, action.topic, learned),
      );
    }

    // -------------------------------------------------------------- attack
    case "attack": {
      const target = s.entities[action.target_id];
      if (!target) return { ok: false, reason: `There is no ${action.target_id} here.` };
      if (target.location_id !== loc.id) return { ok: false, reason: `${target.name} is not here.` };
      if (!target.alive) return { ok: false, reason: `${target.name} is already dead.` };

      const effects: Effect[] = [];
      const rolls: Roll[] = [];
      let mech = "";

      if (s.combat) {
        const me = combatantOf(s.combat, actor.id)!;
        if (!me.economy.action) return { ok: false, reason: "You have already used your action this turn." };
        if ((actor.zone_id ?? "") !== (target.zone_id ?? "")) {
          return { ok: false, reason: `${target.name} is not in reach. Move to their zone first.` };
        }
        effects.push({ t: "spend", entity_id: actor.id, action: true });
      } else {
        // Drawing steel starts the fight. Everyone hostile here joins; you go first.
        const hostiles = Object.values(s.entities)
          .filter((e) => e.alive && e.location_id === loc.id && e.id !== actor.id && !s.meta.party_ids.includes(e.id))
          .filter((e) => e.kind === "monster" || e.id === target.id || e.faction_ids.some((f) => target.faction_ids.includes(f)))
          .map((e) => e.id);
        const begin = beginCombatEffects(s, rng, actor, hostiles);
        effects.push(...begin.effects);
        mech = begin.mech + " ";
        if (!target.zone_id || !actor.zone_id) { /* no zones authored: everyone shares one */ }
        else if (actor.zone_id !== target.zone_id) effects.push({ t: "set_zone", entity_id: actor.id, zone_id: target.zone_id });
        effects.push({ t: "spend", entity_id: actor.id, action: true });
      }

      // EXTRA ATTACK. The Attack action buys more than one swing from level 5, which is
      // the single biggest power jump a martial character gets and the reason a fighter
      // stops feeling like a wizard with a sword.
      //
      // Both swings resolve NOW, against the same target, and both land in one event: a
      // player who has to press attack twice for one action has been taught the economy
      // wrong. A target that drops on the first swing stops the sequence.
      const attacks = featureOfKind(actor, "extra_attack")?.effect.attacks ?? 1;
      let hit = false;
      let damage = 0;
      let dropped = false;

      for (let n = 0; n < attacks && !dropped; n++) {
        const swing = weaponAttack(s, rng, actor, target, lean);
        rolls.push(...swing.rolls);
        effects.push(...swing.effects);
        mech += (n > 0 ? " Then: " : "") + swing.mech;
        hit = hit || swing.hit;
        damage += swing.damage;
        // Effects have not been applied yet — they are baked onto the event — so track the
        // running total rather than reading hp, which has not moved.
        if (damage >= target.hp.current) dropped = true;
      }

      return finish(
        {
          type: "attack",
          target_ids: [target.id],
          payload: { hit, damage, attacks },
          rolls,
          direct_effects: effects,
          duration_minutes: s.combat ? 0 : DURATION.attack,
          witnesses: witnessIds(s, loc.id, actor.id),
        },
        mech,
      );
    }

    // ---------------------------------------------------------------- talk
    case "talk": {
      const target = s.entities[action.target_id];
      if (!target) return { ok: false, reason: `There is no ${action.target_id} here.` };
      if (target.location_id !== loc.id) return { ok: false, reason: `${target.name} is not here.` };
      if (!target.alive) return { ok: false, reason: `${target.name} is beyond conversation.` };

      // Talking enters a conversation rather than firing a one-shot. Topics, what they
      // will and will not discuss, and their own agenda all come with it.
      const already = s.conversation?.with_id === target.id;
      const topics = topicsFor(s, target.id);
      // By id where the bar supplied one; otherwise a best-effort label match for free
      // text, which may find nothing and that is fine — you can talk without a topic.
      const raised = action.topic_id
        ? topics.find((t) => t.id === action.topic_id)
        : action.topic
          ? topics.find((t) => t.label.toLowerCase().includes(action.topic!.toLowerCase()))
          : undefined;

      if (already && wouldWalkAway(s.conversation)) {
        return { ok: false, reason: `${target.name} has had enough of this for now.` };
      }

      const convoEffects: Effect[] = [{ t: "set_flag", key: `talked_to_${target.id}`, value: true }];
      if (!already) convoEffects.push({ t: "begin_conversation", entity_id: target.id, agenda: agendaOf(s, target) });

      const rolls: Roll[] = [];
      let press: PressResult | null = null;
      let friction = raised?.asked ? 1 : 0;

      // A BACKGROUND INSIGHT is neither a question nor a check. It is a line you have
      // standing to say because of where you came from, and what it buys is common
      // ground — trust, which then moves every DC in the conversation through the normal
      // path. No special-case bonus; the machinery is the same as everyone else's.
      //
      // Some of them cost you. Pulling rank on a farmhand works, and he will not forget
      // that you did it.
      if (raised?.insight_id) {
        const ins = insightsFor(s, target).find((i) => i.id === raised.insight_id);
        if (!ins) return { ok: false, reason: "You have already played that card with them." };

        const dims: Record<string, number> = { trust: ins.grants_trust };
        if (ins.costs_affinity !== 0) dims["affinity"] = ins.costs_affinity;

        return finish(
          {
            type: "dialogue",
            target_ids: [target.id],
            payload: { insight: ins.id, intent: ins.intent, topic_id: raised.id },
            rolls: [],
            direct_effects: [
              ...convoEffects,
              { t: "adjust_attitude", subject: target.id, object: actor.id, dims, reason: `you spoke as ${backgroundLabel(s)}` },
              // Spent. The moment of recognition is the point, and one you can repeat is
              // a button rather than a beat.
              { t: "tag_relationship", subject: target.id, object: actor.id, tag: `insight:${ins.id}` },
              { t: "raise_topic", topic_id: raised.id, friction: 0 },
            ],
            duration_minutes: s.combat ? 0 : DURATION.talk,
            witnesses: witnessIds(s, loc.id, actor.id),
          },
          `${ins.label} — ${target.name} takes you differently now.`,
        );
      }

      // A guarded or sealed topic is ASKED FOR with a roll. Nothing is refused for want of
      // trust: you can always try, and the dice decide what trying got you. That is the
      // whole difference between a relationship and a locked door.
      if (raised && raised.access.kind !== "open") {
        const dc = raised.access.kind === "guarded" ? raised.access.dc : SEALED_DC;
        const skill = raised.access.kind === "guarded" ? raised.access.skill : "persuasion";
        const roll = check(s, rng, actor.id, skill, dc, `press:${raised.id}`, target.id, lean);
        rolls.push(roll);
        press = pressOutcome(raised, roll.degree ?? "failure");
      } else if (raised) {
        press = pressOutcome(raised, "success");
      }

      if (press?.kind === "told") {
        // What they know, they now share — the knowledge model moving in the other direction.
        for (const fid of press.fact_ids) convoEffects.push({ t: "teach_fact", entity_id: s.meta.pc_id, fact_id: fid });
      } else if (press?.kind === "slip") {
        // The die did not open the door. It showed you where the key is, which is the more
        // interesting outcome and the one a good DM improvises anyway.
        convoEffects.push({
          t: "add_fact",
          text: `${target.name} let something slip: ${press.lead}`,
          subjects: [target.id],
          importance: 4,
          secret: false,
          known_by: [s.meta.pc_id],
        });
        friction += press.friction;
      } else if (press) {
        friction += press.friction;
      }

      if (raised) convoEffects.push({ t: "raise_topic", topic_id: raised.id, friction });

      return finish(
        {
          type: "dialogue",
          target_ids: [target.id],
          payload: {
            topic: action.topic ?? "general",
            first_talk: !target.flags["talked_to"],
            topic_id: raised?.id ?? null,
            revealed: press?.kind === "told" ? press.fact_ids : [],
            outcome: press?.kind ?? "chat",
            open_topics: topics.filter((t) => t.access.kind !== "sealed" && !t.asked).length,
          },
          rolls,
          direct_effects: convoEffects,
          // A few words are free in a fight, as they are at a table.
          duration_minutes: s.combat ? 0 : DURATION.talk,
          witnesses: witnessIds(s, loc.id, actor.id),
        },
        `Speak with ${target.name}${action.topic ? ` about ${action.topic}` : ""}.`,
      );
    }

    // -------------------------------------------------------- use_feature
    case "use_feature": {
      const feat = featureById(actor, action.feature_id);
      if (!feat) return { ok: false, reason: "You have no such feature." };
      if (!canUse(actor, feat)) {
        const when = feat.recharge === "short_rest" ? "a short rest" : feat.recharge === "long_rest" ? "a long rest" : "later";
        return { ok: false, reason: `${feat.name} is spent. You will have it back after ${when}.` };
      }

      const spend: Effect[] = feat.uses === "unlimited"
        ? []
        : [{ t: "set_entity_flag", entity_id: actor.id, key: `feat_used_${feat.id}`, value: (typeof actor.flags[`feat_used_${feat.id}`] === "number" ? actor.flags[`feat_used_${feat.id}`] as number : 0) + 1 }];

      const inCombat = !!s.combat;
      const me = inCombat ? combatantOf(s.combat!, actor.id) : undefined;

      switch (feat.effect.t) {
        case "heal_self": {
          // Second Wind. A bonus action, so it never competes with swinging.
          if (me && !me.economy.bonus) return { ok: false, reason: "You have already used your bonus action." };
          const roll = rollDamage(rng, feat.effect.dice, feat.effect.plus_level ? actor.level : 0, false);
          return finish(
            {
              type: "rest", target_ids: [],
              payload: { feature: feat.id, healed: roll.total },
              rolls: [roll],
              direct_effects: [
                ...spend,
                { t: "heal", entity_id: actor.id, amount: roll.total },
                ...(me ? [{ t: "spend" as const, entity_id: actor.id, bonus: true }] : []),
              ],
              duration_minutes: inCombat ? 0 : 1,
              witnesses: witnessIds(s, loc.id, actor.id),
            },
            `${feat.name}: ${fmt(roll)} — ${actor.name} heals ${roll.total}.`,
          );
        }

        case "extra_action": {
          // Action Surge. Not a free turn: one more ACTION, this turn only.
          if (!me) return { ok: false, reason: `${feat.name} only means something in a fight.` };
          if (me.economy.action) return { ok: false, reason: "You still have your action. Use it first." };
          return finish(
            {
              type: "effect", target_ids: [],
              payload: { feature: feat.id, action_surge: true },
              rolls: [],
              direct_effects: [...spend, { t: "grant_action", entity_id: actor.id }],
              duration_minutes: 0,
              witnesses: [],
            },
            `${feat.name}: ${actor.name} has another action this turn.`,
          );
        }

        case "rage": {
          // A stance. It ends when the fight does, which is close enough to RAW's ten
          // rounds that the difference has never mattered at a table.
          if (me && !me.economy.bonus) return { ok: false, reason: "You have already used your bonus action." };
          if (actor.flags["raging"] === true) return { ok: false, reason: "You are already raging." };
          return finish(
            {
              type: "effect", target_ids: [],
              payload: { feature: feat.id, raging: true },
              rolls: [],
              direct_effects: [
                ...spend,
                { t: "set_entity_flag", entity_id: actor.id, key: "raging", value: true },
                ...(me ? [{ t: "spend" as const, entity_id: actor.id, bonus: true }] : []),
              ],
              duration_minutes: 0,
              witnesses: witnessIds(s, loc.id, actor.id),
            },
            `${feat.name}: +${feat.effect.damage_bonus} melee damage, and half from blades, arrows and clubs.`,
          );
        }

        case "heal_pool": {
          // Lay on Hands. A pool measured in hit points, spent a point at a time.
          const pool = feat.effect.per_level * actor.level;
          const usedRaw = actor.flags["lay_on_hands_used"];
          const used = typeof usedRaw === "number" ? usedRaw : 0;
          const want = Math.max(1, action.amount ?? 5);
          if (used + want > pool) return { ok: false, reason: `Only ${pool - used} left in the pool.` };

          const who = action.target_id ? s.entities[action.target_id] : actor;
          if (!who) return { ok: false, reason: "There is nobody by that name here." };
          if (who.location_id !== loc.id) return { ok: false, reason: `${who.name} is not here.` };

          return finish(
            {
              type: "rest", target_ids: [who.id],
              payload: { feature: feat.id, healed: want },
              rolls: [],
              direct_effects: [
                { t: "set_entity_flag", entity_id: actor.id, key: "lay_on_hands_used", value: used + want },
                { t: "heal", entity_id: who.id, amount: want },
                ...(me ? [{ t: "spend" as const, entity_id: actor.id, action: true }] : []),
              ],
              duration_minutes: inCombat ? 0 : 1,
              witnesses: witnessIds(s, loc.id, actor.id),
            },
            `${feat.name}: ${who.name} recovers ${want}. ${pool - used - want} left in the pool.`,
          );
        }

        case "inspiration_die": {
          // Bardic Inspiration. The ally holds the die and chooses when to spend it, which
          // is why it lands as Inspiration rather than as a one-off bonus.
          const who = action.target_id ? s.entities[action.target_id] : undefined;
          if (!who) return { ok: false, reason: "Inspire whom?" };
          if (who.location_id !== loc.id) return { ok: false, reason: `${who.name} is not here.` };
          if (me && !me.economy.bonus) return { ok: false, reason: "You have already used your bonus action." };
          return finish(
            {
              type: "effect", target_ids: [who.id],
              payload: { feature: feat.id, inspired: who.id },
              rolls: [],
              direct_effects: [
                ...spend,
                { t: "grant_inspiration", entity_id: who.id, reason: "heroism" },
                ...(me ? [{ t: "spend" as const, entity_id: actor.id, bonus: true }] : []),
              ],
              duration_minutes: 0,
              witnesses: witnessIds(s, loc.id, actor.id),
            },
            `${feat.name}: ${who.name} has a ${feat.effect.die} to spend when they choose.`,
          );
        }

        default:
          // Sneak Attack, Extra Attack, Jack of All Trades and the narrative ones are not
          // things you DO — they apply where they apply. Offering them as a verb would
          // teach the player the wrong shape.
          return { ok: false, reason: `${feat.name} is not something you activate; it applies on its own.` };
      }
    }

    // --------------------------------------------------------- level up
    case "level_up": {
      if (actor.flags["level_up_ready"] !== true && levelForXp(actor.xp) <= actor.level) {
        return { ok: false, reason: "You have not earned a level yet." };
      }
      const cls = actor.class_id ? CLASSES[actor.class_id] : undefined;
      const die = cls?.hit_die ?? 8;
      // ROLLED hit points, not the average. Committed dice make this exploit-proof for
      // free: rewinding and levelling again gives you the same die.
      const roll = rollDamage(rng, `1d${die}`, 0, false);
      const plan = levelUpPlan(actor, roll.total);
      return finish(
        {
          type: "level_up", target_ids: [],
          payload: { to: actor.level + 1, hp_gain: plan.hp_gain, rolled: roll.total, features: plan.features },
          rolls: [roll],
          direct_effects: [{ t: "level_up", entity_id: actor.id, hp_gain: plan.hp_gain }],
          duration_minutes: 0,
          witnesses: [],
        },
        `Level ${actor.level + 1}: hit die ${fmt(roll)} + con = ${plan.hp_gain} hp.${plan.features.length ? ` Gained ${plan.features.join(", ")}.` : ""}`,
      );
    }

    // ------------------------------------------------------------- recruit
    case "recruit": {
      const who = s.entities[action.target_id];
      if (!who) return { ok: false, reason: `There is no ${action.target_id} here.` };
      if (who.location_id !== loc.id) return { ok: false, reason: `${who.name} is not here.` };
      if (!who.alive) return { ok: false, reason: `${who.name} is beyond asking.` };
      if (s.meta.party_ids.includes(who.id)) return { ok: false, reason: `${who.name} is already with you.` };
      if (!who.recruitable) return { ok: false, reason: `${who.name} has no interest in going anywhere with you.` };
      if (s.meta.party_ids.length >= MAX_PARTY) {
        return { ok: false, reason: `You are already travelling with ${s.meta.party_ids.length}. Someone would have to stay behind.` };
      }

      // The condition is authored as a flag, so the AUTHOR decides what earning someone
      // looks like — a favour done, a secret shared, a debt settled. Code never guesses at
      // what would persuade a person to follow you into a hole in the ground.
      if (who.recruit_condition && s.world.flags[who.recruit_condition] !== true) {
        return { ok: false, reason: `${who.name} is not ready to throw in with you.` };
      }

      // And they have to actually like you. This is the one place trust is a gate rather
      // than a DC, and it earns the exception: no roll talks someone into risking their
      // life beside you. That is a relationship, and you either built it or you did not.
      const rel = relationship(s, who.id, actor.id);
      if ((rel?.dims.trust ?? 0) < RECRUIT_TRUST) {
        return { ok: false, reason: `${who.name} does not know you well enough for that.` };
      }

      return finish(
        {
          type: "dialogue",
          target_ids: [who.id],
          payload: { recruited: who.id },
          rolls: [],
          direct_effects: [
            { t: "set_entity_flag", entity_id: who.id, key: "recruited", value: true },
            { t: "join_party", entity_id: who.id },
          ],
          duration_minutes: DURATION.talk,
          witnesses: witnessIds(s, loc.id, actor.id),
        },
        `${who.name} joins you.`,
      );
    }

    // ---------------------------------------------------------------- take
    case "take": {
      const inst = s.items[action.item_instance_id];
      if (!inst) return { ok: false, reason: `No such item.` };
      if (!(inst.owner.t === "location" && inst.owner.id === loc.id)) {
        return { ok: false, reason: `That is not lying here to be taken.` };
      }
      const def = s.item_defs[inst.def_id];
      return finish(
        {
          type: "item_transfer",
          target_ids: [],
          payload: { item_instance_id: inst.id, def_id: inst.def_id, from: "location", to: actor.id },
          rolls: [],
          // MOVE the object that is lying there. Minting a fresh one from its definition
          // would leave the original on the floor and quietly duplicate it.
          direct_effects: [
            { t: "move_item", instance_id: inst.id, to: { t: "entity", id: actor.id } },
          ],
          // 5e gives you one free object interaction on your turn; picking something up
          // off the floor is it.
          duration_minutes: s.combat ? 0 : DURATION.take,
          witnesses: witnessIds(s, loc.id, actor.id),
        },
        `Take ${def?.name ?? inst.def_id}.`,
      );
    }

    // ---------------------------------------------------------------- give
    case "give": {
      const inst = s.items[action.item_instance_id];
      const target = s.entities[action.target_id];
      if (!inst || inst.owner.t !== "entity" || inst.owner.id !== actor.id) {
        return { ok: false, reason: `You are not carrying that.` };
      }
      if (!target || target.location_id !== loc.id) {
        return { ok: false, reason: `They are not here.` };
      }
      const def = s.item_defs[inst.def_id];
      return finish(
        {
          type: "item_transfer",
          target_ids: [target.id],
          payload: { item_instance_id: inst.id, def_id: inst.def_id, from: actor.id, to: target.id },
          rolls: [],
          direct_effects: [
            { t: "move_item", instance_id: inst.id, to: { t: "entity", id: target.id } },
          ],
          duration_minutes: DURATION.take,
          witnesses: witnessIds(s, loc.id, actor.id),
        },
        `Give ${def?.name ?? inst.def_id} to ${target.name}.`,
      );
    }

    // ---------------------------------------------------------------- look
    case "look": {
      return finish(
        {
          type: "observe",
          target_ids: [],
          payload: { look: true },
          rolls: [],
          direct_effects: [],
          duration_minutes: DURATION.look,
          witnesses: [],
        },
        `Look around ${loc.name}.`,
      );
    }

    // --------------------------------------------------------- combat verbs
    case "end_turn": case "dash": case "disengage": case "dodge": case "move_zone": case "flee": case "cast": case "shove": {
      const r = resolveCombat(s, actor, action, rng, lean);
      if (!r.ok) return r;
      return finish(
        { type: r.type, target_ids: r.target_ids, payload: r.payload as GameEvent["payload"], rolls: r.rolls,
          direct_effects: r.effects, duration_minutes: 0, witnesses: witnessIds(s, loc.id, actor.id) },
        r.mechanics,
      );
    }

    // --------------------------------------------------------- fast travel
    case "travel": {
      const gate = canFastTravel(s);
      if (!gate.ok) return { ok: false, reason: gate.reason };
      const dest = s.locations[action.location_id];
      if (!dest) return { ok: false, reason: "You do not know that place." };
      if (!dest.discovered) return { ok: false, reason: `You have not found ${dest.name} yet. You will have to look for it.` };
      const path = findPath(s, actor.location_id, action.location_id);
      if (!path) return { ok: false, reason: `There is no way through to ${dest.name} that you know of.` };

      // The road is not free: any scramble along the way is still rolled, and failing one
      // stops you where it happened rather than quietly waving you through.
      let failedAt: { check: Path["checks"][number]; roll: Roll } | null = null;
      for (const c of path.checks) {
        const roll = check(s, rng, actor.id, c.skill as never, dcForBand(c.band as never, levers.dc_shift), `travel_${c.skill}`, undefined, lean);
        base.rolls.push(roll);
        if (roll.degree === "failure") { failedAt = { check: c, roll }; break; }
      }

      const stopAt = failedAt ? path.nodes.indexOf(failedAt.check.from) : path.nodes.length - 1;
      const walked: Path = {
        ...path,
        nodes: path.nodes.slice(0, Math.max(1, stopAt + 1)),
        minutes: failedAt ? Math.max(1, Math.round(path.minutes / 2)) : path.minutes,
      };
      const effects: Effect[] = [
        ...travelEffects(s, walked),
        ...meetingEffects(s, walked.nodes[walked.nodes.length - 1]!),
      ];
      const rolled = rollEncounters(s, rng, {
        tableId: dest.encounter_table_id, minutes: walked.minutes, danger: walked.danger,
        atLocationId: walked.nodes[Math.max(0, walked.nodes.length - 2)] ?? actor.location_id,
      });
      for (const enc of rolled) effects.push(...enc.effects);
      const tick = worldTick(s, walked.minutes, rng);
      effects.push(...tick.effects);

      const via = walked.nodes.slice(1, -1).map((n) => s.locations[n]?.name).filter(Boolean);
      const arrived = s.locations[walked.nodes[walked.nodes.length - 1]!]?.name ?? dest.name;
      const mech = [
        failedAt
          ? `Set out for ${dest.name}, but the ${failedAt.check.skill} of it beat you: ${fmt(failedAt.roll)}. You get as far as ${arrived}.`
          : `Travel to ${dest.name}: ${walked.minutes} min${via.length ? `, by way of ${via.join(", ")}` : ""}.`,
        ...rolled.map((e) => `On the way: ${e.entry.brief}`),
      ].join(" ");

      return finish(
        {
          type: "move",
          payload: {
            travel: true, to: walked.nodes[walked.nodes.length - 1]!, route: walked.nodes,
            minutes: walked.minutes, blocked: failedAt !== null,
            encounters: rolled.map((e) => e.entry.brief),
            beats: tick.beats.filter((b) => b.noticeable).map((b) => b.text),
          },
          rolls: base.rolls,
          direct_effects: effects,
          duration_minutes: walked.minutes,
        },
        mech,
      );
    }

    // --------------------------------------------------------------- trade
    case "buy": {
      const merchant = s.entities[action.merchant_id];
      const def = s.item_defs[action.item_def_id];
      if (!merchant || merchant.location_id !== loc.id) return { ok: false, reason: "They are not here." };
      if (!def) return { ok: false, reason: "They do not sell that." };
      const qty = action.qty ?? 1;
      const price = buyPrice(s, merchant.id, def, qty);
      const purse = purseOf(s, actor.id);
      if (purse < price) {
        return { ok: false, reason: `${def.name} costs ${formatCoin(price)} and you have ${formatCoin(purse)}.` };
      }
      // Stock is real: buying the last one means there is not one.
      const stock = stockOf(s, `cont_${merchant.id}`).filter((i) => i.def_id === def.id);
      if (stock.length === 0) return { ok: false, reason: `${merchant.name} has no ${def.name} left.` };

      return finish(
        {
          type: "trade",
          target_ids: [merchant.id],
          payload: { buy: def.id, qty, price },
          direct_effects: [
            { t: "set_entity_flag", entity_id: actor.id, key: "cp", value: purse - price },
            { t: "set_entity_flag", entity_id: merchant.id, key: "cp", value: purseOf(s, merchant.id) + price },
            { t: "move_item", instance_id: stock[0]!.id, to: { t: "entity", id: actor.id } },
          ],
          duration_minutes: 5,
          witnesses: witnessIds(s, loc.id, actor.id),
        },
        `Buy ${def.name} from ${merchant.name} for ${formatCoin(price)}.`,
      );
    }

    case "sell": {
      const merchant = s.entities[action.merchant_id];
      const inst = s.items[action.item_instance_id];
      if (!merchant || merchant.location_id !== loc.id) return { ok: false, reason: "They are not here." };
      if (!inst || inst.owner.t !== "entity" || inst.owner.id !== actor.id) return { ok: false, reason: "You are not carrying that." };
      const def = s.item_defs[inst.def_id];
      if (!def) return { ok: false, reason: "That is not worth anything." };
      const dealsIn = (merchant.flags["deals_in"] as string[] | undefined) ?? [];
      const price = sellPrice(s, merchant.id, def, dealsIn);

      return finish(
        {
          type: "trade",
          target_ids: [merchant.id],
          payload: { sell: def.id, price },
          direct_effects: [
            { t: "set_entity_flag", entity_id: actor.id, key: "cp", value: purseOf(s, actor.id) + price },
            { t: "move_item", instance_id: inst.id, to: { t: "container", id: `cont_${merchant.id}` } },
          ],
          duration_minutes: 5,
          witnesses: witnessIds(s, loc.id, actor.id),
        },
        `Sell ${def.name} to ${merchant.name} for ${formatCoin(price)}.`,
      );
    }

    // ------------------------------------------------------- wait and rest
    case "wait":
    case "rest": {
      const minutes = action.type === "wait"
        ? action.minutes
        : action.kind === "long" ? DURATION.long_rest : DURATION.short_rest;

      const effects: Effect[] = [];
      let mech: string;

      if (action.type === "rest" && action.kind === "long") {
        effects.push({ t: "heal", entity_id: actor.id, amount: actor.hp.max });
        mech = `Long rest (${minutes} min). HP restored to ${actor.hp.max}.`;
      } else if (action.type === "rest") {
        const hd = actor.resources.hit_dice;
        if (hd.used >= hd.max) {
          mech = `Short rest (${minutes} min). No hit dice remain.`;
        } else {
          const healed = Math.max(1, rng.int(1, 8) + abilityModOf(actor, "con"));
          effects.push({ t: "heal", entity_id: actor.id, amount: healed });
          mech = `Short rest (${minutes} min). Spend a hit die: heal ${healed}.`;
        }
      } else {
        mech = `Wait ${minutes} minutes.`;
      }

      // Class features recharge. Second Wind and Action Surge on a short rest; Rage and
      // Lay on Hands on a long one. See rules/features.ts.
      if (action.type === "rest") {
        effects.push({ t: "recharge_features", entity_id: actor.id, kind: action.kind });
        for (const id of s.meta.party_ids) {
          if (id !== actor.id) effects.push({ t: "recharge_features", entity_id: id, kind: action.kind });
        }
      }

      // The world moves while the player rests. All of it is random, so it is decided HERE
      // and baked onto the event as concrete effects; the reducer stays pure.
      const tick = worldTick(s, minutes, rng);
      effects.push(...tick.effects);

      return finish(
        {
          type: action.type === "rest" ? "rest" : "time_pass",
          target_ids: [],
          payload: {
            minutes,
            kind: action.type === "rest" ? action.kind : "wait",
            beats: tick.beats.filter((b) => b.noticeable).map((b) => b.text),
          },
          rolls: [],
          direct_effects: effects,
          duration_minutes: minutes,
          witnesses: [],
        },
        mech,
      );
    }
  }
}

/**
 * What makes two attempts "the same situation" for committed dice. Skill, band, target and
 * direction all count; the free-text tag does not, so relabelling an identical attempt
 * cannot fish for a new die.
 */
function actionKey(a: Action): string {
  switch (a.type) {
    case "move": return `move:${a.dir.toLowerCase()}`;
    case "skill_check": return `check:${a.skill}:${a.band}:${a.target_id ?? "-"}`;
    case "montage": return `montage:${a.kind}:${a.topic}`;
    case "attack": return `attack:${a.target_id}`;
    case "talk": return `talk:${a.target_id}:${a.topic_id ?? "-"}`;
    case "take": return `take:${a.item_instance_id}`;
    case "give": return `give:${a.item_instance_id}:${a.target_id}`;
    case "look": return "look";
    case "wait": return `wait:${a.minutes}`;
    case "rest": return `rest:${a.kind}`;
    case "death_save": return "death_save";
    case "equip": return `equip:${a.item_instance_id}:${a.slot ?? "none"}`;
    case "travel": return `travel:${a.location_id}`;
    case "buy": return `buy:${a.merchant_id}:${a.item_def_id}`;
    case "sell": return `sell:${a.merchant_id}:${a.item_instance_id}`;
    case "recruit": return `recruit:${a.target_id}`;
    case "use_feature": return `feature:${a.feature_id}:${a.target_id ?? "-"}`;
    case "level_up": return "level_up";
    case "end_turn": return "end_turn";
    case "dash": return "dash";
    case "disengage": return "disengage";
    case "dodge": return "dodge";
    case "move_zone": return `zone:${a.zone_id}`;
    case "flee": return "flee";
    case "cast": return `cast:${a.spell_id}:${a.target_id ?? a.zone_id ?? "-"}`;
    case "shove": return `shove:${a.target_id}:${a.mode}`;
  }
}

/** A skill check with every situational modifier from state applied and explained. */
function check(
  s: GameState,
  rng: Rng,
  actorId: string,
  skill: Skill,
  dc: number,
  purpose: string,
  targetId?: string,
  lean = 0,
  extra: readonly Modifier[] = [],
): Roll {
  const actor = mustEntity(s, actorId);
  const loc = mustLocation(s, actor.location_id);
  const rel = targetId ? relationship(s, targetId, actorId) : undefined;
  const mods = [...collectSkillModifiers({ actor, skill, location: loc, relationship: rel }), ...extra];

  // Doing it in front of people is not the same as doing it in private. Nobody folds to a
  // threat where their neighbours can see, and every extra ear is a chance someone knows
  // better than your lie.
  if (skill === "persuasion" || skill === "deception" || skill === "intimidation") {
    const crowd = audiencePressure(s, skill);
    if (crowd) mods.push({ source: "audience", reason: crowd.reason, dc_delta: crowd.dc_delta, advantage: "none" });
  }

  const { dc_delta, advantage } = combineModifiers(mods);
  return rollD20(rng, {
    purpose,
    mods: skillModifier(actor, skill),
    target: dc + dc_delta,
    advantage,
    isAttack: false,
    lean,
    // Situational modifiers move the DC rather than the roll, so they are shown against
    // the target with their reason — "the light is poor", not an anonymous +2.
    parts: [...skillParts(actor, skill), ...mods.map((m) => ({ label: m.reason.toLowerCase(), value: -m.dc_delta }))],
    costMargin: leversOf(s).cost_margin,
  });
}

/**
 * Meeting people for the first time in a new place.
 *
 * Reputation is only applied to strangers — see rules/reputation.ts. Someone you have
 * already dealt with has an opinion of their own, and nothing said about you elsewhere
 * outranks what the two of you actually did.
 */
function meetingEffects(s: GameState, locationId: string): Effect[] {
  return arrivalEffects(s, entitiesAt(s, locationId).filter((e) => e.id !== s.meta.pc_id));
}

function witnessIds(s: GameState, locationId: string, exclude: string): string[] {
  return Object.values(s.entities)
    .filter((e) => e.alive && e.location_id === locationId && e.id !== exclude)
    .filter((e) => e.flags["is_template"] !== true)
    .map((e) => e.id)
    .sort();
}

function fmt(r: Roll): string {
  const adv = r.advantage === "none" ? "" : ` [${r.advantage}: ${r.raw}/${r.raw_second}]`;
  const sign = r.mods >= 0 ? "+" : "";
  return `d20 ${r.raw}${sign}${r.mods} = ${r.total}${adv}`;
}
