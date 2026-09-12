import { z } from "zod";
import type { GameState } from "../schema/state.js";
import type { Entity } from "../schema/entity.js";
import { Id } from "../schema/common.js";
import type { Degree } from "../schema/common.js";
import { skillModifier } from "../rules/checks.js";
import { dispositionOf, offersUnpromptedAid, SECRET_TRUST, trustDcShift, trustLabel, willComplyFromFear, willShareSecrets } from "../rules/social.js";
import type { Fact } from "../schema/fact.js";
import { factsKnownTo, factsKnownToPc } from "../state/selectors.js";
import { BACKGROUND_SOCIAL, backgroundOf, insightLabel, insightsFor } from "../rules/backgrounds.js";

/**
 * CONVERSATION — the largest missing system, and the one a D&D game most needs.
 *
 * Until now `talk` was a single action that set a flag. But talking to someone is not an
 * action, it is a *state you are in*: topics open and close, they remember what you already
 * asked, they want something from you too, and they can end it if you push them.
 *
 * The design follows the same division as everywhere else. Topics are **derived from state**
 * rather than authored one by one — what you know that mentions them, what leads point at
 * them, what they know that you do not — so an author writes facts and the conversation
 * assembles itself. What each NPC will actually *say* is the narrator's, in their voice.
 *
 * On what trust does — and this was got WRONG the first time. The first version had trust
 * closing topics outright: below a threshold, no roll was offered at all. That protects the
 * fiction and ruins the game, because at a real table a d20 is always on the table. You can
 * always TRY. The DM's job is to tell you what trying costs and what it might get you.
 *
 * So trust is a DC, mostly. Three levels of access:
 *
 *   OPEN     they will just tell you. Friends do not make you roll.
 *   GUARDED  a check, at a DC their trust moved — visibly, by name, on the roll card.
 *   SEALED   no total buys it. But a seal must NAME ITS KEY (schema/fact.ts), and pressing
 *            one is never wasted: a critical gets you the key rather than the secret.
 *
 * That last rule is what keeps the die alive. Rolling a 20 at a sealed door does not open
 * it, but it does tell you where the door's key is — which is a better outcome than most
 * successes, and it is the shape a good DM improvises anyway.
 */

export const TopicKind = z.enum([
  "person",     // someone you both know
  "place",      // somewhere on the map
  "quest",      // a job in play
  "fact",       // something you learned
  "self",       // them: their work, their family, why they are here
  "rumour",     // what has been going around
  "insight",    // a line only your background gives you standing to say
]);
export type TopicKind = z.infer<typeof TopicKind>;

export const Conversation = z.object({
  with_id: Id,
  started_turn: z.number().int().nonnegative(),
  /** Topic ids already raised, so they can say "you asked me that". */
  raised: z.array(z.string()).default([]),
  /** What THEY want out of this. Shown to the narrator, never to the player. */
  their_agenda: z.string().default(""),
  /** Rises as you press; past a point they walk away. */
  friction: z.number().int().min(0).max(10).default(0),
});
export type Conversation = z.infer<typeof Conversation>;

/**
 * How hard this is to get out of them.
 *
 * `guarded` carries the DC and the reason it is what it is, so the client can show the
 * arithmetic before the player commits — the same contract as every other check.
 * `sealed` carries the key, because a seal without one is just a wall.
 */
export type TopicAccess =
  | { kind: "open" }
  | { kind: "guarded"; dc: number; why: string; skill: "persuasion" | "intimidation" | "deception" }
  | { kind: "sealed"; why: string; opens_when: string };

export interface Topic {
  id: string;
  kind: TopicKind;
  /** What the player would say: "ask about the missing caravan". */
  label: string;
  subject_id: string | null;
  /** Facts they would share if they are willing. */
  reveals: string[];
  access: TopicAccess;
  /** They will not discuss this at all until the player knows something first. */
  gated_on_fact: string | null;
  asked: boolean;
  /**
   * Set on a background insight. Not a reveal and not a check — a line you have standing
   * to say because of who you are, which the resolver turns into common ground.
   */
  insight_id: string | null;
  /** True when no roll stands between the player and the answer. */
  open: boolean;
  /** Why it is not simply open. Shown alongside, never instead of the topic. */
  closed_reason: string | null;
}

