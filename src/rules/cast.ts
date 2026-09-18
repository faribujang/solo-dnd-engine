import type { GameState } from "../schema/state.js";

/**
 * HOW MANY PEOPLE A STORY CAN HOLD.
 *
 * The expensive thing about a cast is not the people, it is the EDGES. An entity is a few
 * hundred bytes and a database will hold a million of them without noticing. A relationship
 * graph is N², and both the prompt and the player's memory are the things that run out —
 * not the disk. Fifteen principals is 225 possible opinions, which is a story. Two hundred
 * and fifty principals is sixty-two thousand, which is a spreadsheet nobody can read and a
 * world where every name is equally weightless.
 *
 * So the budget is not "how many people exist" but "who is allowed to have edges":
 *
 *   principal  the story is ABOUT them. Opinions about EACH OTHER, schedules, goals,
 *              sealed topics, a real stat block. Companions, the villains, the legends.
 *   standing   one relationship row with the lead, a descriptor, some facts they know.
 *              No cross-edges. The named cast of a place you keep coming back to.
 *   local      a name, a role, a line. They exist so the world has names in it and so the
 *              same innkeeper is the same innkeeper next week. The narrator may mint these.
 *
 * Extras are not in this table at all: "the tollgate clerk" is never persisted, and that
 * is correct. A person becomes a local the moment the story needs them to be the SAME
 * person twice.
 */

export type CastTier = "principal" | "standing" | "local";

/**
 * The caps.
 *
 * Not set by what fits on disk — a save with all 385 of these in it is about five
 * megabytes, and nothing anywhere cares. They are set by what a PLAYER can hold: roughly
 * a third of a named cast can carry plot before every passer-by starts feeling
 * load-bearing, and a principal tier past about forty stops being a story and starts
 * being a staff directory.
 *
 * A campaign may raise them (`meta.cast_budget`). An arc that introduces a court, a
 * crew or an army should be able to say so rather than being refused by a number some
 * other campaign needed.
 */
export const CAST_BUDGET: Record<CastTier, number> = {
  principal: 35,
  standing: 100,
  local: 250,
};

export const CAST_TOTAL = CAST_BUDGET.principal + CAST_BUDGET.standing + CAST_BUDGET.local;

/** This world's caps: the defaults, unless the campaign raised them. */
export function budgetOf(s: GameState): Record<CastTier, number> {
  return { ...CAST_BUDGET, ...s.meta.cast_budget };
}

export function tierOf(s: GameState, entityId: string): CastTier | null {
  const e = s.entities[entityId];
  if (!e) return null;
  return e.tier;
}

/** How many of each tier are alive in this world right now. */
export function censusOf(s: GameState): Record<CastTier, number> {
  const out: Record<CastTier, number> = { principal: 0, standing: 0, local: 0 };
  for (const e of Object.values(s.entities)) {
    // Monsters are not cast. A room of six raiders is one encounter, not six relationships.
    if (e.kind === "monster") continue;
    out[e.tier] += 1;
  }
  return out;
}

/**
 * Whether one more person of this tier can exist, and why not when they cannot.
 *
 * Refusing is deliberate, and so is refusing rather than EVICTING. Eviction would have to
 * pick a victim, and any rule for picking one ("least recently seen") is a rule that can
 * delete somebody the player remembers — which is the exact failure this budget exists to
 * prevent. A refusal is also trivially deterministic, which a replay needs.
 */
export function canAdmit(s: GameState, tier: CastTier): { ok: true } | { ok: false; reason: string } {
  const have = censusOf(s)[tier];
  const cap = budgetOf(s)[tier];
  if (have < cap) return { ok: true };
  return {
    ok: false,
    reason: `this world already holds ${have} ${tier} characters, which is the cap`,
  };
}
