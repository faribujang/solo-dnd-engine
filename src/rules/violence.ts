import type { GameState } from "../schema/state.js";
import type { AttitudeImpact } from "../schema/event.js";

/**
 * WHAT VIOLENCE COSTS YOU, WHETHER OR NOT ANYBODY NARRATES IT.
 *
 * Stabbing the village smith used to leave his regard for you untouched: affinity 55,
 * trust 60, fear 0, exactly as before. The event even recorded who watched. The only
 * reason a real playthrough showed a village terrified of the player is that the NARRATOR
 * noticed and proposed attitude deltas — which means with the model down, or merely
 * incurious, you could murder somebody's friend in front of them and stay well liked.
 *
 * That is the one rule broken in its own house. How somebody feels about being attacked is
 * not voice. It is not interpretation, or colour, or a thing a good DM adds. It is the most
 * mechanical consequence in the entire game and it belongs in code.
 *
 * The narrator may still adjust attitudes on top of this — it knows about insults, broken
 * promises and long looks, and those genuinely are its job. This is the floor.
 */

/** How far a single act can move somebody, so one punch is not a life sentence. */
const CLAMP = 30;

export interface ViolenceContext {
  attackerId: string;
  victimId: string;
  /** Everyone who saw it, attacker and victim excluded by the caller. */
  witnessIds: readonly string[];
  hit: boolean;
  damage: number;
  /** The blow took them to nothing. */
  downed: boolean;
  killed: boolean;
}

/**
 * The attitude fallout of one violent act.
 *
 * Scaled by what actually happened — a missed swing is an insult, a killing blow is a
 * different category of event — and by whether the watcher had any reason to care about
 * the person bleeding. A stranger's death frightens; a friend's death is personal.
 */
export function violenceImpact(s: GameState, v: ViolenceContext): AttitudeImpact[] {
  const out: AttitudeImpact[] = [];
  const victim = s.entities[v.victimId];
  const attacker = s.entities[v.attackerId];
  if (!victim || !attacker) return out;

  const severity = v.killed ? 3 : v.downed ? 2 : v.hit ? 1 : 0.5;

  // ── the victim. Being attacked is the least ambiguous thing that can happen to you.
  out.push({
    subject: v.victimId,
    object: v.attackerId,
    dims: clampAll({
      affinity: -18 * severity,
      trust: -22 * severity,
      fear: 14 * severity,
      respect: v.hit ? 2 : -6,   // losing to someone is not the same as being missed by them
    }),
    reason: v.killed ? "they killed me" : v.hit ? "they attacked me" : "they swung at me",
  });

  // ── everyone watching. What they feel depends on who they were watching get hurt.
  for (const id of v.witnessIds) {
    if (id === v.attackerId || id === v.victimId) continue;
    const watcher = s.entities[id];
    if (!watcher?.alive) continue;

    // How much the witness cared about the victim, from their own relationship row.
    const bond = s.relationships[`${id}->${v.victimId}`]?.dims.affinity ?? 0;
    const cared = Math.max(0, bond) / 100;          // 0 when indifferent, 1 when devoted

    out.push({
      subject: id,
      object: v.attackerId,
      dims: clampAll({
        // Fear is the universal reaction; you now know what this person will do.
        fear: 10 * severity + 8 * severity * cared,
        affinity: -6 * severity - 14 * severity * cared,
        trust: -8 * severity - 10 * severity * cared,
        // Violence does buy a kind of standing with people who were not attached to the
        // victim. It is not admiration; it is being taken seriously.
        respect: cared > 0.3 ? -8 * severity : 3 * severity,
      }),
      reason: v.killed
        ? `they killed ${victim.name} in front of me`
        : `they attacked ${victim.name} in front of me`,
    });
  }

  return out;
}

function clampAll(dims: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(dims)) {
    const n = Math.round(v);
    if (n !== 0) out[k] = Math.max(-CLAMP, Math.min(CLAMP, n));
  }
  return out;
}
