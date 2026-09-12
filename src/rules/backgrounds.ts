import { z } from "zod";
import type { Dims } from "../schema/common.js";
import type { Entity } from "../schema/entity.js";
import type { GameState } from "../schema/state.js";

/**
 * WHERE YOU CAME FROM, AND WHY ANYONE CARES.
 *
 * Backgrounds already existed as a bundle of proficiencies and a starting purse — which is
 * all 5e strictly asks of them, and all they were doing here. But "I grew up a thief" or "I
 * was born to a great house" is not a skill list. It is the first thing anyone in the world
 * learns about you, and at a real table it changes every room you walk into: a guard reads
 * you differently, a fence reads you differently, and you have things to say that nobody
 * else at the table can say.
 *
 * Two mechanisms, and they are deliberately different in kind:
 *
 *   STANDING   What your past does TO you. People react before you have spoken, keyed off
 *              what sort of person THEY are. A noble is welcome in a hall and resented in a
 *              tenement; an outlaw is the reverse, and both are correct.
 *
 *   INSIGHT    What your past lets you DO. A line only you have standing to say, in the
 *              Baldur's Gate 3 sense of the bracketed tag: [OUTLAW] "You are working a
 *              short con, and badly." It is not a better Persuasion check. It is a door
 *              that exists for you and does not exist for anyone else.
 *
 * Both sides are authored — the background says how it reads, the NPC says what sort of
 * person they are — and code does the matching. Nothing here asks a model to decide whether
 * a scullery maid resents aristocrats.
 */

/**
 * What sort of person an NPC is, socially. A deliberately small closed vocabulary: the
 * point is that authors tag people from a list short enough to hold in your head, not that
 * every NPC gets a sociological profile.
 */
export const SocialTag = z.enum([
  "criminal",   // fences, smugglers, gangs — anyone outside the law by trade
  "lawful",     // guards, magistrates, wardens
  "commoner",   // farmers, labourers, innkeepers
  "noble",      // titled, or close enough to matter
  "clergy",     // temples and their servants
  "scholar",    // anyone who reads for a living
  "soldier",    // serving or veteran
  "wild",       // hunters, hermits, people who live outside a wall
  "merchant",
]);
export type SocialTag = z.infer<typeof SocialTag>;

/** How one sort of person reads one sort of past. */
export interface Standing {
  tag: SocialTag;
  dims: Dims;
  /** Recorded on the relationship and shown to the player. Always in their terms. */
  reason: string;
}

/**
 * A line only you can say.
 *
 * `grants_trust` is the mechanical payload, and it is deliberately modest: an insight does
 * not hand you the answer, it establishes that you are worth talking to. It moves trust,
 * which moves every DC in the conversation through the normal path (see rules/social.ts) —
 * rather than being a special-case bonus that only backgrounds get.
 */
export interface Insight {
  id: string;
  /** The NPC must be this sort of person. */
  when_tag: SocialTag;
  /** What the player sees, minus the tag: "speak the cant". */
  label: string;
  /** Handed to the narrator so the line is in the player's voice, not this file's. */
  intent: string;
  grants_trust: number;
  /** Some doors open the wrong way. Pulling rank works, and it costs you. */
  costs_affinity: number;
}

export interface BackgroundSocial {
  id: string;
  /** How the player would describe it, plainly. Shown at character creation. */
  blurb: string;
  standing: Standing[];
  insights: Insight[];
}

const d = (dims: Partial<Dims>): Dims => dims as Dims;

/**
 * The table. Every entry is a claim about how the world works, and every one of them should
 * be arguable — if a row reads as obviously correct to everyone, it is probably too bland
 * to be worth the lookup.
 */
