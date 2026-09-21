import type { Dim, Dims } from "../schema/common.js";
import { nextSceneId, sceneBreakFor } from "./scenes.js";
import type { Effect } from "../schema/dsl.js";
import type { GameEvent } from "../schema/event.js";
import type { GameState } from "../schema/state.js";
import {
  ATTITUDE_CLAMP_PER_TURN,
  FACTION_REP_SPILL,
  NEUTRAL_DIMS,
  relKey,
} from "../schema/relationship.js";
import { scheduledLocation } from "../state/selectors.js";
import { refreshAC } from "../rules/equipment.js";
import { levelForXp } from "../rules/progression.js";
import { levelUpPlan } from "../rules/character.js";
import { featureOfKind, rechargeFeatures } from "../rules/features.js";
import { shiftPresence } from "../rules/factions.js";
import { inspirationCap, inspirationOf } from "../rules/inspiration.js";
import { Clock, vowComplete } from "../schema/clock.js";
import { Entity } from "../schema/entity.js";
import { Relationship } from "../schema/relationship.js";
import { Thread, THREAD_FADE_MINUTES } from "../schema/thread.js";
import { Location } from "../schema/location.js";

/**
 * Effects are the ONLY way state changes. Each one mutates the draft in place and may
 * return follow-up events (a death, a quest update) that re-enter the reducer.
 *
 * No effect rolls dice. Anything random was decided during resolution and arrived here
 * as a concrete number, which is what makes replay exact.
 */

const DIMS: Dim[] = ["affinity", "trust", "fear", "respect"];

export interface EffectCtx {
  root: GameEvent;
  trigger_id: string | null;
  /** Per-turn attitude budget, keyed "subject->object|dim". Enforces the ±10 clamp. */
  attitudeSpent: Map<string, number>;
  /**
   * Whether attitude changes from this source are subject to the ±10 per-turn clamp.
   *
   * The clamp exists to stop the LLM narrator swinging a relationship across its whole
   * range in one turn. Authored content — quest rewards, hand-written triggers — is
   * trusted and exempt: an author who writes +20 means +20, and silently delivering +10
   * would be a content bug nobody could see. Phase 1 sets this to `true` for anything
   * arriving from the narrator.
   */
  clampAttitude: boolean;
}

export function newEffectCtx(
  root: GameEvent,
  trigger_id: string | null = null,
  clampAttitude = false,
): EffectCtx {
  return { root, trigger_id, attitudeSpent: new Map(), clampAttitude };
}

/** Deterministic id allocation, counted in state so replay produces identical ids. */
export function nextId(s: GameState, prefix: string): string {
  const n = (s.meta.next_ids[prefix] ?? 0) + 1;
  s.meta.next_ids[prefix] = n;
  return `${prefix}_${String(n).padStart(4, "0")}`;
}

