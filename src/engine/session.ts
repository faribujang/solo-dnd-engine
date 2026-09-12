import type { GameEvent } from "../schema/event.js";
import type { GameState } from "../schema/state.js";
import { reduce } from "./reduce.js";
import { resolve, type Action } from "./turn.js";
import { choosePolicyAction, combatOver, currentCombatant } from "./combat.js";
import { Rng, freshNonce, seedToState } from "../rules/rng.js";
import type { GameEvent as Ev } from "../schema/event.js";

/**
 * One turn, end to end: resolve → reduce → report. The CLI, the tests and (in phase 1)
 * the LLM loop all go through here, so there is exactly one definition of what a turn is.
 */

export interface TurnOutcome {
  ok: boolean;
  /** Mechanics summary on success, refusal reason on failure. */
  message: string;
  state: GameState;
  /** Root event plus every cascade, in application order. Empty on a refusal. */
  journal: GameEvent[];
  fired: string[];
  truncated: boolean;
}

export function takeTurn(state: GameState, action: Action, opts: { actorId?: string } = {}): TurnOutcome {
  // In a fight, a human's action is for whoever's turn it is — the lead, or a companion a
  // player is driving. Outside one, it is the lead.
  let actorId = opts.actorId;
  if (!actorId && state.combat) {
    const cur = state.entities[currentCombatant(state.combat).entity_id];
    if (cur?.controller === "human") actorId = cur.id;
  }
  const r = resolve(state, action, actorId ? { actorId } : {});

  // A refused action costs no time and writes nothing. Impossible things do not get rolled
  // for, and they do not get journaled either.
  if (!r.ok) {
    return { ok: false, message: r.reason, state, journal: [], fired: [], truncated: false };
  }

  let red = reduce(state, r.event);
  let journal = [...red.journal];
  let fired = [...red.fired];

  // The fight runs itself between human turns: CPU combatants act, and the fight ends the
  // moment a side is done. All of it is journaled as ordinary root events.
  for (let guard = 0; guard < 40 && red.state.combat; guard++) {
    const s = red.state;
    const winner = combatOver(s, s.combat!);
    if (winner) {
      const endEv = rootFor(s, "combat_end", [{ t: "end_combat", winner }]);
      red = reduce(s, endEv); journal.push(...red.journal); fired.push(...red.fired);
      break;
    }
    const cur = currentCombatant(s.combat!);
    const who = s.entities[cur.entity_id]!;
    if (who.controller === "human" && who.hp.current > 0) break;
    const nonce = s.meta.session_zero.dice === "committed" ? "" : freshNonce();
    const rng = new Rng(seedToState(`${s.meta.seed}|cpu|${s.meta.turn}|${nonce}`));
    const cpuAction: Action = who.hp.current === 0 ? { type: "death_save" } : choosePolicyAction(s, s.combat!, who, rng);
    const rr = resolve(s, cpuAction, { actorId: who.id, nonce });
    if (!rr.ok) {
      const endTurn = resolve(s, { type: "end_turn" }, { actorId: who.id, nonce });
      if (!endTurn.ok) break;
      red = reduce(s, endTurn.event);
    } else {
      red = reduce(s, rr.event);
    }
    journal.push(...red.journal); fired.push(...red.fired);
  }

  if (red.truncated) {
    // Hitting the cascade depth limit means authored content is looping. Surface it loudly
    // rather than shipping a world that quietly stops resolving.
    console.warn(
      `[engine] cascade depth limit hit on ${r.event.id} (${r.event.type}). ` +
        `Fired: ${red.fired.join(", ")}`,
    );
  }

  return {
    ok: true,
    message: r.mechanics,
    state: red.state,
    journal,
    fired,
    truncated: red.truncated,
  };
}

/** A root event carrying only effects, for engine-initiated turns like ending a fight. */
function rootFor(s: GameState, type: Ev["type"], effects: Ev["direct_effects"]): Ev {
  const turn = s.meta.turn + 1;
  return {
    id: `evt_r${String(turn).padStart(4, "0")}`, turn, world_minute: s.world.world_minute, type,
    actor_id: null, target_ids: [], location_id: s.combat?.location_id ?? null, payload: {},
    rolls: [], direct_effects: effects, attitude_impact: [], witnesses: [], fact_ids: [],
    duration_minutes: 0, rng_nonce: "", derived_from: null, trigger_id: null,
  };
}

/** Run a scripted sequence. Used by the golden replay test and `npm run play -- --script`. */
export function runScript(
  initial: GameState,
  actions: readonly Action[],
): { state: GameState; journal: GameEvent[]; log: string[] } {
  let state = initial;
  const journal: GameEvent[] = [];
  const log: string[] = [];

  for (const [i, action] of actions.entries()) {
    const out = takeTurn(state, action);
    state = out.state;
    journal.push(...out.journal);
    log.push(`${String(i + 1).padStart(2, "0")}. ${describe(action)} → ${out.ok ? out.message : `REFUSED: ${out.message}`}`);
  }

  return { state, journal, log };
}

export function describe(a: Action): string {
  switch (a.type) {
    case "move": return `move ${a.dir}`;
    case "skill_check": return `check ${a.skill} ${a.band}${a.tag ? ` (${a.tag})` : ""}`;
    case "attack": return `attack ${a.target_id}`;
    case "talk": return `talk ${a.target_id}${a.topic ? ` about ${a.topic}` : ""}`;
    case "take": return `take ${a.item_instance_id}`;
    case "give": return `give ${a.item_instance_id} to ${a.target_id}`;
    case "look": return "look";
    case "wait": return `wait ${a.minutes}`;
    case "rest": return `rest ${a.kind}`;
    case "recruit": return `ask ${a.target_id} to join you`;
    case "death_save": return "death save";
    case "equip": return `equip ${a.item_instance_id} → ${a.slot ?? "unequip"}`;
    case "end_turn": return "end turn";
    case "dash": return "dash";
    case "disengage": return "disengage";
    case "dodge": return "dodge";
    case "move_zone": return `move to ${a.zone_id}`;
    case "flee": return "flee";
    case "cast": return `cast ${a.spell_id}${a.target_id ? ` at ${a.target_id}` : ""}`;
    case "shove": return `shove ${a.target_id} (${a.mode})`;
    case "travel": return `travel to ${a.location_id}`;
    case "buy": return `buy ${a.item_def_id}`;
    case "sell": return `sell ${a.item_instance_id}`;
  }
}