export const BACKGROUND_SOCIAL: Record<string, BackgroundSocial> = {
  bg_criminal: {
    id: "bg_criminal",
    blurb: "You grew up light-fingered. You know which doors are watched and who to pay.",
    standing: [
      { tag: "criminal", dims: d({ trust: 12, respect: 8 }), reason: "they can tell you have done time in the same trade" },
      { tag: "lawful", dims: d({ trust: -12, affinity: -8 }), reason: "you carry yourself like someone with something to hide" },
      { tag: "merchant", dims: d({ trust: -6, fear: 6 }), reason: "they are counting their stock while you talk" },
      { tag: "noble", dims: d({ affinity: -10 }), reason: "your manners give you away" },
    ],
    insights: [
      {
        id: "ins_cant", when_tag: "criminal", label: "speak the cant",
        intent: "Use the trade's own idiom to establish you are one of them, without saying so outright.",
        grants_trust: 14, costs_affinity: 0,
      },
      {
        id: "ins_read_watch", when_tag: "lawful", label: "read how they keep watch",
        intent: "You have spent years avoiding people like this. Name their routine back to them — respectfully.",
        grants_trust: 6, costs_affinity: 0,
      },
    ],
  },

  bg_noble: {
    id: "bg_noble",
    blurb: "You were born to a great house. Doors open, and so do resentments.",
    standing: [
      { tag: "noble", dims: d({ trust: 10, respect: 12 }), reason: "they place your family before you finish your name" },
      { tag: "commoner", dims: d({ affinity: -8, fear: 8, respect: 6 }), reason: "they are being careful around you, and it shows" },
      { tag: "lawful", dims: d({ trust: 10, respect: 8 }), reason: "your name is worth something to the people who keep order" },
      { tag: "criminal", dims: d({ affinity: -14, trust: -10 }), reason: "you are what they have spent a life stealing from" },
      { tag: "clergy", dims: d({ respect: 6 }), reason: "your house has always endowed someone" },
    ],
    insights: [
      {
        id: "ins_kinship", when_tag: "noble", label: "claim the connection",
        intent: "Find the cousin, the alliance or the debt that links your houses, and name it.",
        grants_trust: 14, costs_affinity: 0,
      },
      {
        id: "ins_pull_rank", when_tag: "commoner", label: "pull rank",
        intent: "Make it clear, without threatening anything, that refusing you would be expensive.",
        grants_trust: 10, costs_affinity: -12,
      },
    ],
  },

  bg_outlander: {
    id: "bg_outlander",
    blurb: "You lived outside the walls. Towns are the strange country, not the wild.",
    standing: [
      { tag: "wild", dims: d({ trust: 14, respect: 10 }), reason: "you carry yourself like someone who has slept outside on purpose" },
      { tag: "commoner", dims: d({ trust: 5 }), reason: "you look like hard weather and honest work" },
      { tag: "noble", dims: d({ affinity: -10, respect: -6 }), reason: "you are mud on a clean floor to them" },
      { tag: "merchant", dims: d({ trust: -5 }), reason: "they do not expect you to have coin" },
    ],
    insights: [
      {
        id: "ins_read_land", when_tag: "wild", label: "talk about the country",
        intent: "Name the season, the game, the state of the passes. Show you have actually been out there.",
        grants_trust: 14, costs_affinity: 0,
      },
      {
        id: "ins_weather_warning", when_tag: "commoner", label: "read the weather for them",
        intent: "Tell them plainly what the sky is going to do to their week. Be right.",
        grants_trust: 9, costs_affinity: 0,
      },
    ],
  },

  bg_acolyte: {
    id: "bg_acolyte",
    blurb: "You were raised in a temple. The words come without thinking.",
    standing: [
      { tag: "clergy", dims: d({ trust: 16, affinity: 8 }), reason: "you answered the greeting correctly without being asked" },
      { tag: "commoner", dims: d({ trust: 8, respect: 5 }), reason: "people trust a temple face" },
      { tag: "criminal", dims: d({ trust: -8 }), reason: "they assume you will talk to somebody about them" },
    ],
    insights: [
      {
        id: "ins_liturgy", when_tag: "clergy", label: "share the liturgy",
        intent: "Fall into the call and response. It settles them more than any argument would.",
        grants_trust: 15, costs_affinity: 0,
      },
      {
        id: "ins_comfort", when_tag: "commoner", label: "offer the words for it",
        intent: "Give them the blessing people say at a time like this. Do not make it about you.",
        grants_trust: 10, costs_affinity: 0,
      },
    ],
  },

  bg_sage: {
    id: "bg_sage",
    blurb: "You read for a living. Most rooms find that useless, and a few find it priceless.",
    standing: [
      { tag: "scholar", dims: d({ trust: 12, respect: 12 }), reason: "you are visibly one of them" },
      { tag: "clergy", dims: d({ respect: 6 }), reason: "they keep books too" },
      { tag: "soldier", dims: d({ respect: -6 }), reason: "they have met your sort and were not impressed" },
      { tag: "commoner", dims: d({ trust: -4, respect: 5 }), reason: "you talk like the people who write the tax notices" },
    ],
    insights: [
      {
        id: "ins_citation", when_tag: "scholar", label: "trade citations",
        intent: "Show you have read the same difficult thing they have, and disagree with it intelligently.",
        grants_trust: 14, costs_affinity: 0,
      },
    ],
  },

  bg_soldier: {
    id: "bg_soldier",
    blurb: "You served. You know what an order costs the person who has to carry it.",
    standing: [
      { tag: "soldier", dims: d({ trust: 14, respect: 12 }), reason: "they clock your bearing before you speak" },
      { tag: "lawful", dims: d({ trust: 8, respect: 6 }), reason: "you are the kind of trouble they understand" },
      { tag: "commoner", dims: d({ fear: 6, respect: 4 }), reason: "armed men have not always been good news here" },
      { tag: "criminal", dims: d({ trust: -8, fear: 5 }), reason: "you stand like someone who has held a line" },
    ],
    insights: [
      {
        id: "ins_campaigns", when_tag: "soldier", label: "compare campaigns",
        intent: "Find the year and the place you both know. Let the shared misery do the work.",
        grants_trust: 14, costs_affinity: 0,
      },
    ],
  },

  bg_folk_hero: {
    id: "bg_folk_hero",
    blurb: "You did something for ordinary people once, and they have not forgotten it.",
    standing: [
      { tag: "commoner", dims: d({ affinity: 14, trust: 10 }), reason: "somebody here has told your story secondhand" },
      { tag: "noble", dims: d({ affinity: -8, fear: 5 }), reason: "a popular commoner is a problem waiting to happen" },
      { tag: "lawful", dims: d({ trust: 5, respect: 5 }), reason: "you have a reputation for standing in the right place" },
    ],
    insights: [
      {
        id: "ins_known_here", when_tag: "commoner", label: "let them place you",
        intent: "Do not boast. Let them work out who you are, and then let them decide to help.",
        grants_trust: 12, costs_affinity: 0,
      },
    ],
  },

  bg_urchin: {
    id: "bg_urchin",
    blurb: "You raised yourself in the gutters of a city. You know every way in and out.",
    standing: [
      { tag: "criminal", dims: d({ trust: 8 }), reason: "they know the look of a child who fed themselves" },
      { tag: "commoner", dims: d({ affinity: 5 }), reason: "you are recognisably one of theirs" },
      { tag: "noble", dims: d({ affinity: -12, trust: -10 }), reason: "they have already decided what you are" },
      { tag: "merchant", dims: d({ trust: -8 }), reason: "their hand goes to their purse when you approach" },
    ],
    insights: [
      {
        id: "ins_back_ways", when_tag: "commoner", label: "mention the back ways",
        intent: "Name the alley, the gap in the wall, the roof route. Only someone who lived it would know.",
        grants_trust: 10, costs_affinity: 0,
      },
    ],
  },
};

