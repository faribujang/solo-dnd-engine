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
 *   extra      a face. The tollgate clerk, the cutters on the post, the woman in the
 *              doorway. Minted freely by the narrator, no relationship row, no cross-
 *              edges, and NOT counted against any design cap — because a DM that has to
 *              ask permission before putting a clerk behind a counter will simply stop
 *              putting clerks behind counters, and the world goes empty.
 *
 * Extras used to be "never persisted", which sounded right and played badly: the player
 * could see the tollgate clerk and could not speak to them, because speaking requires
 * somebody the engine knows about. So extras are real now, and the budget moved from
 * "who may exist" to "who may have EDGES":
 *
 *   · an extra is PROMOTED to local the instant one forms — the player's opinion of them
 *     shifts, a fact names them, a thread involves them, they join the party. Mattering is
 *     what costs budget, and mattering is something the player does, not the narrator.
 *   · an edgeless extra RETIRES once the scene has moved on. Nobody the player has
 *     touched can ever be retired, because touching them promoted them first.
 *
 * That is what keeps the cast unbounded in feel and bounded in the only place it hurts.
 */

export type CastTier = "principal" | "standing" | "local" | "extra";

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
  /**
   * Not a design cap. A runaway guard, three times the rest of the cast, so a looping bug
   * cannot mint forty thousand people into a save while nobody is watching. Reaching it
   * legitimately is not a thing a story does; reaching it means something is broken.
   */
  extra: 1000,
};

/** What the player is asked to hold in their head. Extras are deliberately not in it. */
export const CAST_TOTAL = CAST_BUDGET.principal + CAST_BUDGET.standing + CAST_BUDGET.local;

/**
 * How long an extra nobody has touched stays in the world before the scene forgets them.
 *
 * Two days. Long enough that walking out of a room and back in finds the same clerk;
 * short enough that a week of play does not leave nine hundred nameless faces standing
 * in rooms the player has left.
 */
export const EXTRA_FADE_MINUTES = 60 * 24 * 2;

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
  const out: Record<CastTier, number> = { principal: 0, standing: 0, local: 0, extra: 0 };
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

/**
 * Has anybody touched this person?
 *
 * An edge is the whole test for whether somebody is worth keeping: a relationship in
 * either direction, a fact that names them, a thread that involves them, a place in the
 * party. It is deliberately the same question the promotion rule asks, so an extra who
 * survives retirement and an extra who earns a budget slot are never two different sets.
 */
export function hasEdges(s: GameState, id: string): boolean {
  if (s.meta.party_ids.includes(id)) return true;
  for (const key of Object.keys(s.relationships)) {
    const [a, b] = key.split("->");
    if (a === id || b === id) return true;
  }
  if (s.facts.some((f) => f.subjects.includes(id) || f.known_by.includes(id))) return true;
  if (Object.values(s.threads).some((t) => t.subject_ids.includes(id) || t.from_entity_id === id)) return true;
  return false;
}
