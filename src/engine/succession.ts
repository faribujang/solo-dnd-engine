import type { Effect } from "../schema/dsl.js";
import type { GameState } from "../schema/state.js";
import type { LegacyEntry, Seed } from "../schema/campaign.js";
import type { Rng } from "../rules/rng.js";
import { MINUTES_PER_DAY } from "../schema/world.js";

/**
 * SUCCESSION — how a world becomes lived-in.
 *
 * When a campaign ends, the party stops but the world does not. It records what they did,
 * ages forward, promotes the threads they left dangling, and offers the next campaign to a
 * new party standing in the changes the last one made.
 *
 * This is the payoff for keeping a causal graph rather than a save file. By the third
 * campaign the system can put the first party's survivors on the board — as allies, as
 * legends, as antagonists — because it knows exactly what they did and to whom. No amount
 * of prompt engineering substitutes for having the record.
 */

export interface SuccessionPlan {
  /** Written to the world's legacy ledger. Append-only, like the fact ledger. */
  legacy: LegacyEntry[];
  /** Everything the time skip changes. */
  effects: Effect[];
  /** Threads the finished campaign left open, ready to become quests or rumours. */
  promoted: Seed[];
  years: number;
  summary: string[];
}

/** How far the world moves between campaigns. Long enough that children are adults. */
export const DEFAULT_SKIP_YEARS = 12;

/**
 * Build the plan. Pure given an Rng, so it is journaled as one action and replays exactly
 * like anything else — a time skip is not a special path.
 */
export function planSuccession(
  s: GameState,
  rng: Rng,
  opts: { campaignId: string; years?: number } = { campaignId: "" },
): SuccessionPlan {
  const years = opts.years ?? DEFAULT_SKIP_YEARS;
  const campaign = s.campaigns[opts.campaignId];
  const legacy: LegacyEntry[] = [];
  const effects: Effect[] = [];
  const summary: string[] = [];

  const stamp = {
    campaign_id: opts.campaignId,
    completed_turn: s.meta.turn,
    world_minute: s.world.world_minute,
    party_ids: [...s.meta.party_ids],
  };

  // 1. What this party did, permanently. The fact ledger is what happened; the legacy
  //    ledger is what MATTERS across generations, so only importance 4+ survives.
  for (const f of s.facts) {
    if (f.superseded_by || f.importance < 4) continue;
    legacy.push({ ...stamp, text: f.text, subject_ids: [...f.subjects] });
  }
  for (const q of Object.values(s.quests)) {
    if (q.status === "complete") legacy.push({ ...stamp, text: `${q.title} was seen through.`, subject_ids: [q.id] });
    if (q.status === "failed" || q.status === "expired") legacy.push({ ...stamp, text: `${q.title} was left undone.`, subject_ids: [q.id] });
  }
  for (const f of Object.values(s.world.factions)) {
    const standing = f.rep_with_pc >= 40 ? "counted them friends" : f.rep_with_pc <= -40 ? "counted them enemies" : "never made up its mind about them";
    legacy.push({ ...stamp, text: `${f.name} ${standing}.`, subject_ids: [f.id] });
  }

  // 2. Age the world. People die, towns grow or empty, and the reputation the party left
  //    behind is the thing factions build on.
  effects.push({ t: "advance_time", minutes: years * 365 * MINUTES_PER_DAY });

  for (const id of Object.keys(s.entities).sort()) {
    const e = s.entities[id]!;
    if (!e.alive || e.flags["is_template"] === true) continue;
    if (s.meta.party_ids.includes(id)) {
      // The party retires rather than vanishing. A retired hero is the best NPC a later
      // campaign can meet.
      effects.push({ t: "set_entity_flag", entity_id: id, key: "retired", value: true });
      effects.push({ t: "set_entity_flag", entity_id: id, key: "legend_of", value: opts.campaignId });
      summary.push(`${e.name} put down the work and became a story people tell.`);
      continue;
    }
    // Everyone else takes their chances with the years.
    const frail = (e.level <= 1 ? 0.35 : 0.2) + years / 100;
    if (rng.chance(Math.min(0.75, frail))) {
      effects.push({ t: "set_entity_flag", entity_id: id, key: "died_offscreen", value: true });
      summary.push(`${e.name} did not live to see it.`);
    }
  }

  for (const fid of Object.keys(s.world.factions).sort()) {
    const f = s.world.factions[fid]!;
    // A faction the party wrecked stays wrecked; one they never touched drifts back to
    // the middle. Consequence should outlast the people who caused it.
    const drift = f.rep_with_pc < -30 ? Math.round(Math.abs(f.rep_with_pc) * 0.3) : -Math.round(f.rep_with_pc * 0.4);
    if (drift !== 0) effects.push({ t: "faction_rep", faction_id: fid, delta: drift });
    if (f.rep_with_pc <= -40) summary.push(`${f.name} spent a generation rebuilding.`);
  }

  // 3. Promote what was left open. An unresolved thread is the best hook a next campaign
  //    can have, because the players already know it is real.
  const promoted: Seed[] = [];
  for (const arc of Object.values(s.arcs)) {
    for (const seed of arc.seeds) {
      if (seed.promoted) continue;
      promoted.push(seed);
      effects.push({
        t: "add_fact",
        text: seed.text,
        subjects: [...seed.subject_ids],
        importance: 4,
        secret: false,
        known_by: [],   // nobody knows it yet; the next party has to find it
      });
      effects.push({ t: "promote_seed", arc_id: arc.id, seed_id: seed.id });
      summary.push(`Unfinished: ${seed.text}`);
    }
  }

  // 4. Close the books.
  //
  //    These used to be done by the caller, beside the journal — and the rebuild gate
  //    caught it immediately, which is exactly what that gate is for. Everything a
  //    succession changes is an effect, so the whole generation-skip replays as one
  //    ordinary event and can be rewound like one.
  if (opts.campaignId) {
    effects.push({ t: "add_legacy", entries: legacy });
    effects.push({ t: "set_campaign_status", campaign_id: opts.campaignId, status: "complete" });
    for (const arcId of campaign?.arc_ids ?? []) {
      if (s.arcs[arcId]?.status === "active") effects.push({ t: "set_arc_status", arc_id: arcId, status: "complete" });
    }
  }

  if (campaign) summary.unshift(`${campaign.title} ended. ${years} years pass.`);
  return { legacy, effects, promoted, years, summary };
}

/**
 * Is a campaign actually finished? Its climax quest resolved, or every arc closed.
 * Deliberately strict: ending a campaign is a one-way door, so it should not happen by
 * accident because a side quest expired.
 */
export function campaignComplete(s: GameState, campaignId: string): boolean {
  const c = s.campaigns[campaignId];
  if (!c) return false;
  const arcs = c.arc_ids.map((id) => s.arcs[id]).filter((a): a is NonNullable<typeof a> => !!a);
  if (arcs.length === 0) return false;
  return arcs.every((a) => {
    if (a.status === "complete" || a.status === "abandoned") return true;
    if (!a.climax_quest_id) return false;
    const q = s.quests[a.climax_quest_id];
    return q?.status === "complete" || q?.status === "failed";
  });
}

/** Everything a later campaign can draw on. The world's memory, in one call. */
export function legacyFor(s: GameState, subjectId?: string): LegacyEntry[] {
  return s.legacy.filter((l) => !subjectId || l.subject_ids.includes(subjectId));
}