/** The background id on a character, or null. Stored in flags at creation. */
export function backgroundOf(e: Entity): string | null {
  const id = e.flags["background_id"];
  return typeof id === "string" ? id : null;
}

/**
 * How this person reads the player, before a word is spoken.
 *
 * Returns nothing when the NPC has no social tags — untagged people are simply neutral,
 * which keeps backgrounds opt-in for an author rather than something every NPC must answer
 * for. Tag the people whose reaction is interesting and leave the rest alone.
 */
export function standingToward(s: GameState, npc: Entity): Standing[] {
  const player = s.entities[s.meta.pc_id];
  if (!player) return [];
  const bg = backgroundOf(player);
  if (!bg) return [];

  const profile = BACKGROUND_SOCIAL[bg];
  if (!profile) return [];

  const tags = socialTagsOf(npc);
  return profile.standing.filter((st) => tags.includes(st.tag));
}

/** Social tags authored on an NPC. Read through a helper so untagged content still works. */
export function socialTagsOf(e: Entity): SocialTag[] {
  const raw = e.flags["social_tags"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is SocialTag => SocialTag.safeParse(t).success);
}

/**
 * Lines only this character has standing to say, to this person, right now.
 *
 * Used once per NPC: the point of recognising a fellow traveller is the moment of
 * recognition, and an insight you can spam is a button, not a beat.
 */
export function insightsFor(s: GameState, npc: Entity): Insight[] {
  const player = s.entities[s.meta.pc_id];
  if (!player) return [];
  const bg = backgroundOf(player);
  if (!bg) return [];

  const profile = BACKGROUND_SOCIAL[bg];
  if (!profile) return [];

  const tags = socialTagsOf(npc);
  const rel = s.relationships[`${npc.id}->${s.meta.pc_id}`];
  const spent = new Set(rel?.tags ?? []);

  return profile.insights.filter(
    (i) => tags.includes(i.when_tag) && !spent.has(`insight:${i.id}`),
  );
}

/** The label the client shows, in the bracketed style the genre already taught everyone. */
export function insightLabel(backgroundName: string, i: Insight): string {
  return `[${backgroundName.toUpperCase()}] ${i.label}`;
}
