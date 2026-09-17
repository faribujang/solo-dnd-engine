import type { GameState } from "../schema/state.js";
import type { Fact } from "../schema/fact.js";
import type { Skill } from "../schema/common.js";
import { entitiesAt, npcsPresent, pc } from "../state/selectors.js";
import { settlementOf } from "./factions.js";

/**
 * PLAYING AT THE RIGHT ZOOM.
 *
 * At a table, "I spend the morning asking after the surveyor" is ONE declaration. The DM
 * rolls once, narrates the afternoon back, and moves on. Nobody walks the player from door
 * to door. This engine could not do that at all: every social act had to name exactly one
 * person, so a request to ask around never even reached the narrator — the intent parser
 * refused it and asked "speak to whom?".
 *
 * That is not a prompt problem and no instruction to "use broader strokes" can fix it. It
 * is a missing verb.
 *
 * What makes the verb safe is that CODE still decides what is learned. A montage does not
 * ask the model to invent what the morning turned up; it selects real facts out of the
 * ledger — ones somebody in this settlement actually knows, that the player does not, and
 * that nobody is sealed about — and hands the model the job it is qualified for, which is
 * describing an afternoon. The clock runs the whole time, which is the cost.
 */

export type MontageKind = "ask_around" | "search" | "watch" | "work";

/** Which skill each way of spending a few hours leans on, and how long it takes. */
export const MONTAGE: Record<MontageKind, { skill: Skill; minutes: number; verb: string }> = {
  // Talking to whoever will talk. The broadest and the one players reach for first.
  ask_around: { skill: "persuasion", minutes: 180, verb: "asking around" },
  // Turning a place over rather than searching one cupboard.
  search: { skill: "investigation", minutes: 120, verb: "searching" },
  // Sitting still somewhere and letting the place show you its habits.
  watch: { skill: "perception", minutes: 180, verb: "watching" },
  // Hands busy, ears open. Slower, and it buys goodwill rather than secrets.
  work: { skill: "insight", minutes: 300, verb: "working alongside them" },
};

/** How many facts a montage can turn up, by how well it went. */
export function yieldFor(degree: string | null, success: boolean): number {
  if (degree === "critical_success") return 3;
  if (degree === "success") return 2;
  if (degree === "success_at_a_cost") return 1;
  // A failed morning is not a wasted one — you get the thing everybody repeats, which is
  // often the least useful thing anybody knows. "Nothing happens" is the one outcome a
  // real DM never gives.
  return success ? 1 : 1;
}

/**
 * Everyone a montage could plausibly talk to.
 *
 * The whole settlement, not just this room — that is the point of the verb. Falls back to
 * the room when you are somewhere that is not a settlement at all.
 */
export function crowdFor(s: GameState, locationId: string): string[] {
  const settlement = settlementOf(s, locationId);
  const ids = settlement
    ? settlement.location_ids.flatMap((l) => entitiesAt(s, l).map((e) => e.id))
    : npcsPresent(s, locationId).map((e) => e.id);
  const me = s.meta.pc_id;
  return [...new Set(ids)].filter((id) => id !== me && s.entities[id]?.alive).sort();
}

/**
 * What this crowd could tell you, best first.
 *
 * Deterministic — sorted by importance then id, never shuffled — because a montage is a
 * journaled action and a replay has to turn up the same morning. The dice decide HOW MANY
 * of these you get; they never decide which ones exist.
 */
export function harvestable(s: GameState, topic: string, crowd: readonly string[]): Fact[] {
  const me = s.meta.pc_id;
  const knowers = new Set(crowd);
  const wanted = topic.toLowerCase().trim();

  const scored = s.facts
    .filter((f) => {
      if (f.known_by.includes(me)) return false;            // already yours
      if (f.superseded_by) return false;                    // no longer true
      if (f.seal) return false;                             // a door no morning opens
      return f.known_by.some((k) => knowers.has(k));        // somebody here knows it
    })
    .map((f) => ({ f, score: relevance(s, f, wanted) }))
    .filter((x) => x.score > 0);

  scored.sort((a, b) =>
    b.score - a.score || b.f.importance - a.f.importance || a.f.id.localeCompare(b.f.id));
  return scored.map((x) => x.f);
}

/**
 * How much a fact has to do with what was asked.
 *
 * A montage with a topic is a targeted question and should mostly answer it; a montage
 * with none is an idle morning and takes whatever is going. Untargeted facts still score
 * above zero so that asking about the wrong thing still costs you the time and tells you
 * something — being told what the village would rather discuss IS information.
 */
function relevance(s: GameState, f: Fact, wanted: string): number {
  if (!wanted) return 1 + f.importance / 10;

  const haystack = [
    f.text,
    ...f.subjects.map((id) => s.entities[id]?.name ?? s.world.factions[id]?.name ?? ""),
  ].join(" ").toLowerCase();

  const words = wanted.split(/[^a-z0-9']+/).filter((w) => w.length > 3);
  const hits = words.filter((w) => haystack.includes(w)).length;
  if (hits > 0) return 10 + hits + f.importance / 10;
  return 1 + f.importance / 10;
}

/** Who to thank, or blame, for what a montage turned up. */
export function sourcesOf(fact: Fact, crowd: readonly string[]): string[] {
  const inCrowd = new Set(crowd);
  return fact.known_by.filter((id) => inCrowd.has(id)).sort();
}

/** A line naming what the hours bought, for the mechanics summary and the fallback text. */
export function describeMontage(
  s: GameState,
  kind: MontageKind,
  topic: string,
  learned: readonly Fact[],
): string {
  const hours = Math.round(MONTAGE[kind].minutes / 60);
  const about = topic ? ` about ${topic}` : "";
  const who = pc(s).name;
  if (learned.length === 0) {
    return `${who} spends ${hours} hours ${MONTAGE[kind].verb}${about}, and turns up nothing new.`;
  }
  return `${who} spends ${hours} hours ${MONTAGE[kind].verb}${about}. Turned up: `
    + learned.map((f) => f.text).join(" / ");
}