export function applyEffect(s: GameState, eff: Effect, ctx: EffectCtx): GameEvent[] {
  const emitted: GameEvent[] = [];

  switch (eff.t) {
    case "set_flag": {
      s.world.flags[eff.key] = eff.value;
      break;
    }

    case "give_item": {
      const def = s.item_defs[eff.item_def_id];
      if (!def) break;
      const e = s.entities[eff.entity_id];
      if (!e) break;
      if (def.stackable) {
        const existing = Object.values(s.items).find(
          (i) => i.def_id === def.id && i.owner.t === "entity" && i.owner.id === e.id,
        );
        if (existing) { existing.qty += eff.qty; break; }
      }
      const id = nextId(s, "item_inst");
      s.items[id] = {
        id, def_id: def.id, owner: { t: "entity", id: e.id }, qty: eff.qty,
        charges: null, attunement: null, nickname: null, condition: "fine", flags: {},
      };
      e.inventory.push(id);
      break;
    }

    case "remove_item": {
      const e = s.entities[eff.entity_id];
      if (!e) break;
      let remaining = eff.qty;
      for (const instId of [...e.inventory]) {
        if (remaining <= 0) break;
        const inst = s.items[instId];
        if (!inst || inst.def_id !== eff.item_def_id) continue;
        const take = Math.min(remaining, inst.qty);
        inst.qty -= take;
        remaining -= take;
        if (inst.qty <= 0) {
          e.inventory = e.inventory.filter((x) => x !== instId);
          for (const slot of ["main_hand", "off_hand", "armor", "trinket"] as const) {
            if (e.equipped[slot] === instId) e.equipped[slot] = null;
          }
          delete s.items[instId];
        }
      }
      break;
    }

    case "move_item": {
      const inst = s.items[eff.instance_id];
      if (!inst) break;

      // Detach from wherever it currently is. `owner` is the single source of truth, but
      // an entity's inventory list and a room's item list both mirror it, so both are
      // maintained here and nowhere else.
      if (inst.owner.t === "entity") {
        const from = s.entities[inst.owner.id];
        if (from) {
          from.inventory = from.inventory.filter((x) => x !== inst.id);
          for (const slot of ["main_hand", "off_hand", "armor", "trinket"] as const) {
            if (from.equipped[slot] === inst.id) from.equipped[slot] = null;
          }
        }
      } else if (inst.owner.t === "location") {
        const from = s.locations[inst.owner.id];
        if (from) from.contains_item_ids = from.contains_item_ids.filter((x) => x !== inst.id);
      }

      // Attach to the new owner.
      if (eff.to.t === "entity") {
        const to = s.entities[eff.to.id];
        if (!to) break;
        inst.owner = { t: "entity", id: to.id };
        if (!to.inventory.includes(inst.id)) to.inventory.push(inst.id);
      } else if (eff.to.t === "location") {
        const to = s.locations[eff.to.id];
        if (!to) break;
        inst.owner = { t: "location", id: to.id };
        if (!to.contains_item_ids.includes(inst.id)) to.contains_item_ids.push(inst.id);
      } else {
        inst.owner = { t: "container", id: eff.to.id };
      }
      break;
    }

    case "move_entity": {
      const e = s.entities[eff.entity_id];
      const loc = s.locations[eff.location_id];
      if (!e || !loc) break;
      if (e.location_id === eff.location_id) break;
      e.location_id = eff.location_id;
      // You arrive somewhere, not nowhere: the first authored zone is the doorway.
      e.zone_id = loc.zones[0]?.id ?? null;
      // Walking out ends a conversation, which is how it works everywhere else.
      if (e.id === s.meta.pc_id && s.conversation) s.conversation = null;
      if (e.id === s.meta.pc_id) {
        const cameFrom = ctx.root.location_id;
        loc.discovered = true;
        loc.visited_count += 1;
        emitted.push(derived(s, ctx, {
          type: "enter_location",
          actor_id: e.id,
          location_id: loc.id,
          payload: { first_visit: loc.visited_count === 1 },
        }));
        // Arriving somewhere meaningfully else ends the scene. Room to room does not —
        // see engine/scenes.ts for why that distinction is the whole feature.
        emitted.push(...breakScene(s, ctx, {
          kind: "arrived",
          ...(cameFrom ? { from_location: cameFrom } : {}),
          to_location: loc.id,
        }));
      }
      break;
    }

    case "spawn_entity": {
      const tpl = s.entities[eff.template_id];
      if (!tpl || s.entities[eff.instance_id]) break;
      s.entities[eff.instance_id] = {
        ...structuredClone(tpl),
        id: eff.instance_id,
        location_id: eff.location_id,
        alive: true,
        flags: { ...structuredClone(tpl.flags), is_template: false, spawned_from: tpl.id },
      };
      break;
    }

    case "damage": {
      const e = s.entities[eff.entity_id];
      if (!e || !e.alive) break;
      const wasDown = e.hp.current === 0;

      // RAGE halves the three weapon damage types. Applied here rather than at the attack
      // so it covers everything that hurts you, not only what rolled to hit you.
      const rageFeat = featureOfKind(e, "rage");
      const resisted = e.flags["raging"] === true
        && !!rageFeat
        && rageFeat.effect.resists.includes(eff.damage_type);

      let amount = resisted ? Math.floor(eff.amount / 2) : eff.amount;
      const absorbed = Math.min(e.hp.temp, amount);
      e.hp.temp -= absorbed;
      amount -= absorbed;
      const hpBefore = e.hp.current;
      e.hp.current = Math.max(0, e.hp.current - amount);
      // 5e massive damage: if what remains after reaching 0 equals your max HP, you die.
      const overflow = Math.max(0, amount - hpBefore);

      const isCharacter = e.kind === "pc" || e.kind === "companion";

      if (isCharacter && wasDown && amount > 0) {
        // Damage while dying is an automatic failed save; a crit is two. Recorded as
        // effects so the journal shows exactly how someone died.
        const crit = ctx.root.rolls.some((r) => r.critical);
        emitted.push(...applyEffect(s, { t: "death_save", entity_id: e.id, outcome: crit ? "crit_failure" : "failure" }, ctx));
        break;
      }

      if (e.hp.current === 0) {
        if (isCharacter && overflow < e.hp.max) {
          // 5e: a character at 0 HP is unconscious and dying, not dead. Massive damage
          // (overflow past zero of at least a full max-HP) kills outright.
          e.stable = false;
          e.death_saves = { successes: 0, failures: 0 };
          if (!e.conditions.some((c) => c.id === "unconscious")) {
            e.conditions.push({ id: "unconscious", source_event_id: ctx.root.id, expires_world_minute: null, expires_round: null });
          }
          emitted.push(derived(s, ctx, {
            type: "downed", actor_id: ctx.root.actor_id, target_ids: [e.id], location_id: e.location_id,
            payload: { entity_id: e.id }, witnesses: witnessesAt(s, e.location_id, e.id),
          }));
        } else {
          kill(s, ctx, e, eff.damage_type, emitted);
        }
      }
      break;
    }

    case "death_save": {
      const e = s.entities[eff.entity_id];
      if (!e || !e.alive || e.hp.current > 0 || e.stable) break;
      if (eff.outcome === "crit_success") {
        // Natural 20: back on your feet with 1 HP.
        e.hp.current = 1;
        e.stable = false;
        e.death_saves = { successes: 0, failures: 0 };
        e.conditions = e.conditions.filter((c) => c.id !== "unconscious");
        break;
      }
      if (eff.outcome === "success") e.death_saves.successes = Math.min(3, e.death_saves.successes + 1);
      else e.death_saves.failures = Math.min(3, e.death_saves.failures + (eff.outcome === "crit_failure" ? 2 : 1));

      if (e.death_saves.successes >= 3) {
        e.stable = true;
        e.death_saves = { successes: 0, failures: 0 };
      } else if (e.death_saves.failures >= 3) {
        kill(s, ctx, e, "death_saves", emitted);
      }
      break;
    }

    case "stabilise": {
      const e = s.entities[eff.entity_id];
      if (!e || !e.alive) break;
      e.stable = true;
      e.death_saves = { successes: 0, failures: 0 };
      break;
    }

    case "grant_xp": {
      for (const id of eff.entity_ids) {
        const e = s.entities[id];
        if (!e || (e.kind !== "pc" && e.kind !== "companion")) continue;
        e.xp += eff.amount;
        // Levelling is a player-confirmed flow, so this only flags readiness. The client
        // (or the CLI) then issues a level_up effect with the chosen HP.
        if (levelForXp(e.xp) > e.level) e.flags["level_up_ready"] = true;
      }
      break;
    }

    case "level_up": {
      const e = s.entities[eff.entity_id];
      if (!e) break;
      if (levelForXp(e.xp) <= e.level) break;   // not earned; refused silently, journaled anyway
      const plan = levelUpPlan(e);
      e.level += 1;
      e.hp.max += eff.hp_gain;
      e.hp.current += eff.hp_gain;
      e.proficiency_bonus = plan.proficiency;
      e.resources.hit_dice.max = e.level;
      for (const [tier, max] of Object.entries(plan.slots)) {
        const cur = e.resources.spell_slots[tier];
        e.resources.spell_slots[tier] = { max, used: Math.min(cur?.used ?? 0, max) };
      }
      const feats = (e.flags["features"] as string[] | undefined) ?? [];
      e.flags["features"] = [...feats, ...plan.features];
      if (levelForXp(e.xp) <= e.level) delete e.flags["level_up_ready"];
      emitted.push(derived(s, ctx, {
        type: "level_up", actor_id: e.id, target_ids: [e.id], location_id: e.location_id,
        payload: { entity_id: e.id, level: e.level, features: plan.features },
      }));
      break;
    }

    case "equip": {
      const e = s.entities[eff.entity_id];
      const inst = s.items[eff.instance_id];
      if (!e || !inst || inst.owner.t !== "entity" || inst.owner.id !== e.id) break;
      for (const slot of ["main_hand", "off_hand", "armor", "trinket"] as const) {
        if (e.equipped[slot] === inst.id) e.equipped[slot] = null;   // unequip from wherever it was
      }
      if (eff.slot) e.equipped[eff.slot] = inst.id;
      refreshAC(s, e);
      break;
    }

    case "heal": {
      const e = s.entities[eff.entity_id];
      if (!e || !e.alive) break;
      e.hp.current = Math.min(e.hp.max, e.hp.current + eff.amount);
      if (e.hp.current > 0) {
        // Any healing ends the dying state and wakes them.
        e.stable = false;
        e.death_saves = { successes: 0, failures: 0 };
        e.conditions = e.conditions.filter((c) => c.id !== "unconscious");
      }
      break;
    }

    case "adjust_attitude": {
      adjustAttitude(s, ctx, eff.subject, eff.object, eff.dims, eff.reason);
      break;
    }

    case "faction_rep": {
      const f = s.world.factions[eff.faction_id];
      if (!f) break;
      f.rep_with_pc = clamp(f.rep_with_pc + eff.delta, -100, 100);
      // Spill: members who could plausibly have heard shift by a damped amount.
      const spill = Math.trunc(eff.delta * FACTION_REP_SPILL);
      if (spill !== 0) {
        for (const memberId of [...f.member_ids].sort()) {
          if (!s.entities[memberId]) continue;
          adjustAttitude(s, ctx, memberId, s.meta.pc_id, { affinity: spill },
            `Word spread within ${f.name}`);
        }
      }
      break;
    }

    case "set_quest_status": {
      const q = s.quests[eff.quest_id];
      if (!q || q.status === eff.status) break;
      q.status = eff.status;
      if (eff.status === "active" && q.visibility === "hidden") q.visibility = "known";
      if (eff.status === "complete") {
        for (const d of q.rewards.relationship_deltas) {
          adjustAttitude(s, ctx, d.subject, d.object, d.dims, `Completed: ${q.title}`);
        }
        for (const defId of q.rewards.item_def_ids) {
          emitted.push(...applyEffect(s, { t: "give_item", entity_id: s.meta.pc_id, item_def_id: defId, qty: 1 }, ctx));
        }
      }
      emitted.push(derived(s, ctx, {
        type: "quest_update",
        payload: { quest_id: q.id, status: eff.status },
      }));
      break;
    }

    case "advance_quest": {
      const q = s.quests[eff.quest_id];
      if (!q) break;
      const prev = q.steps.find((st) => st.id === q.current_step_id);
      if (prev && prev.status === "active") prev.status = "complete";
      const next = q.steps.find((st) => st.id === eff.step_id);
      if (next) { next.status = "active"; q.current_step_id = next.id; }
      break;
    }

    case "add_lead": {
      const q = s.quests[eff.quest_id];
      if (!q) break;
      if (q.leads.some((l) => l.text === eff.text)) break;   // idempotent
      q.leads.push({
        text: eff.text,
        learned_turn: s.meta.turn,
        source_entity_id: eff.source_entity_id,
        points_to_location_id: eff.points_to_location_id,
      });
      if (q.visibility === "hidden") q.visibility = "rumored";
      break;
    }

    case "reveal_location": {
      const l = s.locations[eff.location_id];
      if (l) l.discovered = true;
      break;
    }

    case "reveal_exit": {
      const l = s.locations[eff.location_id];
      const x = l?.exits.find((ex) => ex.dir === eff.dir);
      if (x) x.revealed = true;
      break;
    }

    /**
     * A person the narrator named, made permanent.
     *
     * Minted with a commoner's stat block rather than nothing, because this engine has one
     * vocabulary for everything that exists and an Entity that cannot fight, be hurt, be
     * feared or be talked to is not a person — it is a prop that will fall over the moment
     * the story asks anything of it. The cap is checked in validate.ts, where it can be
     * refused and recorded; by the time an effect runs there is nothing to say no to.
     */
    case "introduce_local": {
      const id = nextId(s, "npc");
      const loc = s.locations[eff.location_id] ? eff.location_id : s.entities[s.meta.pc_id]!.location_id;
      s.entities[id] = Entity.parse({
        id,
        kind: "npc",
        tier: "local",
        name: eff.name,
        pronouns: eff.pronouns,
        descriptor: eff.descriptor,
        location_id: loc,
        // Ordinary. A local who turns out to matter gets promoted and re-statted; a local
        // who never does should never have been a threat in the first place.
        abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
        hp: { current: 4, max: 4, temp: 0 },
        ac: 10,
        level: 0,
        resources: { spell_slots: {}, hit_dice: { max: 0, used: 0 } },
        // Throwaway is not cardboard. A local the DM can HEAR is one it will voice the
        // same way next week, which is the only reason keeping them is worth anything.
        personality: {
          traits: eff.trait ? [eff.trait] : [],
          voice: eff.voice,
          ideal: "", bond: "", flaw: "",
        },
      });
      // A relationship row from the start: the whole point of keeping them is that the
      // next meeting remembers the last one.
      const key = `${id}->${s.meta.pc_id}`;
      s.relationships[key] = Relationship.parse({
        subject: id,
        object: s.meta.pc_id,
        dims: { affinity: 0, trust: 0, fear: 0, respect: 0 },
      });
      break;
    }

    case "introduce_place": {
      const here = s.locations[s.entities[s.meta.pc_id]!.location_id]!;
      // Never mint a second copy of a room the campaign already has under that name; the
      // narrator describing "the winch house" twice must arrive at the same winch house.
      const existing = Object.values(s.locations).find(
        (l) => l.name.toLowerCase().trim() === eff.name.toLowerCase().trim(),
      );
      if (existing) {
        existing.discovered = true;
        if (!here.exits.some((x) => x.to === existing.id)) {
          here.exits.push({ dir: eff.dir, to: existing.id, desc: "", travel_minutes: 1, locked_by: null, hidden_until_flag: null, requires_check: null, revealed: true });
        }
        break;
      }
      const id = nextId(s, "loc");
      s.locations[id] = Location.parse({
        id,
        name: eff.name,
        short_desc: eff.short_desc,
        // It hangs off where you are standing, so it inherits the map it belongs on.
        region_id: here.region_id,
        settlement_id: here.settlement_id,
        coords: { x: here.coords.x, y: here.coords.y },
        map_visibility: "discoverable",
        // You are being shown it, so you know it is there.
        discovered: true,
        ambient: { light: eff.light, sound: "", smell: "" },
        exits: [{ dir: eff.back, to: here.id, desc: "", travel_minutes: 1, locked_by: null, hidden_until_flag: null, requires_check: null, revealed: true }],
      });
      here.exits.push({ dir: eff.dir, to: id, desc: "", travel_minutes: 1, locked_by: null, hidden_until_flag: null, requires_check: null, revealed: true });
      break;
    }

    case "open_thread": {
      const id = nextId(s, "thr");
      s.threads[id] = Thread.parse({
        id,
        text: eff.text,
        subject_ids: [...eff.subject_ids],
        location_id: eff.location_id,
        from_entity_id: eff.from_entity_id,
        opened_turn: s.meta.turn,
        opened_world_minute: s.world.world_minute,
        // Everything picked up has a shelf life. An obligation that can never expire is
        // not an obligation, it is furniture.
        fades_at_world_minute: s.world.world_minute + THREAD_FADE_MINUTES,
        source: "narrator",
      });
      break;
    }

    case "resolve_thread": {
      const th = s.threads[eff.thread_id];
      if (!th || th.status !== "open") break;
      th.status = eff.as;
      th.outcome = eff.outcome;
      break;
    }

    case "add_fact": {
      const id = nextId(s, "fact");
      /**
       * `known_by` is taken LITERALLY, empty included.
       *
       * It used to fall back to "the player knows it" when the list was empty, which made
       * a fact nobody knows impossible to write — and that is exactly what a succession
       * seed is. A thread the next party already knows about is not a hook, it is a
       * briefing. Every caller passes this explicitly; nothing relied on the fallback.
       */
      const knownBy = [...eff.known_by];
      s.facts.push({
        id,
        turn: s.meta.turn,
        world_minute: s.world.world_minute,
        text: eff.text,
        kind: "world",
        subjects: [...eff.subjects],
        location_id: ctx.root.location_id,
        quest_ids: [],
        importance: eff.importance,
        secret: eff.secret,
        known_by: knownBy,
        source: "engine",
        superseded_by: null, seal: null,
      });
      for (const holder of knownBy) {
        const e = s.entities[holder];
        if (e && !e.known_fact_ids.includes(id)) e.known_fact_ids.push(id);
      }
      break;
    }

    case "teach_fact": {
      const e = s.entities[eff.entity_id];
      const f = s.facts.find((x) => x.id === eff.fact_id);
      if (!e || !f) break;
      if (!e.known_fact_ids.includes(f.id)) e.known_fact_ids.push(f.id);
      if (!f.known_by.includes(e.id)) f.known_by.push(e.id);
      break;
    }

    case "advance_time": {
      if (eff.minutes <= 0) break;
      s.world.world_minute += eff.minutes;

      /**
       * Threads nobody has touched in ten days quietly stop mattering.
       *
       * Sorted, for the same reason the clocks below are: two threads fading in one tick
       * must fade in the same order on replay as they did live, or the ids minted after
       * them renumber and the rebuild gate fails.
       */
      for (const id of Object.keys(s.threads).sort()) {
        const th = s.threads[id]!;
        if (th.status !== "open") continue;
        if (th.fades_at_world_minute !== null && s.world.world_minute >= th.fades_at_world_minute) {
          th.status = "faded";
          th.outcome = "nobody mentioned it again";
        }
      }
      // Clocks that run on their own advance with the calendar, whether or not anyone
      // is watching. That is the point of them.
      // SORTED, and not incidentally.
      //
      // Authored content lists clocks in the order somebody wrote them; a save writes them
      // key-sorted. Iterate in object order and two clocks completing in the same tick fire
      // their `on_complete` effects in a different sequence on replay than they did live —
      // which renumbers every fact minted after them and fails the rebuild gate. It only
      // shows up when one tick finishes two clocks, which is why a twelve-year succession
      // found it and four hundred ordinary turns did not.
      for (const id of Object.keys(s.clocks).sort()) {
        const c = s.clocks[id]!;
        if (c.done || c.per_day === 0) continue;
        const before = c.filled;
        // Carry the remainder at full precision. Rounding it (toFixed) loses enough that
        // three thirds of a day sum to 0.999999 and a one-a-day clock never moves; the
        // epsilon covers what binary floating point still costs.
        const gained = (eff.minutes / 1440) * c.per_day + c.drift;
        const whole = Math.floor(gained + 1e-6);
        c.drift = Math.max(0, Math.min(1, gained - whole));
        c.filled = Math.min(c.segments, c.filled + whole);
        if (c.filled > before && c.filled >= c.segments) {
          c.done = true;
          for (const e2 of c.on_complete) emitted.push(...applyEffect(s, e2, ctx));
        }
      }
      if (eff.minutes >= 480) {
        for (const e of Object.values(s.entities)) {
          for (const t of Object.values(e.resources.spell_slots)) t.used = 0;
          e.resources.hit_dice.used = Math.max(0, e.resources.hit_dice.used - Math.max(1, Math.floor(e.resources.hit_dice.max / 2)));
        }
      }
      expireConditions(s);
      relocateOnSchedule(s);
      // A night, or a day on the road. Long enough that what comes next is a new scene.
      emitted.push(...breakScene(s, ctx, { kind: eff.minutes >= 480 ? "rested" : "time_passed", minutes: eff.minutes }));
      break;
    }

    case "start_combat": {
      // Authored form. Initiative needs dice, so this only queues the fight; the next
      // resolution rolls it and emits begin_combat.
      if (s.combat) break;
      s.world.flags["pending_combat"] = [...eff.enemy_ids];
      break;
    }

    case "begin_combat": {
      if (s.combat) break;
      s.combat = structuredClone(eff.combat);
      delete s.world.flags["pending_combat"];
      emitted.push(derived(s, ctx, { type: "combat_start", location_id: s.combat.location_id,
        payload: { order: s.combat.order.map((c) => c.entity_id) } }));
      break;
    }

    case "end_combat": {
      if (!s.combat) break;
      const c = s.combat;
      s.combat = null;
      for (const e of Object.values(s.entities)) {
        e.conditions = e.conditions.filter((x) => x.expires_round === null);
        delete e.flags["guided"]; delete e.flags["blessed"];
      }
      for (const e of Object.values(s.entities)) delete e.flags["raging"];
      emitted.push(derived(s, ctx, { type: "combat_end", location_id: c.location_id, payload: { winner: eff.winner, rounds: c.round } }));
      // The aftermath of a fight is its own scene: catching your breath is not the fight.
      emitted.push(...breakScene(s, ctx, { kind: "fight_over" }));
      break;
    }

    case "next_turn": {
      const c = s.combat;
      if (!c) break;
      const live = (i: number) => {
        const x = c.order[i]!; const e = s.entities[x.entity_id];
        return !x.fled && !!e?.alive;
      };
      let i = c.current;
      for (let n = 0; n < c.order.length; n++) {
        i = (i + 1) % c.order.length;
        if (i === 0) {
          c.round += 1;
          for (const e of Object.values(s.entities)) {
            e.conditions = e.conditions.filter((x) => x.expires_round === null || x.expires_round > c.round);
          }
          for (const [id, con] of Object.entries(c.concentration)) {
            if (con.ends_round !== null && c.round >= con.ends_round) delete c.concentration[id];
          }
          emitted.push(derived(s, ctx, { type: "round", location_id: c.location_id, payload: { round: c.round } }));
        }
        if (live(i)) break;
      }
      c.current = i;
      const who = s.entities[c.order[i]!.entity_id]!;
      // Sneak Attack is once per TURN, not once per attack, so the gate resets here rather
      // than on a rest. Missing this is how a rogue quietly triples their damage.
      delete who.flags["sneak_used_this_turn"];
      c.order[i]!.economy = {
        action: who.hp.current > 0 && !who.conditions.some((x) => ["incapacitated","paralyzed","stunned","unconscious","petrified"].includes(x.id)),
        bonus: who.hp.current > 0,
        reaction: who.hp.current > 0,
        moves: who.conditions.some((x) => ["grappled","restrained","paralyzed","stunned","unconscious","petrified"].includes(x.id)) ? 0 : 1,
        dodging: false, disengaged: false,
      };
      break;
    }

    case "spend": {
      const cb = s.combat ? s.combat.order.find((x) => x.entity_id === eff.entity_id) : undefined;
      if (!cb) break;
      if (eff.action) cb.economy.action = false;
      if (eff.bonus) cb.economy.bonus = false;
      if (eff.reaction) cb.economy.reaction = false;
      if (eff.moves) cb.economy.moves = Math.max(0, cb.economy.moves - eff.moves);
      break;
    }

    case "grant_moves": {
      const cb = s.combat ? s.combat.order.find((x) => x.entity_id === eff.entity_id) : undefined;
      if (cb) cb.economy.moves += eff.moves;
      break;
    }

    case "mark": {
      const cb = s.combat ? s.combat.order.find((x) => x.entity_id === eff.entity_id) : undefined;
      if (!cb) break;
      if (eff.dodging !== undefined) cb.economy.dodging = eff.dodging;
      if (eff.disengaged !== undefined) cb.economy.disengaged = eff.disengaged;
      if (eff.fled !== undefined) cb.fled = eff.fled;
      break;
    }

    case "set_zone": {
      const e = s.entities[eff.entity_id];
      if (e) e.zone_id = eff.zone_id;
      break;
    }

    case "spend_slot": {
      const e = s.entities[eff.entity_id];
      const t = e?.resources.spell_slots[String(eff.level)];
      if (t && t.used < t.max) t.used += 1;
      break;
    }

    case "set_concentration": {
      const c = s.combat;
      if (!c) break;
      if (eff.spell_id === null) delete c.concentration[eff.entity_id];
      else c.concentration[eff.entity_id] = { spell_id: eff.spell_id, target_ids: [], ends_round: c.round + 10 };
      break;
    }

    case "set_entity_flag": {
      const e = s.entities[eff.entity_id];
      if (e) e.flags[eff.key] = eff.value;
      break;
    }

    case "grant_inspiration": {
      const e = s.entities[eff.entity_id];
      if (!e) break;
      const cap = inspirationCap(s);
      if (inspirationOf(e) >= cap) break;
      // One award per scene, so it stays a moment rather than a drip.
      if (e.flags["inspiration_scene"] === s.world.scene_id) break;
      e.flags["inspiration"] = inspirationOf(e) + 1;
      e.flags["inspiration_scene"] = s.world.scene_id;
      emitted.push(derived(s, ctx, {
        type: "inspiration", actor_id: e.id, target_ids: [e.id], location_id: e.location_id,
        payload: { granted: true, reason: eff.reason },
      }));
      break;
    }

    case "spend_inspiration": {
      const e = s.entities[eff.entity_id];
      if (!e || inspirationOf(e) <= 0) break;
      e.flags["inspiration"] = inspirationOf(e) - 1;
      break;
    }

    case "add_clock": {
      const parsed = Clock.safeParse(eff.clock);
      if (!parsed.success || s.clocks[parsed.data.id]) break;
      s.clocks[parsed.data.id] = parsed.data;
      break;
    }

    case "tick_clock": {
      const c = s.clocks[eff.clock_id];
      if (!c || c.done) break;
      c.filled = Math.max(0, Math.min(c.segments, c.filled + eff.segments));
      emitted.push(derived(s, ctx, {
        type: "clock", payload: { clock_id: c.id, filled: c.filled, segments: c.segments, name: c.name },
      }));
      if (c.filled >= c.segments) {
        c.done = true;
        // A clock that fills is a thing happening, so its effects run like any other.
        for (const e2 of c.on_complete) emitted.push(...applyEffect(s, e2, ctx));
      }
      break;
    }

    case "advance_vow": {
      const v = s.vows[eff.vow_id];
      if (!v || v.status !== "sworn") break;
      v.progress = Math.max(0, Math.min(100, v.progress + eff.ticks));
      emitted.push(derived(s, ctx, {
        type: "vow", payload: { vow_id: v.id, progress: v.progress, text: v.text },
      }));
      if (vowComplete(v)) {
        emitted.push(derived(s, ctx, { type: "vow", payload: { vow_id: v.id, ready_to_fulfil: true } }));
      }
      break;
    }

    case "begin_conversation": {
      const e = s.entities[eff.entity_id];
      if (!e) break;
      s.conversation = {
        with_id: e.id, started_turn: s.meta.turn, raised: [],
        their_agenda: eff.agenda, friction: 0,
      };
      break;
    }

    case "end_conversation": {
      if (!s.conversation) break;
      const who = s.entities[s.conversation.with_id];
      emitted.push(derived(s, ctx, {
        type: "conversation", target_ids: who ? [who.id] : [],
        payload: { ended: true, reason: eff.reason },
      }));
      s.conversation = null;
      break;
    }

    case "raise_topic": {
      const c = s.conversation;
      if (!c) break;
      if (!c.raised.includes(eff.topic_id)) c.raised.push(eff.topic_id);
      c.friction = Math.max(0, Math.min(10, c.friction + eff.friction));
      break;
    }

    case "recharge_features": {
      const e = s.entities[eff.entity_id];
      if (!e) break;
      rechargeFeatures(e, eff.kind);
      // A long rest also refills the paladin's pool and drops any lingering stance.
      if (eff.kind === "long") delete e.flags["lay_on_hands_used"];
      break;
    }

    case "grant_action": {
      // Action Surge. One more ACTION, not a whole extra turn — the distinction is the
      // entire balance of the feature.
      const cb = s.combat ? s.combat.order.find((o) => o.entity_id === eff.entity_id) : undefined;
      if (cb) cb.economy.action = true;
      break;
    }

    case "tag_relationship": {
      // Tags are how a relationship remembers a KIND of thing that happened, as opposed to
      // a number: "caught lying", "spoke the cant". Cheap to check and cheap to author.
      const key = `${eff.subject}->${eff.object}`;
      const rel = s.relationships[key];
      if (!rel) break;
      if (!rel.tags.includes(eff.tag)) rel.tags.push(eff.tag);
      break;
    }

    case "set_presence": {
      const st = s.settlements[eff.settlement_id];
      if (!st || !s.world.factions[eff.faction_id]) break;
      const before = st.presence.find((p) => p.faction_id === eff.faction_id)?.allegiance ?? null;
      shiftPresence(st, eff.faction_id, {
        ...(eff.allegiance ? { allegiance: eff.allegiance } : {}),
        ...(eff.strength !== undefined ? { strength: eff.strength } : {}),
        ...(eff.openness ? { openness: eff.openness } : {}),
      });
      const after = st.presence.find((p) => p.faction_id === eff.faction_id)!;
      // A town changing hands is news, and news is an event. The timeline should show the
      // day the flag over the gate changed.
      if (eff.allegiance && before !== eff.allegiance) {
        emitted.push(derived(s, ctx, {
          type: "faction",
          payload: {
            settlement_id: st.id, faction_id: eff.faction_id,
            from: before, to: after.allegiance, strength: after.strength,
          },
        }));
      }
      break;
    }

    case "add_legacy": {
      // The world's long memory, append-only for the same reason the fact ledger is: a
      // later campaign should be able to ask what happened and get the record, not a
      // summary somebody rewrote.
      s.legacy = [...s.legacy, ...eff.entries.map((e) => ({ ...e, party_ids: [...e.party_ids], subject_ids: [...e.subject_ids] }))];
      break;
    }

    case "set_campaign_status": {
      const c = s.campaigns[eff.campaign_id];
      if (c) c.status = eff.status;
      break;
    }

    case "set_arc_status": {
      const a = s.arcs[eff.arc_id];
      if (a) a.status = eff.status;
      break;
    }

    case "promote_seed": {
      const arc = s.arcs[eff.arc_id];
      const seed = arc?.seeds.find((x) => x.id === eff.seed_id);
      if (seed) seed.promoted = true;
      break;
    }

    case "join_party": {
      const e = s.entities[eff.entity_id];
      if (!e || !e.alive) break;
      if (s.meta.party_ids.includes(e.id)) break;
      s.meta.party_ids.push(e.id);
      // A recruit becomes a companion in fact, not just in the party list: approval rules,
      // morale and the party panel all key off `kind`.
      if (e.kind === "npc") e.kind = "companion";
      // They travel with you, so they go where you go.
      const lead = s.entities[s.meta.pc_id];
      if (lead) e.location_id = lead.location_id;
      emitted.push(derived(s, ctx, {
        type: "dialogue", actor_id: e.id, payload: { joined_party: true },
      }));
      break;
    }

    case "leave_party": {
      const e = s.entities[eff.entity_id];
      if (!e) break;
      s.meta.party_ids = s.meta.party_ids.filter((id) => id !== e.id);
      emitted.push(derived(s, ctx, {
        type: "dialogue", actor_id: e.id, payload: { left_party: true, reason: eff.reason },
      }));
      break;
    }

    case "set_vow_status": {
      const v = s.vows[eff.vow_id];
      if (!v) break;
      v.status = eff.status;
      break;
    }

    case "add_condition": {
      const e = s.entities[eff.entity_id];
      if (!e) break;
      if (e.conditions.some((c) => c.id === eff.condition_id)) break;
      e.conditions.push({
        id: eff.condition_id,
        source_event_id: ctx.root.id,
        expires_world_minute:
          eff.duration_minutes > 0 ? s.world.world_minute + eff.duration_minutes : null,
        expires_round: eff.rounds > 0 && s.combat ? s.combat.round + eff.rounds : null,
      });
      break;
    }

    case "remove_condition": {
      const e = s.entities[eff.entity_id];
      if (!e) break;
      e.conditions = e.conditions.filter((c) => c.id !== eff.condition_id);
      break;
    }

    case "set_opinion": {
      const rel = s.relationships[relKey(eff.subject, eff.object)];
      if (!rel) break;   // an opinion needs an edge; the numbers come first
      rel.opinion = eff.opinion;
      break;
    }
  }

  return emitted;
}

