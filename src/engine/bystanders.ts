import type { GameState } from "../schema/state.js";
import type { Entity } from "../schema/entity.js";
import { dispositionOf } from "../rules/social.js";
import { factsKnownTo, factsKnownToPc, npcsPresent } from "../state/selectors.js";

/**
 * THE REST OF THE ROOM.
 *
 * Conversation is one-to-one — that is what both a tabletop and Baldur's Gate 3 actually
 * do, and for the same reason: a scene with five people all answering at once is unreadable
 * in prose and unplayable on a phone. What neither of them does is let the other four stand
 * there like furniture. They *interject*.
 *
 * So the model here is: one speaker, everyone else can put their oar in. An interjection is
 * never mechanical — it changes no state and rolls no dice. It is a NARRATION CUE, computed
 * from what someone present knows and feels, handed to the DM as "this person would speak
 * up here, and here is why". The DM writes the line; code decides who has standing to say
 * something and what it is about.
 *
 * The three things this file exists to prevent:
 *
 *   1. A room full of named NPCs who never react to what is said in front of them.
 *   2. A "crowd" implemented as fifteen individual entities each with a relationship edge.
 *   3. Lying to someone in a packed common room being exactly as safe as lying in an alley.
 */

/** Why this person would speak up. Ranked in this order when trimming. */
export type InterjectionCause =
  | "knows_better"      // they know a fact bearing on what was just said
  | "implicated"        // they, or their faction, are the subject
  | "strong_feeling"    // they love or hate the player enough to weigh in
  | "protective";       // they are close to whoever is being pressed

export interface Interjection {
  entity_id: string;
  name: string;
  cause: InterjectionCause;
  /** Handed to the narrator. Never shown raw to the player. */
  why: string;
  /** Higher speaks first. Only the top few are offered, so a room does not chorus. */
  weight: number;
}

/** Nobody wants five people talking. Two is a scene; five is a mess. */
export const MAX_INTERJECTIONS = 2;

const CAUSE_WEIGHT: Record<InterjectionCause, number> = {
  implicated: 40,
  knows_better: 30,
  protective: 20,
  strong_feeling: 10,
};

/**
 * Who in the room would speak up, and why.
 *
 * `subjects` is what the exchange was ABOUT — entity and faction ids from the topic that
 * was raised. Everything keys off that, so an interjection is always relevant rather than
 * ambient chatter.
 */
export function interjectionsFor(
  s: GameState,
  speakerId: string,
  subjects: readonly string[],
): Interjection[] {
  const pcId = s.meta.pc_id;
  const player = s.entities[pcId];
  if (!player) return [];

  const subjectSet = new Set(subjects);
  const out: Interjection[] = [];
  const mine = new Set(factsKnownToPc(s).map((f) => f.id));

  for (const e of npcsPresent(s, player.location_id)) {
    if (e.id === speakerId || !e.alive) continue;
    if (e.flags["is_template"] === true) continue;

    const rel = s.relationships[`${e.id}->${pcId}`];
    const affinity = rel?.dims.affinity ?? 0;

    // 1. They are the subject, or their faction is. Hard to stay quiet.
    if (subjectSet.has(e.id) || e.faction_ids.some((f) => subjectSet.has(f))) {
      out.push({
        entity_id: e.id, name: e.name, cause: "implicated",
        why: `${e.name} is part of what is being discussed and can hear it.`,
        weight: CAUSE_WEIGHT.implicated,
      });
      continue;
    }

    // 2. They know something bearing on it that the player does not. This is the one that
    //    makes a room feel alive: the stranger at the next table who knows better.
    const theirs = factsKnownTo(s, e.id).filter(
      (f) => !f.superseded_by && !mine.has(f.id) && f.subjects.some((sub) => subjectSet.has(sub)),
    );
    const bearing = theirs.find((f) => !f.secret) ?? theirs[0];
    if (bearing) {
      out.push({
        entity_id: e.id, name: e.name, cause: "knows_better",
        why: `${e.name} knows something about this${bearing.secret ? " and would rather not say it" : ""}: ${bearing.text}`,
        weight: CAUSE_WEIGHT.knows_better + bearing.importance,
      });
      continue;
    }

    // 3. They are close to the person being pressed, and do not care for it.
    const towardSpeaker = s.relationships[`${e.id}->${speakerId}`];
    if (towardSpeaker && towardSpeaker.dims.affinity > 40) {
      out.push({
        entity_id: e.id, name: e.name, cause: "protective",
        why: `${e.name} is fond of ${s.entities[speakerId]?.name ?? "them"} and does not like where this is going.`,
        weight: CAUSE_WEIGHT.protective,
      });
      continue;
    }

    // 4. They simply have strong views about you.
    if (Math.abs(affinity) >= 50) {
      const d = dispositionOf(affinity);
      out.push({
        entity_id: e.id, name: e.name, cause: "strong_feeling",
        why: `${e.name} is ${d} toward you and is listening.`,
        weight: CAUSE_WEIGHT.strong_feeling + Math.floor(Math.abs(affinity) / 10),
      });
    }
  }

  return out
    .sort((a, b) => b.weight - a.weight || a.entity_id.localeCompare(b.entity_id))
    .slice(0, MAX_INTERJECTIONS);
}

