import type { GameEvent } from "../schema/event.js";
import type { GameState } from "../schema/state.js";
import { applyEffect, adjustAttitude, castUpkeep, derived, newEffectCtx, type EffectCtx } from "./effects.js";
import { propagateKnowledge } from "./knowledge.js";
import { collectTriggers, expiredQuestIds, markFired } from "./triggers.js";
import { reactionEffects, reactionsTo, signOf } from "../rules/approval.js";

/**
 * The reducer. `newState = reduce(state, event)`.
 *
 * Three properties this file exists to guarantee:
 *   PURE      — no I/O, no clock, no randomness. Same inputs, same output, always.
 *   UNIFORM   — it knows nothing about quests, combat or dialogue. Event semantics arrive
 *               as `direct_effects`, computed during resolution.
 *   AUDITABLE — every cascade is journaled with the trigger that caused it, so
 *               "why did the guards turn hostile" is always answerable.
 */

export const MAX_CASCADE_DEPTH = 8;

export interface ReduceResult {
  state: GameState;
  /** The root event followed by every cascade event, in the order they were applied. */
  journal: GameEvent[];
  /** Triggers that fired, for debugging and for the UI's "why did that happen" view. */
  fired: string[];
  /** True if the cascade hit the depth limit — a content bug worth surfacing loudly. */
  truncated: boolean;
}

export function reduce(state: GameState, root: GameEvent): ReduceResult {
  const s: GameState = structuredClone(state);
  const journal: GameEvent[] = [root];
  const fired: string[] = [];
  const ctx = newEffectCtx(root, null);

  // The turn is carried BY the event, not recomputed, so replay lands on the same counter.
  s.meta.turn = root.turn;

  let frontier: GameEvent[] = [root];
  let depth = 0;
  let truncated = false;

  while (frontier.length > 0) {
    if (depth >= MAX_CASCADE_DEPTH) {
      truncated = true;
      break;
    }

    const next: GameEvent[] = [];

    for (const ev of frontier) {
      // 1. The event's own mechanical payload, already resolved to concrete numbers.
      //    Anything it spawns (a death from damage, an arrival from a move) is a cascade
      //    like any other and belongs in the journal, not just in the work queue.
      for (const em of applyDirect(s, ev, ctx)) {
        journal.push(em);
        next.push(em);
      }

      // 2. Witnesses learn what this event produced.
      propagateKnowledge(s, ev);

      // 3a. The actor remembers their natural d20s — karmic dice and the "luck" readout
      //     both read this. Kept short; it is a mood, not a ledger.
      if (ev.actor_id && ev.rolls.length) {
        const actor = s.entities[ev.actor_id];
        if (actor) {
          for (const r of ev.rolls) if (r.die === "d20") actor.recent_d20s.push(r.raw);
          if (actor.recent_d20s.length > 12) actor.recent_d20s = actor.recent_d20s.slice(-12);
        }
      }

      // 3. Attitude impact recorded on the event itself.
      for (const imp of ev.attitude_impact) {
        adjustAttitude(s, ctx, imp.subject, imp.object, imp.dims, imp.reason);
      }

      // 3b. Companions who were there form an opinion. Authored per character, so two
      //     companions can watch the same act and disagree about it.
      const reactions = reactionsTo(s, ev);
      for (const eff of reactionEffects(s, reactions)) {
        applyEffect(s, eff, { ...ctx, root: ev });
      }

      // 3c. And when they feel strongly enough, THEY SAY SO.
      //
      //     Until now every reaction was a silent number: companions approved and
      //     disapproved and the player found out by opening a menu. A companion who never
      //     speaks is a stat block with a name, and this is the cheapest line in the
      //     project that turns one back into a person.
      //
      //     The authored `line` is used directly, which keeps this deterministic and makes
      //     it work with no model at all. The narrator is separately told what they are
      //     reacting to (see context/build.ts) so it can voice the same beat better — but
      //     the beat happens either way, because voice is decoration and the reaction is
      //     truth.
      for (const r of reactions) {
        if (!r.vocal || !r.line) continue;
        const em = derived(s, { ...ctx, root: ev }, {
          type: "dialogue",
          actor_id: r.companion_id,
          payload: { said: r.line, reacting_to: r.situation, approval: signOf(r.dims) },
        });
        journal.push(em);
        next.push(em);
      }

      // 4. Everything that was listening.
      for (const armed of collectTriggers(s, ev)) {
        markFired(s, armed);
        fired.push(armed.key);
        const childCtx: EffectCtx = { ...ctx, root: ev, trigger_id: armed.trigger.id };
        for (const eff of armed.effects) {
          const emitted = applyEffect(s, eff, childCtx);
          for (const em of emitted) {
            journal.push(em);
            next.push(em);
          }
        }
      }
    }

    // 5. Deadlines are a property of the clock, not of any one event.
    for (const qid of expiredQuestIds(s)) {
      const em = derived(s, ctx, { type: "quest_update", payload: { quest_id: qid, status: "expired" } });
      applyEffect(s, { t: "set_quest_status", quest_id: qid, status: "expired" }, ctx);
      journal.push(em);
      next.push(em);
    }

    frontier = next;
    depth++;
  }

  // 6. Who is cast and who was scenery. Runs last, because promotion asks how strong a
  //    relationship is and the effects above are what just made it that strong.
  castUpkeep(s);

  return { state: s, journal, fired, truncated };
}

/**
 * Apply an event's direct effects and its duration. Deliberately the only place event
 * "meaning" is interpreted, and it interprets exactly two things — which is why adding a
 * new action type never requires touching the reducer.
 */
function applyDirect(s: GameState, ev: GameEvent, ctx: EffectCtx): GameEvent[] {
  const emitted: GameEvent[] = [];
  const localCtx: EffectCtx = { ...ctx, root: ev };

  for (const eff of ev.direct_effects) {
    emitted.push(...applyEffect(s, eff, localCtx));
  }

  if (ev.duration_minutes > 0) {
    emitted.push(...applyEffect(s, { t: "advance_time", minutes: ev.duration_minutes }, localCtx));
  }

  return emitted;
}

/** Fold a sequence of root events. Cascades are regenerated, never replayed. */
export function reduceAll(state: GameState, events: readonly GameEvent[]): ReduceResult {
  let s = state;
  const journal: GameEvent[] = [];
  const fired: string[] = [];
  let truncated = false;

  for (const ev of events) {
    if (ev.derived_from !== null) continue; // cascades are derived, not inputs
    const r = reduce(s, ev);
    s = r.state;
    journal.push(...r.journal);
    fired.push(...r.fired);
    truncated ||= r.truncated;
  }

  return { state: s, journal, fired, truncated };
}