/** Actual death. The world learns it: witnesses, a death event, every trigger listening. */
function kill(s: GameState, ctx: EffectCtx, e: GameState["entities"][string], cause: string, emitted: GameEvent[]): void {
  e.alive = false;
  e.hp.current = 0;
  e.conditions = e.conditions.filter((c) => c.id !== "unconscious");

  // What they were carrying falls where they did. A fight should leave something behind,
  // and searching a battlefield should be worth the minute it costs.
  for (const instId of [...e.inventory]) {
    const inst = s.items[instId];
    if (!inst) continue;
    inst.owner = { t: "location", id: e.location_id };
    const loc = s.locations[e.location_id];
    if (loc && !loc.contains_item_ids.includes(instId)) loc.contains_item_ids.push(instId);
  }
  e.inventory = [];
  for (const slot of ["main_hand", "off_hand", "armor", "trinket"] as const) e.equipped[slot] = null;
  emitted.push(derived(s, ctx, {
    type: "death",
    actor_id: ctx.root.actor_id,
    target_ids: [e.id],
    location_id: e.location_id,
    payload: { entity_id: e.id, damage_type: cause },
    witnesses: witnessesAt(s, e.location_id, e.id),
  }));
}

/** Apply a dims delta with the ±10 per-turn clamp, and append to the edge's history. */
export function adjustAttitude(
  s: GameState,
  ctx: EffectCtx,
  subject: string,
  object: string,
  dims: Dims,
  reason: string,
): void {
  if (!s.entities[subject] || !s.entities[object]) return;
  const key = relKey(subject, object);
  const rel = (s.relationships[key] ??= {
    subject, object, dims: { ...NEUTRAL_DIMS }, opinion: "", tags: [], history: [],
  });

  const applied: Dims = {};
  let changed = false;

  for (const dim of DIMS) {
    const raw = dims[dim];
    if (raw === undefined || raw === 0) continue;

    let allowed = Math.trunc(raw);

    if (ctx.clampAttitude) {
      const budgetKey = `${key}|${dim}`;
      const spent = ctx.attitudeSpent.get(budgetKey) ?? 0;
      const room = ATTITUDE_CLAMP_PER_TURN - Math.abs(spent);
      if (room <= 0) continue;
      allowed = Math.trunc(clamp(raw, -room, room));
      ctx.attitudeSpent.set(budgetKey, spent + Math.abs(allowed));
    }

    if (allowed === 0) continue;
    rel.dims[dim] = clamp(rel.dims[dim] + allowed, -100, 100);
    applied[dim] = allowed;
    changed = true;
  }

  if (!changed) return;
  rel.history.push({ turn: s.meta.turn, event_id: ctx.root.id, dims: applied, reason });
}

