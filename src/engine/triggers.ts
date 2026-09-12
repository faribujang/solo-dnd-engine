import type { Effect, Trigger } from "../schema/dsl.js";
import type { GameEvent } from "../schema/event.js";
import type { GameState } from "../schema/state.js";
import { evaluate } from "./conditions.js";

/**
 * Trigger collection and matching. Triggers live wherever they belong — on quest steps,
 * on locations, on entities, and globally on the world — and this module gathers the ones
 * that could fire for a given event into one deterministically ordered list.
 */

export interface ArmedTrigger {
  /** Namespaced key used for `once` bookkeeping. Authored ids need only be locally unique. */
  key: string;
  source: string;          // human-readable origin, for debugging
  trigger: Trigger;
  effects: Effect[];       // may include effects synthesized by the source (quest steps)
}

export function collectTriggers(s: GameState, ev: GameEvent): ArmedTrigger[] {
  const out: ArmedTrigger[] = [];

  // 1. Global world triggers.
  for (const t of s.world.triggers) {
    out.push({ key: `world:${t.id}`, source: "world", trigger: t, effects: t.then });
  }

  // 2. Location triggers, for the location this event happened in.
  if (ev.location_id) {
    const loc = s.locations[ev.location_id];
    if (loc) {
      for (const t of loc.on_enter_triggers) {
        out.push({ key: `loc:${loc.id}:${t.id}`, source: `location ${loc.id}`, trigger: t, effects: t.then });
      }
    }
  }

  // 3. Entity triggers. on_death fires for the dead; on_first_talk for the one spoken to.
  for (const id of Object.keys(s.entities).sort()) {
    const e = s.entities[id]!;
    for (const t of e.on_death) {
      out.push({ key: `ent:${e.id}:death:${t.id}`, source: `entity ${e.id}`, trigger: t, effects: t.then });
    }
    for (const t of e.on_first_talk) {
      out.push({ key: `ent:${e.id}:talk:${t.id}`, source: `entity ${e.id}`, trigger: t, effects: t.then });
    }
  }

  // 4. Quest triggers: step completion, and quest failure.
  for (const qid of Object.keys(s.quests).sort()) {
    const q = s.quests[qid]!;

    if (q.status === "active") {
      const step = q.steps.find((st) => st.id === q.current_step_id);
      if (step && step.status === "active") {
        for (const t of step.completion_triggers) {
          // A completing step runs its own on_complete, then either advances to the next
          // step or, if it was the last, completes the quest. Synthesized here so the
          // reducer stays uniform and knows nothing about quests.
          const idx = q.steps.findIndex((st) => st.id === step.id);
          const next = q.steps[idx + 1];
          const tail: Effect[] = next
            ? [{ t: "advance_quest", quest_id: q.id, step_id: next.id }]
            : [
                { t: "advance_quest", quest_id: q.id, step_id: step.id },
                { t: "set_quest_status", quest_id: q.id, status: "complete" },
              ];
          out.push({
            key: `quest:${q.id}:${step.id}:${t.id}`,
            source: `quest ${q.id} step ${step.id}`,
            trigger: t,
            // The trigger's own `then` runs first, then the step's on_complete, then the
            // synthesized advance. Dropping `then` here would silently ignore effects an
            // author wrote directly on a completion trigger.
            effects: [...t.then, ...step.on_complete, ...tail],
          });
        }
      }

      for (const t of q.failure_triggers) {
        out.push({
          key: `quest:${q.id}:fail:${t.id}`,
          source: `quest ${q.id} failure`,
          trigger: t,
          effects: [...t.then, { t: "set_quest_status", quest_id: q.id, status: "failed" }],
        });
      }
    }
  }

  return out.filter((a) => isArmed(s, a, ev));
}

function isArmed(s: GameState, a: ArmedTrigger, ev: GameEvent): boolean {
  const t = a.trigger;
  if (t.on !== ev.type) return false;
  if (t.once !== false && s.world.fired_trigger_ids.includes(a.key)) return false;
  if (!matchesEvent(t, ev)) return false;
  return evaluate(t.when, s);
}

/** Structural match. Every key present on the matcher must hold. */
export function matchesEvent(t: Trigger, ev: GameEvent): boolean {
  const m = t.match;
  if (!m) return true;
  if (m.actor_id !== undefined && ev.actor_id !== m.actor_id) return false;
  if (m.location_id !== undefined && ev.location_id !== m.location_id) return false;
  if (m.target_ids !== undefined && !m.target_ids.every((id) => ev.target_ids.includes(id))) return false;
  if (m.payload_key !== undefined && !ev.payload[m.payload_key]) return false;
  return true;
}

export function markFired(s: GameState, a: ArmedTrigger): void {
  if (a.trigger.once === false) return;
  if (!s.world.fired_trigger_ids.includes(a.key)) s.world.fired_trigger_ids.push(a.key);
}

/** Quest deadlines are checked whenever the clock moves, not by a trigger. */
export function expiredQuestIds(s: GameState): string[] {
  return Object.keys(s.quests)
    .sort()
    .filter((qid) => {
      const q = s.quests[qid]!;
      return (
        q.status === "active" &&
        q.deadline_world_minute !== null &&
        s.world.world_minute >= q.deadline_world_minute
      );
    });
}
