import type { Effect } from "../schema/dsl.js";
import type { GameState } from "../schema/state.js";
import type { Entity } from "../schema/entity.js";
import { standingToward } from "./backgrounds.js";

/**
 * WHAT THEY HEARD ABOUT YOU BEFORE YOU ARRIVED.
 *
 * Faction reputation existed, settlement reputation existed, and neither reached the other.
 * So a party could burn the Ashen Hand's warehouse, ride two days to the next town where
 * the Hand collects tolls, and be met by a shrug. Every NPC started at zero forever, and
 * consequence stopped at the town line — which is the exact opposite of the promise this
 * engine makes.
 *
 * The fix is small and it hangs off machinery that already exists. When you meet someone
 * for the first time, they do not start neutral. They start wherever their faction, their
 * town, and whatever has been said about you in this place put them.
 *
 * Two rules keep it honest:
 *
 *   1. **It applies ONCE, on first meeting.** After that the relationship is the record of
 *      what you two actually did, and reputation never overwrites lived experience. A man
 *      who has learned to like you does not un-like you because your faction standing dips.
 *   2. **Every shift carries its reason**, so the roll card and the relationship history
 *      can say "the Ashen Hand's word reached here first" rather than showing a bare −18.
 */

/** Reputation is hearsay. It never moves someone as far as meeting you does. */
export const HEARSAY_CAP = 35;

export interface Standing {
  affinity: number;
  trust: number;
  fear: number;
  reasons: string[];
}

/**
 * How someone who has never met you starts out.
 *
 * Faction standing dominates — it is the most specific thing about them — with the town's
 * general feeling underneath it and notoriety on top.
 */
export function arrivalStanding(s: GameState, npc: Entity): Standing {
  const pcId = s.meta.pc_id;
  const reasons: string[] = [];
  let affinity = 0;
  let trust = 0;
  let fear = 0;

  // 1. Their faction's books. Someone in the Hand has read what you did to the Hand.
  for (const fid of npc.faction_ids) {
    const f = s.world.factions[fid];
    if (!f || f.rep_with_pc === 0) continue;
    // Halved: a member is not the faction. A footsoldier of an order you crossed dislikes
    // you; he does not hate you the way the order's ledger does.
    affinity += Math.round(f.rep_with_pc / 2);
    trust += Math.round(f.rep_with_pc / 3);
    if (f.rep_with_pc <= -40) {
      fear += 10;
      reasons.push(`${f.name} has put word out about you`);
    } else if (f.rep_with_pc >= 40) {
      reasons.push(`${f.name} speaks well of you`);
    }
  }

  // 2. The town's general feeling. Weaker, and it applies to everyone in it.
  const settlement = Object.values(s.settlements).find((st) =>
    st.location_ids.includes(npc.location_id),
  );
  if (settlement && settlement.reputation_with_pc !== 0) {
    affinity += Math.round(settlement.reputation_with_pc / 3);
    trust += Math.round(settlement.reputation_with_pc / 4);
    reasons.push(
      settlement.reputation_with_pc > 0
        ? `you are well thought of in ${settlement.name}`
        : `${settlement.name} has heard of you, and not kindly`,
    );
  }

  // 3. Notoriety. A fact ABOUT YOU that this person already knows, without ever having met
  //    you, is by definition something that travelled — so it counts for more than gossip.
  const aboutYou = s.facts.filter(
    (f) => !f.superseded_by && f.subjects.includes(pcId) && f.known_by.includes(npc.id) && f.importance >= 4,
  );
  for (const f of aboutYou) {
    // The ledger does not store whether a deed was admirable, and code must not guess at
    // it — that is a judgement, and judgements belong to authored data. What code CAN say
    // is that they have heard of you, which shifts fear and respect but not affection.
    fear += 5;
    reasons.push(`they have heard what happened: ${f.text}`);
  }

  // 4. And what you plainly ARE. Where you came from is the first thing anyone learns
  //    about you — before your name, usually — and it is read differently depending on
  //    what sort of person is doing the reading. See rules/backgrounds.ts.
  for (const st of standingToward(s, npc)) {
    affinity += st.dims.affinity ?? 0;
    trust += st.dims.trust ?? 0;
    fear += st.dims.fear ?? 0;
    reasons.push(st.reason);
  }

  const cap = (n: number) => Math.max(-HEARSAY_CAP, Math.min(HEARSAY_CAP, n));
  return { affinity: cap(affinity), trust: cap(trust), fear: cap(fear), reasons };
}

/**
 * The effects to apply when the player first meets these people.
 *
 * Returns nothing for anyone already known — an existing edge means you have met, and what
 * you did together outranks anything anyone said about you.
 */
export function arrivalEffects(s: GameState, npcs: readonly Entity[]): Effect[] {
  const pcId = s.meta.pc_id;
  const out: Effect[] = [];

  for (const npc of npcs) {
    if (!npc.alive || npc.flags["is_template"] === true) continue;
    // Already met. Their opinion is theirs now.
    if (s.relationships[`${npc.id}->${pcId}`]) continue;

    const st = arrivalStanding(s, npc);
    if (st.affinity === 0 && st.trust === 0 && st.fear === 0) continue;

    out.push({
      t: "adjust_attitude",
      subject: npc.id,
      object: pcId,
      dims: { affinity: st.affinity, trust: st.trust, fear: st.fear },
      reason: st.reasons[0] ?? "your reputation preceded you",
    });
  }

  return out;
}