/** Everyone alive in the room other than the subject. Drives knowledge propagation. */
export function witnessesAt(s: GameState, locationId: string | null, exclude?: string): string[] {
  if (!locationId) return [];
  return Object.values(s.entities)
    .filter((e) => e.alive && e.location_id === locationId && e.id !== exclude)
    .map((e) => e.id)
    .sort();
}

function expireConditions(s: GameState): void {
  const now = s.world.world_minute;
  for (const e of Object.values(s.entities)) {
    e.conditions = e.conditions.filter(
      (c) => c.expires_world_minute === null || c.expires_world_minute > now,
    );
  }
}

/**
 * NPCs walk their schedule when the clock moves. Cheap, and the world feels alive.
 *
 * A schedule is a DEFAULT, and the story overrides it. This is not a nicety: in the first
 * full playthrough the raid on Wickmoor fired exactly as authored — it flagged the
 * player's parents dead and moved their abducted sister to the north road — and then this
 * function walked all three of them back onto the village green, because their schedule
 * said "the green, every hour of the day". The player spent sixty turns hunting a sister
 * who was, as far as the world was concerned, standing behind them the whole time.
 *
 * So anyone the story has taken off the board stays off it. `story_locked` is a reserved
 * entity flag that content sets to mean exactly that.
 */