/** Base difficulty of getting a fact out of someone, before trust moves it. */
export function baseDcFor(f: Fact): number {
  if (f.secret) return 18;
  if (f.importance >= 4) return 13;
  return 8;
}

/**
 * At or below this DC, they simply answer. Making a player roll Persuasion to ask a friend
 * about the weather is how a conversation becomes a slot machine.
 */
export const JUST_TELL_YOU_DC = 7;

/** Is this fact's seal currently holding? */
export function sealHolds(s: GameState, f: Fact, npcTrust: number): boolean {
  if (!f.seal) return false;
  if (f.seal.lifted_by_flag) return s.world.flags[f.seal.lifted_by_flag] !== true;
  return npcTrust < SECRET_TRUST;
}

/**
 * The DC a sealed topic is pressed at. Deliberately high: you are not rolling to open the
 * door, you are rolling to notice where its key is kept.
 */
export const SEALED_DC = 20;

/** The player's background, as a word for the bracketed tag. "OUTLANDER". */
export function backgroundLabel(s: GameState): string {
  const player = s.entities[s.meta.pc_id];
  const id = player ? backgroundOf(player) : null;
  if (!id) return "you";
  return (BACKGROUND_SOCIAL[id]?.id ?? id).replace(/^bg_/, "").replace(/_/g, " ");
}

/** How much they will put up with before they end it. */
export const FRICTION_LIMIT = 6;

/**
 * What could be talked about, assembled from state.
 *
 * Nothing here is authored as a dialogue tree. A topic exists because a fact exists, or a
 * lead points somewhere, or this person has something they have not told you — which means
 * the conversation grows as the campaign does, without anyone writing a branch for it.
 */
