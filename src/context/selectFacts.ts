import type { Fact } from "../schema/fact.js";
import type { GameState } from "../schema/state.js";
import { estimateTokens } from "../llm/client.js";

/**
 * Fact retrieval — the thing that replaces a rolling summary.
 *
 * A summary compresses everything and so degrades everything. This compresses nothing; it
 * simply declines to show facts that are not relevant right now. Walk back into the inn at
 * turn 400 and every fact ever recorded about that innkeeper comes back verbatim, exactly
 * as it read at turn 4.
 *
 * No embeddings. At a few thousand facts, tag filtering is exact, instant and free. Add
 * vector search only if a save passes ~20k facts — behind this same signature.
 */

export interface FactQuery {
  /** Entities in the room right now. The strongest relevance signal by a wide margin. */
  presentEntityIds: readonly string[];
  currentLocationId: string | null;
  activeQuestIds: readonly string[];
  /** Whose knowledge to filter by. Defaults to the PC. */
  knowerId?: string;
  budgetTokens: number;
  currentTurn: number;
}

export interface ScoredFact {
  fact: Fact;
  score: number;
  /** Why it was selected, for the debugging view. Never sent to the model. */
  because: string[];
}

const RECENCY_WINDOW = 50;

export function scoreFacts(s: GameState, q: FactQuery): ScoredFact[] {
  const knower = q.knowerId ?? s.meta.pc_id;
  const present = new Set(q.presentEntityIds);
  const quests = new Set(q.activeQuestIds);

  const out: ScoredFact[] = [];

  for (const fact of s.facts) {
    if (fact.superseded_by) continue;
    // What is not in their head is not in the prompt. `known_by` is the whole test —
    // an unlearned fact is unlearned whether or not anyone called it a secret.
    if (!fact.known_by.includes(knower)) continue;

    const because: string[] = [];
    let score = 0;

    const overlap = fact.subjects.filter((x) => present.has(x)).length;
    if (overlap > 0) {
      score += 3 * overlap;
      because.push(`about someone present (${overlap})`);
    }

    if (q.currentLocationId && fact.location_id === q.currentLocationId) {
      score += 2;
      because.push("happened here");
    }

    const questOverlap = fact.quest_ids.filter((x) => quests.has(x)).length;
    if (questOverlap > 0) {
      score += 2 * questOverlap;
      because.push("touches an active quest");
    }

    score += fact.importance;

    const age = q.currentTurn - fact.turn;
    if (age < RECENCY_WINDOW) {
      const recency = (1 - age / RECENCY_WINDOW) * 2;
      score += recency;
      if (age <= 3) because.push("just happened");
    }

    // Importance 5 is the author or the engine saying "this must never be forgotten".
    if (fact.importance === 5) {
      score += 1000;
      because.push("always included");
    }

    out.push({ fact, score, because });
  }

  // Ties break by turn then id so selection is stable across runs — a prompt that shuffles
  // between identical states would make caching and debugging both worse.
  out.sort((a, b) =>
    b.score - a.score ||
    b.fact.turn - a.fact.turn ||
    a.fact.id.localeCompare(b.fact.id));

  return out;
}

/** Take the highest-scoring facts that fit the budget. */
export function selectFacts(s: GameState, q: FactQuery): ScoredFact[] {
  const scored = scoreFacts(s, q);
  const chosen: ScoredFact[] = [];
  let used = 0;

  for (const sf of scored) {
    const cost = estimateTokens(sf.fact.text) + 4;
    if (used + cost > q.budgetTokens && sf.fact.importance !== 5) continue;
    chosen.push(sf);
    used += cost;
  }

  // Read oldest-first so the CANON block tells the story in the order it happened.
  return chosen.sort((a, b) => a.fact.turn - b.fact.turn || a.fact.id.localeCompare(b.fact.id));
}

/**
 * What a specific NPC knows about a subject. Used to build the per-NPC block, so the DM
 * voicing the guard cannot have them mention a murder they never witnessed.
 */
export function factsKnownBy(s: GameState, entityId: string, aboutIds: readonly string[]): Fact[] {
  const about = new Set(aboutIds);
  return s.facts.filter(
    (f) =>
      !f.superseded_by &&
      f.known_by.includes(entityId) &&
      f.subjects.some((x) => about.has(x)),
  );
}