export const STORY_LOCK_FLAG = "story_locked";

function relocateOnSchedule(s: GameState): void {
  for (const id of Object.keys(s.entities).sort()) {
    const e = s.entities[id]!;
    if (!e.alive || e.id === s.meta.pc_id || e.schedule.length === 0) continue;
    if (e.flags["is_template"] === true) continue;
    if (e.flags[STORY_LOCK_FLAG] === true) continue;
    const want = scheduledLocation(s, e);
    if (want && s.locations[want] && e.location_id !== want) {
      e.location_id = want;
      e.zone_id = null;
    }
  }
}

/** Build a cascade event: journaled for the audit trail, skipped on replay. */
/**
 * Advance the scene, if this really was a boundary.
 *
 * Written as a derived event rather than a quiet mutation so it lands in the journal: the
 * timeline can draw its divider, a rewind puts the scene back, and the cascade inspector
 * shows what ended the chapter. Same rule as everything else — if it changed the world, it
 * is an event.
 */
function breakScene(
  s: GameState,
  ctx: EffectCtx,
  what: Parameters<typeof sceneBreakFor>[1],
): GameEvent[] {
  const brk = sceneBreakFor(s, what);
  if (!brk) return [];
  const from = s.world.scene_id;
  s.world.scene_id = nextSceneId(s);
  s.world.scene_started_turn = s.meta.turn;
  return [derived(s, ctx, {
    type: "scene_break",
    payload: { from, to: s.world.scene_id, reason: brk.reason, label: brk.label },
  })];
}

export function derived(
  s: GameState,
  ctx: EffectCtx,
  partial: Partial<GameEvent> & { type: GameEvent["type"] },
): GameEvent {
  return {
    id: nextId(s, "evt"),
    turn: s.meta.turn,
    world_minute: s.world.world_minute,
    type: partial.type,
    actor_id: partial.actor_id ?? null,
    target_ids: partial.target_ids ?? [],
    location_id: partial.location_id ?? ctx.root.location_id,
    payload: partial.payload ?? {},
    rolls: [],
    direct_effects: [],
    attitude_impact: partial.attitude_impact ?? [],
    witnesses: partial.witnesses ?? [],
    fact_ids: [],
    duration_minutes: 0,
    rng_nonce: "",
    derived_from: ctx.root.id,
    trigger_id: ctx.trigger_id,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