export function topicsFor(s: GameState, npcId: string): Topic[] {
  const npc = s.entities[npcId];
  if (!npc) return [];

  const rel = s.relationships[`${npcId}->${s.meta.pc_id}`];
  const trust = rel?.dims.trust ?? 0;
  const convo = s.conversation?.with_id === npcId ? s.conversation : null;
  const raised = new Set(convo?.raised ?? []);

  const mine = factsKnownToPc(s);
  const theirs = factsKnownTo(s, npcId);
  const out: Topic[] = [];

  const push = (t: Omit<Topic, "asked" | "open" | "closed_reason" | "insight_id"> & { insight_id?: string | null }) => {
    const asked = raised.has(t.id);
    let access = t.access;

    // You cannot ask about something you have never heard of. This one really is a wall,
    // and it is the honest kind: the topic is not hidden, it is simply not yet a thought
    // the character could have had.
    if (t.gated_on_fact && !mine.some((f) => f.id === t.gated_on_fact)) {
      access = { kind: "sealed", why: "you would not know to ask", opens_when: "you learn of it elsewhere" };
    }

    const closed =
      access.kind === "open" ? null
      : access.kind === "guarded" ? `${npc.name} ${access.why} — DC ${access.dc}`
      : access.why;

    out.push({ ...t, access, asked, open: access.kind === "open", closed_reason: closed, insight_id: t.insight_id ?? null });
  };

  // 1. Themselves — always available, and the way most conversations actually start.
  push({
    id: `t_self_${npcId}`, kind: "self", label: `ask ${npc.name} about themselves`,
    subject_id: npcId, reveals: [], access: { kind: "open" }, gated_on_fact: null,
  });

  // 2. What they know that you do not. This is the real currency of a conversation, and
  //    it is exactly where trust does its work.
  for (const f of theirs) {
    if (mine.some((m) => m.id === f.id)) continue;
    if (f.superseded_by) continue;
    const subject = f.subjects[0] ? s.entities[f.subjects[0]] : undefined;

    // A sealed fact is the rare one. Everything else is a DC that trust moved.
    const dc = baseDcFor(f) + trustDcShift(trust);
    const access: TopicAccess = sealHolds(s, f, trust)
      ? { kind: "sealed", why: f.seal!.why, opens_when: f.seal!.opens_when }
      : dc <= JUST_TELL_YOU_DC
        ? { kind: "open" }
        : { kind: "guarded", dc, why: trustLabel(trust), skill: "persuasion" };

    push({
      id: `t_fact_${f.id}`,
      kind: subject ? "person" : "fact",
      label: subject ? `ask about ${subject.name}` : "press them on what they are not saying",
      subject_id: f.subjects[0] ?? null,
      reveals: [f.id],
      access,
      gated_on_fact: null,
    });
  }

  // 3. Quests they are involved in, and leads that name them.
  for (const q of Object.values(s.quests)) {
    if (q.status !== "active" || q.visibility === "hidden") continue;
    const involved = q.giver_entity_id === npcId ||
      q.leads.some((l) => l.source_entity_id === npcId) ||
      theirs.some((f) => f.quest_ids.includes(q.id));
    if (!involved) continue;
    push({
      id: `t_quest_${q.id}`, kind: "quest", label: `ask about ${q.title.toLowerCase()}`,
      subject_id: q.id, reveals: [], access: { kind: "open" }, gated_on_fact: null,
    });
  }

  // 4. People and places you know of that they might too.
  const named = new Set<string>();
  for (const f of mine) {
    for (const sid of f.subjects) {
      if (sid === npcId || named.has(sid)) continue;
      const e = s.entities[sid];
      const l = s.locations[sid];
      if (!e && !l) continue;
      named.add(sid);
      push({
        id: `t_about_${sid}`, kind: e ? "person" : "place",
        label: `ask about ${e?.name ?? l?.name}`,
        subject_id: sid, reveals: [], access: { kind: "open" }, gated_on_fact: null,
      });
    }
  }

  // 4b. Lines only THIS character can say.
  //
  //     A background insight is not a better Persuasion check — it is a door that exists
  //     for you and does not exist for anyone else at the table. An outlaw talking to a
  //     fence has something to work with that a paladin simply does not, and that
  //     asymmetry is the entire point of asking where someone came from.
  //
  //     Always open: you are not rolling to know your own past.
  for (const ins of insightsFor(s, npc)) {
    push({
      id: `t_insight_${ins.id}`, kind: "insight",
      label: insightLabel(backgroundLabel(s), ins),
      subject_id: npcId, reveals: [], access: { kind: "open" },
      gated_on_fact: null, insight_id: ins.id,
    });
  }

  // 5. What is going around. Only where they would plausibly hear things.
  if (npc.faction_ids.length > 0 || npc.schedule.length > 0) {
    push({
      id: `t_rumour_${npcId}`, kind: "rumour", label: "ask what people are saying",
      subject_id: null, reveals: [],
      access: trust > -10
        ? { kind: "open" }
        : { kind: "guarded", dc: 12 + trustDcShift(trust), why: trustLabel(trust), skill: "persuasion" },
      gated_on_fact: null,
    });
  }

  // Fresh topics first; things you have already raised sink.
  return out.sort((a, b) => Number(a.asked) - Number(b.asked) || a.label.localeCompare(b.label));
}

/**
 * What this NPC wants out of the conversation. Handed to the narrator so they play a
 * person with an agenda rather than a vending machine that dispenses lore when prompted.
 */
export function agendaOf(s: GameState, npc: Entity): string {
  const rel = s.relationships[`${npc.id}->${s.meta.pc_id}`];
  const goal = npc.goals[0]?.text;
  const bits: string[] = [];
  if (goal) bits.push(`They want: ${goal}`);
  if (rel && rel.dims.fear > 40) bits.push("They are afraid of you and want this over with.");
  else if (rel && rel.dims.trust < -20) bits.push("They do not trust you and will give as little as they can.");
  else if (offersUnpromptedAid(rel)) bits.push("They like you enough to offer something unasked.");
  if (npc.personality.flaw) bits.push(`Their weakness: ${npc.personality.flaw}`);
  return bits.join(" ");
}

