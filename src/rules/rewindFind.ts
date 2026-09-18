import type { GameState } from "../schema/state.js";
import type { GameEvent } from "../schema/event.js";
import { timeline } from "../engine/rollback.js";

/**
 * "TAKE ME BACK TO BEFORE I ATTACKED JORY."
 *
 * Rewinding already worked — the journal is the save, so replaying to turn six costs the
 * same as replaying to turn six hundred and nothing extra is stored. What was missing was
 * a way to ASK, in the words a player actually uses, which are never "turn 6".
 *
 * This is lexical matching over the log, not a model call, and that is a deliberate
 * choice rather than a shortcut. Rewinding is the one destructive thing in the whole game:
 * it sets turns aside. A matcher that occasionally hallucinates a plausible-looking turn
 * number would be exactly wrong here, and "it picked the wrong turn but very fluently" is
 * not a failure mode worth buying. This one is deterministic, free, instant, and — because
 * it returns RANKED CANDIDATES rather than an answer — it hands the final say to the
 * person whose game it is.
 */

export interface RewindCandidate {
  /** Rewinding to this turn means everything after it is set aside. */
  turn: number;
  /** What happened ON that turn, in names rather than ids. */
  summary: string;
  /** How many turns would be set aside. */
  drops: number;
  score: number;
}

/** Words that mean "the turn before this one", because that is usually what is meant. */
const BEFORE = /\b(before|prior to|undo|back to just before|up to)\b/i;

/** Rough synonyms for what an event type feels like from the outside. */
const TYPE_WORDS: Record<string, string[]> = {
  attack: ["attack", "attacked", "hit", "stab", "stabbed", "kill", "killed", "fight", "fought", "swung"],
  dialogue: ["talk", "talked", "spoke", "speak", "said", "asked", "conversation", "told"],
  move: ["move", "moved", "went", "go", "walked", "travel", "travelled", "left", "entered"],
  skill_check: ["check", "rolled", "tried", "search", "searched", "persuade", "sneak", "listened"],
  rest: ["rest", "rested", "slept", "camp", "camped"],
  item_transfer: ["took", "picked", "grabbed", "stole"],
  combat_start: ["fight", "combat", "brawl"],
  combat_end: ["fight", "combat"],
  death: ["died", "death", "killed"],
};

/**
 * Turns that match what the player described, best first.
 *
 * Returns several on purpose. "Before I talked to Cotter" is genuinely ambiguous when you
 * talked to Cotter four times, and guessing which one is worse than showing four.
 */
export function findRewindTargets(
  s: GameState,
  journal: readonly GameEvent[],
  text: string,
  limit = 5,
): RewindCandidate[] {
  const nameOf = (id: string) =>
    s.entities[id]?.name ?? s.locations[id]?.name ?? s.quests[id]?.title ?? id;

  const rows = timeline(journal, nameOf);
  if (rows.length === 0) return [];

  const latest = Math.max(...rows.map((r) => r.turn));
  const wantsBefore = BEFORE.test(text);
  const words = tokens(text);

  const scored = rows.map((r) => {
    const hay = tokens(`${r.summary} ${r.type}`);
    const hayStems = new Set([...hay].map(stem));
    let score = 0;
    for (const w of words) {
      if (hay.has(w)) score += 3;
      else if (hayStems.has(stem(w))) score += 2;
    }
    const synStems = new Set((TYPE_WORDS[r.type] ?? []).map(stem));
    for (const w of words) if (synStems.has(stem(w))) score += 2;

    // "the last time I..." and "before I..." both mean the most RECENT match, so later
    // turns win ties. A player rewinding is almost always undoing something they just did.
    score += r.turn / (latest + 1);

    // Rewinding TO the turn where the thing happened keeps it. Almost nobody means that.
    const turn = wantsBefore ? Math.max(0, r.turn - 1) : r.turn;
    return { turn, summary: r.summary, drops: latest - turn, score };
  });

  return scored
    .filter((c) => c.score >= 3 && c.drops > 0)
    .sort((a, b) => b.score - a.score || b.turn - a.turn)
    .filter((c, i, all) => all.findIndex((x) => x.turn === c.turn) === i)
    .slice(0, limit);
}

/**
 * Enough of a word to recognise it again. "attacked", "attacking" and "attacks" are one
 * request, and a synonym list is a thing somebody has to remember to extend — nobody does.
 */
function stem(word: string): string {
  return word.replace(/(ing|ed|es|s)$/, "").slice(0, 5);
}

function tokens(text: string): Set<string> {
  const stop = new Set([
    "the", "a", "an", "to", "back", "roll", "rollback", "rewind", "undo", "go", "take",
    "me", "i", "my", "we", "our", "us", "it", "that", "this", "and", "of", "was", "were",
    "just", "please", "can", "you", "want", "where", "when", "point", "turn", "before",
  ]);
  return new Set(
    text.toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((w) => w.length > 1 && !stop.has(w)),
  );
}

/**
 * Whether what the player typed is a request to rewind at all.
 *
 * Deliberately narrow. "Go back to the forge" is WALKING, and catching it here would offer
 * to delete somebody's afternoon because they wanted to visit the smith. A false positive
 * on the one destructive action in the game is far worse than making them open the Log.
 * So: only phrasings that cannot mean movement, plus "go back to" when what follows is a
 * time rather than a place.
 */
export function looksLikeRewind(text: string): boolean {
  if (/\b(rewind|roll ?back|undo|take me back|revert)\b/i.test(text)) return true;
  return /\bgo back to (before|just before|the (moment|point|turn)|when)\b/i.test(text);
}