/**
 * A CROWD, treated as one thing.
 *
 * The wrong way to build a busy tavern is fifteen entities with fifteen relationship edges.
 * The right way is what a DM does: name two or three people who matter and treat everyone
 * else as a single body with a single mood. The crowd is not an entity — it has no HP, no
 * inventory and no opinions of its own. It is a reading of the room, derived on demand.
 */
export interface Crowd {
  size: number;
  /** The room's collective feeling, on the same scale as an individual's affinity. */
  mood: number;
  /** How that reads: "wary of you", "on your side". */
  label: string;
  /** Named people in the room. Everyone else is the crowd. */
  notable_ids: string[];
}

/** Fewer than this and they are just people standing there. */
export const CROWD_MIN = 3;

export function crowdAt(s: GameState, locationId: string): Crowd | null {
  const present = npcsPresent(s, locationId).filter(
    (e) => e.alive && e.flags["is_template"] !== true,
  );
  if (present.length < CROWD_MIN) return null;

  const pcId = s.meta.pc_id;
  // The room's mood is what the people in it feel, plus how the town feels generally —
  // a stranger in a hostile town reads the room as hostile before anyone has spoken.
  const settlement = Object.values(s.settlements).find((st) => st.location_ids.includes(locationId));
  const townRep = settlement?.reputation_with_pc ?? 0;

  let sum = 0;
  for (const e of present) sum += s.relationships[`${e.id}->${pcId}`]?.dims.affinity ?? 0;
  const mood = Math.round((sum / present.length) * 0.6 + townRep * 0.4);

  return {
    size: present.length,
    mood,
    label: crowdLabel(mood),
    notable_ids: present
      .filter((e) => e.goals.length > 0 || e.faction_ids.length > 0)
      .map((e) => e.id)
      .sort(),
  };
}

function crowdLabel(mood: number): string {
  if (mood <= -50) return "openly hostile";
  if (mood <= -20) return "against you";
  if (mood < 20) return "paying you no particular mind";
  if (mood < 50) return "warm enough";
  return "on your side";
}

/**
 * WHO IS WATCHING, and what that costs you.
 *
 * Doing something in public is not the same as doing it in private, and this is the cheapest
 * way to make that true. Threatening a man in front of his neighbours is harder, because now
 * he cannot be seen to fold. Lying to a room is harder than lying to a person, because it
 * only takes one of them to know better.
 *
 * Returned as a DC delta with a reason, so it lands on the roll card in the player's own
 * terms rather than as an invisible thumb on the scale.
 */
export function audiencePressure(
  s: GameState,
  approach: "persuasion" | "deception" | "intimidation",
): { dc_delta: number; reason: string } | null {
  const player = s.entities[s.meta.pc_id];
  if (!player) return null;
  const watching = npcsPresent(s, player.location_id).filter(
    (e) => e.alive && e.flags["is_template"] !== true,
  );
  // One other person in the room is a conversation, not an audience.
  if (watching.length < 2) return null;

  const crowded = watching.length >= CROWD_MIN;
  switch (approach) {
    case "intimidation":
      // The strongest effect, and the most intuitive: nobody backs down in front of friends.
      return { dc_delta: crowded ? 4 : 2, reason: "he cannot be seen to fold in front of them" };
    case "deception":
      // Every extra ear is another chance someone knows better.
      return { dc_delta: crowded ? 3 : 2, reason: "too many ears for a clean lie" };
    case "persuasion":
      // Mild, and it cuts the other way when the room already likes you.
      return crowded ? { dc_delta: 1, reason: "the room is listening" } : null;
  }
}