/**
 * What a social approach would actually achieve here.
 *
 * The important half is `possible`. A check that cannot succeed should not be offered — a
 * DM who lets you roll Persuasion on something the NPC will never do is wasting your turn
 * and teaching you the dice do not matter.
 */
export interface SocialRead {
  approach: "persuade" | "deceive" | "intimidate";
  possible: boolean;
  why_not: string | null;
  /** What it would cost them to say yes, for the narrator. */
  stakes: string;
  modifier: number;
}

export function readApproaches(s: GameState, npcId: string): SocialRead[] {
  const npc = s.entities[npcId];
  const player = s.entities[s.meta.pc_id];
  if (!npc || !player) return [];
  const rel = s.relationships[`${npcId}->${s.meta.pc_id}`];
  const disposition = dispositionOf(rel?.dims.affinity ?? 0);

  const out: SocialRead[] = [];

  out.push({
    approach: "persuade",
    possible: disposition !== "hostile",
    why_not: disposition === "hostile" ? `${npc.name} is past being reasoned with` : null,
    stakes: `They are ${disposition}.`,
    modifier: skillModifier(player, "persuasion"),
  });

  out.push({
    approach: "deceive",
    // Someone who has caught you out once is watching for it.
    possible: (rel?.tags ?? []).indexOf("caught_lying") === -1,
    why_not: (rel?.tags ?? []).includes("caught_lying") ? `${npc.name} has caught you lying before` : null,
    stakes: "If it fails, they will remember.",
    modifier: skillModifier(player, "deception"),
  });

  out.push({
    approach: "intimidate",
    // Threatening someone already terrified gets you compliance, not information.
    possible: !willComplyFromFear(rel),
    why_not: willComplyFromFear(rel) ? `${npc.name} is already frightened enough to do as you say` : null,
    stakes: "It will cost you their goodwill, whether or not it works.",
    modifier: skillModifier(player, "intimidation"),
  });

  return out;
}

/** Would they share this particular thing, given how they feel? */
export function willTell(s: GameState, npcId: string, factId: string): boolean {
  const fact = s.facts.find((f) => f.id === factId);
  if (!fact) return false;
  const rel = s.relationships[`${npcId}->${s.meta.pc_id}`];
  if (!fact.secret) return true;
  return willShareSecrets(rel);
}

/** Pressing someone raises friction; past the limit they end the conversation. */
export function wouldWalkAway(c: Conversation | null): boolean {
  return !!c && c.friction >= FRICTION_LIMIT;
}

/**
 * What pressing a topic actually got you.
 *
 * The interesting case is `slip`. A sealed topic cannot be opened by a roll, but rolling
 * well at one is not nothing: they let something show — and what shows is THE KEY, the
 * thing that would open it. Mechanically the player gets a lead rather than the fact.
 *
 * This is the answer to "a d20 works on anything". It does. It just does not always work
 * on the thing you pointed it at, which is also true at a table.
 */
export type PressResult =
  | { kind: "told"; fact_ids: string[] }
  | { kind: "slip"; lead: string; friction: number }
  | { kind: "deflected"; friction: number }
  | { kind: "refused"; friction: number };

export function pressOutcome(topic: Topic, degree: Degree): PressResult {
  if (topic.access.kind === "open") return { kind: "told", fact_ids: topic.reveals };

  if (topic.access.kind === "sealed") {
    // No total buys the secret. A critical buys the key to it.
    if (degree === "critical_success") {
      return { kind: "slip", lead: topic.access.opens_when, friction: 1 };
    }
    return { kind: "refused", friction: degree === "failure" ? 3 : 2 };
  }

  switch (degree) {
    case "critical_success": return { kind: "told", fact_ids: topic.reveals };
    case "success": return { kind: "told", fact_ids: topic.reveals };
    // They tell you, and they resent being pushed into it.
    case "success_at_cost": return { kind: "told", fact_ids: topic.reveals };
    case "failure": return { kind: "deflected", friction: 2 };
  }
}
