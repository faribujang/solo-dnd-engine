import type { GameState } from "../schema/state.js";
import { estimateTokens } from "../llm/client.js";
import { dispositionOf, offersUnpromptedAid, willShareSecrets } from "../rules/social.js";
import { skillModifier } from "../rules/checks.js";
import {
  itemsAt, itemsOwnedBy, npcsPresent, pc, timeOfDayLabel, visibleExits,
} from "../state/selectors.js";
import { factsKnownBy, selectFacts, type ScoredFact } from "./selectFacts.js";
import { topicsFor } from "../engine/conversation.js";
import { crowdAt, interjectionsFor } from "../engine/bystanders.js";
import { BACKGROUND_SOCIAL, backgroundOf, insightsFor, socialTagsOf } from "../rules/backgrounds.js";
import { renderPolitics, wingOf } from "../rules/factions.js";

/**
 * Deterministic, pure, token-budgeted prompt assembly.
 *
 * The single most important property here: NOTHING carries forward from a previous prompt.
 * There is no conversation history in the API sense — every narration call is stateless and
 * rebuilt from state. That is what makes drift structurally impossible rather than merely
 * unlikely: the model cannot misremember something it is handed fresh every turn.
 *
 * When over budget, low-priority sections shed content by rule (drop whole items, oldest
 * first), never by truncating mid-object. A half-written NPC block is worse than no block.
 */

export interface Section {
  id: string;
  priority: number;       // 1 is most important; `fixed` sections are never shed
  budget: number;
  fixed: boolean;
  title: string;
  body: string;
}

export interface BuiltContext {
  system: string;
  user: string;
  sections: Section[];
  totalTokens: number;
  /** Facts that made it into CANON, with their scores, for the debugging view. */
  canon: ScoredFact[];
  /** Sections that lost content to the budget, so you can see the prompt degrade. */
  shed: string[];
}

export interface ContextOptions {
  /** Ranked shortlist for the chips, phrased by the narrator. See rules/suggest.ts. */
  suggestions?: string;
  /** The resolved mechanical outcome of this turn, if there is one. */
  mechanics?: string;
  /** Verbatim recent turns, oldest first. */
  recent?: readonly string[];
  /** Prose recaps of earlier scenes. Tone only — never a source of facts. */
  digests?: readonly string[];
  /** Total prompt budget. The spec targets 4–6k. */
  maxTokens?: number;
  /** Force the long description, as `look` does. */
  verboseLocation?: boolean;
  /**
   * Companions who reacted strongly enough to speak this turn, with the authored fallback
   * line. The reaction itself has already happened and is already journaled — this only
   * lets the narrator say it in their voice instead of the author's.
   */
  companionLines?: readonly { name: string; sign: string; to: string; line: string }[];
}

const NL = String.fromCharCode(10);

const BUDGETS = {
  system: 600,
  canon: 1200,
  scene: 400,
  pc: 350,
  npcs: 900,
  party: 300,
  quests: 400,
  recent: 900,
  digests: 300,
  mechanics: 200,
  room: 260,
  companions: 220,
  background: 220,
  politics: 220,
  threads: 260,
} as const;

export function buildContext(s: GameState, opts: ContextOptions = {}): BuiltContext {
  const player = pc(s);
  const loc = s.locations[player.location_id]!;
  const present = npcsPresent(s, loc.id);
  const presentIds = [player.id, ...present.map((e) => e.id)];
  const activeQuests = Object.values(s.quests)
    .filter((q) => q.status === "active")
    .sort((a, b) => a.id.localeCompare(b.id));

  const canon = selectFacts(s, {
    presentEntityIds: presentIds,
    currentLocationId: loc.id,
    activeQuestIds: activeQuests.map((q) => q.id),
    budgetTokens: BUDGETS.canon,
    currentTurn: s.meta.turn,
  });

  const shed: string[] = [];
  const sections: Section[] = [];
  const add = (
    id: string, priority: number, budget: number, fixed: boolean, title: string, body: string,
  ) => {
    if (body.trim() !== "") sections.push({ id, priority, budget, fixed, title, body });
  };

  // What the player has taken on. Without this block the DM cannot close a thread,
  // cannot have an NPC ask about one, and will open duplicates of promises already made.
  const openThreads = Object.values(s.threads)
    .filter((t) => t.status === "open")
    .sort((a, b) => a.id.localeCompare(b.id));

  // 1 — system persona and the hard constraints.
  const system = renderSystem(s);

  // 2 — CANON. Highest priority. The single failure mode this design fights hardest.
  add("canon", 1, BUDGETS.canon, false,
    "CANON — established facts. You may not contradict these.",
    canon.map((c) => `- ${c.fact.text}`).join("\n"));

  // 3 — the scene.
  add("scene", 2, BUDGETS.scene, false, "SCENE", renderScene(s, opts.verboseLocation ?? false));

  // 3b — what the player has taken on. High priority and cheap: an open thread the DM
  // cannot see is a promise the world forgot it made, and it will open a duplicate of it
  // next scene.
  add("threads", 2, BUDGETS.threads, false,
    "OPEN THREADS — things the player took on. Close one with `resolve_thread` the moment it is settled.",
    openThreads.map((t) => {
      const who = t.from_entity_id ? s.entities[t.from_entity_id]?.name : null;
      const about = t.subject_ids.map((id) => s.entities[id]?.name).filter(Boolean).join(", ");
      return `- ${t.id}: ${t.text}${who ? ` (asked by ${who})` : ""}${about ? ` [about ${about}]` : ""}`;
    }).join(NL));

  // 4 — the player's sheet.
  add("pc", 2, BUDGETS.pc, false, "PLAYER CHARACTER", renderPc(s));

  // 5 — everyone present, with how they feel and what they know.
  add("npcs", 3, BUDGETS.npcs, false, "PRESENT", renderNpcs(s, present.map((e) => e.id), presentIds));

  // 5b — the conversation, if one is open. What they want, and what is still unsaid.
  if (s.conversation) {
    const other = s.entities[s.conversation.with_id];
    if (other) {
      const open = topicsFor(s, other.id).filter((t) => t.open && !t.asked).slice(0, 5);
      add("conversation", 2, 300, false,
        `IN CONVERSATION WITH ${other.name.toUpperCase()}`,
        [
          s.conversation.their_agenda,
          s.conversation.raised.length ? `Already raised: ${s.conversation.raised.length} topic(s) — do not repeat yourself.` : "",
          open.length ? `Still unsaid, if it comes up: ${open.map((t) => t.label).join("; ")}` : "",
          s.conversation.friction >= 4 ? "They are losing patience." : "",
        ].filter(Boolean).join("\n"));
    }
  }

  // 5a2 — whose town this is.
  //
  //     The DM cannot write a room that feels governed unless it knows who governs it. The
  //     numbers stay here: what reaches the page is what people are willing to say out loud.
  {
    const politics = renderPolitics(s, loc.id);
    if (politics) add("politics", 2, BUDGETS.politics, false, "WHO HOLDS THIS PLACE", politics);
  }

  // 5b2 — lines this character has standing to say, and why.
  //
  //     A background insight must read as EARNED rather than as a menu option, and that
  //     only works if the narrator knows what the player is actually doing: not "uses
  //     Criminal skill" but "signals, without saying so, that they came up in the same
  //     trade". The intent is handed over; the words are the model's.
  if (s.conversation) {
    const other = s.entities[s.conversation.with_id];
    const bg = backgroundOf(player);
    if (other && bg) {
      const lines: string[] = [`${player.name}: ${BACKGROUND_SOCIAL[bg]?.blurb ?? ""}`];
      for (const i of insightsFor(s, other)) lines.push(`If they play "${i.label}" — ${i.intent}`);
      const tags = socialTagsOf(other);
      if (tags.length) lines.push(`${other.name} reads socially as: ${tags.join(", ")}.`);
      add("background", 2, BUDGETS.background, false, "WHERE THEY CAME FROM", lines.join("\n"));
    }
  }

  // 5c — the rest of the room. One person speaks; the others are not furniture.
  //
  // Interjections are narration cues, never mechanics: code decides who has standing to
  // put their oar in and what it is about, and the DM writes the line. Without this a
  // tavern full of named people watches you lie to their friend in total silence.
  if (s.conversation) {
    const subjects = [s.conversation.with_id, ...topicsFor(s, s.conversation.with_id)
      .filter((t) => s.conversation!.raised.includes(t.id))
      .flatMap((t) => (t.subject_id ? [t.subject_id] : []))];
    const cuts = interjectionsFor(s, s.conversation.with_id, subjects);
    const crowd = crowdAt(s, loc.id);
    const lines: string[] = [];
    if (crowd) lines.push(`The room (${crowd.size} others) is ${crowd.label}. Treat them as ONE presence — a murmur, a turned head — never as separate speakers.`);
    for (const c of cuts) lines.push(`${c.name} MAY INTERJECT — ${c.why}`);
    if (cuts.length) lines.push("At most one of them actually speaks, and only if it earns its place. A line, not a speech.");
    if (lines.length) add("room", 3, BUDGETS.room, false, "THE REST OF THE ROOM", lines.join("\n"));
  }

  // 5d — companions who are about to say something.
  //
  //     The reaction is already truth: the numbers moved in the reducer and a line is
  //     already in the journal. This block exists so the narrator can voice the same beat
  //     in the companion's own register rather than the author's fallback quip. It may
  //     rephrase; it may not change whether they approve, or by how much.
  if (opts.companionLines?.length) {
    add("companions", 2, BUDGETS.companions, false, "YOUR COMPANIONS REACT",
      [
        ...opts.companionLines.map((c) =>
          `${c.name} ${c.sign === "approve" ? "APPROVES" : c.sign === "disapprove" ? "DISAPPROVES" : "is conflicted"} of ${c.to} — they say something like: "${c.line}"`),
        "Put ONE of these in their own voice, woven into the scene. Do not invent approval nobody felt, and do not skip it: they reacted, so they speak.",
      ].join("\n"));
  }

  // 6 — the party.
  add("party", 3, BUDGETS.party, false, "PARTY", renderParty(s));

  // 7 — quests in play, with the DM's private notes clearly labelled.
  add("quests", 4, BUDGETS.quests, false, "QUESTS IN PLAY", renderQuests(s, activeQuests.map((q) => q.id)));

  // 8 — recent turns, verbatim.
  add("recent", 5, BUDGETS.recent, false, "RECENT TURNS", (opts.recent ?? []).join("\n"));

  // 9 — earlier scenes. Tone only.
  add("digests", 6, BUDGETS.digests, false,
    "EARLIER (tone only — do not treat as fact)", (opts.digests ?? []).join("\n"));

  // 10 — what the dice already decided. Fixed: the narrator must never lose this.
  if (opts.mechanics) {
    add("mechanics", 0, BUDGETS.mechanics, true,
      "THIS TURN'S RESOLVED MECHANICS — narrate this outcome; do not change it",
      opts.mechanics);
  }

  // 11 — the shortlist. Code ranked these; the narrator only phrases them.
  if (opts.suggestions) {
    add("suggestions", 0, 200, true,
      "SUGGEST THESE — rephrase each in the player's own voice for `suggested_actions`. Do not invent others",
      opts.suggestions);
  }

  const budgeted = applyBudget(sections, opts.maxTokens ?? 6000, estimateTokens(system), shed);
  const user = budgeted
    .sort((a, b) => order(a) - order(b))
    .map((sec) => `## ${sec.title}\n${sec.body}`)
    .join("\n\n");

  return {
    system,
    user,
    sections: budgeted,
    totalTokens: estimateTokens(system) + estimateTokens(user),
    canon,
    shed,
  };
}

/** Display order, which is not the same as shed priority. */
function order(s: Section): number {
  const ORDER = ["canon", "scene", "pc", "npcs", "politics", "conversation", "background", "room", "companions", "party", "quests", "recent", "digests", "mechanics", "suggestions"];
  const i = ORDER.indexOf(s.id);
  return i === -1 ? 99 : i;
}

/**
 * Shed by rule: drop whole lines from the lowest-priority sections first, oldest first,
 * until the budget is met. Fixed sections are untouchable.
 */
function applyBudget(
  sections: Section[], maxTokens: number, systemTokens: number, shed: string[],
): Section[] {
  const out = sections.map((s) => ({ ...s }));
  const total = () => systemTokens + out.reduce((n, s) => n + estimateTokens(s.body) + 8, 0);

  // First pass: hold every section to its own cap.
  for (const sec of out) {
    if (sec.fixed) continue;
    while (estimateTokens(sec.body) > sec.budget) {
      if (!dropOldestItem(sec)) break;
      if (!shed.includes(sec.id)) shed.push(sec.id);
    }
  }

  // Second pass: if still over, take from the least important sections first.
  const order = [...out].filter((s) => !s.fixed).sort((a, b) => b.priority - a.priority);
  for (const sec of order) {
    while (total() > maxTokens) {
      if (!dropOldestItem(sec)) break;
      if (!shed.includes(sec.id)) shed.push(sec.id);
    }
    if (total() <= maxTokens) break;
  }

  return out.filter((s) => s.body.trim() !== "");
}

/**
 * Drop the OLDEST WHOLE ITEM from a section, never part of one.
 *
 * An item is a top-level line plus the indented lines beneath it — an NPC and everything
 * known about them, a quest and its steps. This used to shift off a single LINE at a time,
 * which sliced an NPC in half and left a fragment whose first line, once the block was
 * trimmed, read as a complete entry. Playing a crowded village surfaced it immediately: the
 * DM narrated one of the smith's private facts as though it were a person standing there.
 *
 * The comment at the top of this file has always promised whole items. Now it is true.
 *
 * Returns false when there is nothing further to drop.
 */
function dropOldestItem(sec: Section): boolean {
  const lines = sec.body.split("\n");
  if (lines.length <= 1) return false;

  // Consume the head, then everything belonging to it: indented continuation lines, and the
  // blank line that separates this entry from the next.
  let end = 1;
  while (end < lines.length && (lines[end]!.startsWith("  ") || lines[end]!.trim() === "")) end++;

  sec.body = lines.slice(end).join("\n").replace(/^\n+/, "");
  return sec.body.trim() !== "";
}

// ------------------------------------------------------------------ render

function renderSystem(s: GameState): string {
  return [
    "You are the Dungeon Master for a solo Dungeons & Dragons 5e campaign.",
    "",
    "HARD RULES — these are not style notes:",
    "1. The CANON block is established truth. Never contradict it. If canon is silent on",
    "   something, you may invent it, and you must then report it in `facts`.",
    "2. Never state or change a number the mechanics block did not give you: no hit points,",
    "   no damage, no gold, no dice results, no success or failure of your own invention.",
    "3. If a mechanics block is present, narrate that exact outcome. A failed roll stays",
    "   failed no matter how good a scene a success would make.",
    "4. Speak only for NPCs listed as present, and only about things that NPC knows. A",
    "   character cannot mention what they never saw and nobody told them.",
    "5. Second person, present tense. One or two paragraphs. End on the situation, not on a",
    "   question, and never on a list of options.",
    "5b. BROAD STROKES, not a camera. Narrate the WHOLE of what the player asked for and",
    "   land on the outcome — do not stop halfway through, at the threshold, to make them",
    "   ask for the next inch. \"You spend the morning asking after the surveyor\" is one",
    "   reply, not six. Zoom in close only when something is genuinely at stake: a blow",
    "   landing, a lie being weighed, a name nobody meant to say. Everything else is summary.",
    "5c. Lead with what CHANGED. The room was described when they walked in; do not set the",
    "   scene again. If somebody spoke, their words are the most important thing on screen",
    "   and belong near the top, not after a paragraph about the weather.",
    "5d. A player has to hold the whole reply in their head to decide what to do next. If",
    "   they would have to read it twice to find what actually happened, it is too dense —",
    "   and the fix is fewer DETAILS, not shorter sentences. One image per paragraph, and",
    "   cut atmosphere before you cut information.",
    "6. Do not narrate the player's feelings, decisions or dialogue. Describe the world's",
    "   response and stop.",
    "7. A failed check must CHANGE THE SITUATION, never stall it. The lock stays shut AND",
    "   the pick snaps off, and someone upstairs heard it. 'Nothing happens' is the one",
    "   outcome a real Dungeon Master never gives.",
    "8. A character KNOWING something is not permission to say it. Where a block says they",
    "   will not tell you, they change the subject, answer a different question, or refuse —",
    "   and the player should feel there is something there. Trust opens that door, and only",
    "   trust: no roll does.",
    "9. On SUCCESS AT A COST the player got what they reached for — say so — and THEN name",
    "   the complication: a noise, a broken tool, lost time, someone notices. Never quietly",
    "   turn it into a failure. On CRITICAL SUCCESS give them something more than they asked.",
    "",
    `The player character is ${pc(s).name}. Address them as "you".`,
    "",
    "Report anything you newly establish in `facts`, and any shift in how a present NPC",
    "regards the player in `attitude_deltas`. Keep both small and specific.",
    "",
    "`proposals` may contain ONLY these, spelled exactly, with exactly these fields:",
    "  {t:\"set_flag\", key, value}                      — key is snake_case",
    "  {t:\"add_lead\", quest_id, text, points_to_location_id}",
    "  {t:\"reveal_location\", location_id}",
    "  {t:\"reveal_exit\", location_id, dir}",
    "  {t:\"teach_fact\", entity_id, fact_id}",
    "  {t:\"move_entity\", entity_id, location_id}",
    "  {t:\"advance_time\", minutes}",
    "  {t:\"introduce_local\", name, descriptor, pronouns, location_id, voice, trait}",
    "  {t:\"open_thread\", text, subject_ids, location_id, from_entity_id}",
    "  {t:\"resolve_thread\", thread_id, as: kept|broken|faded, outcome}",
       + "",
    "Use `introduce_local` the moment you name somebody who is not in the cast above —",
    "a innkeeper, a clerk, a boy with a message. That makes them REAL and the same",
    "person next time. Do not use it for someone already listed as present, and do not",
    "use it for a crowd: unnamed passers-by need no record. Give them a `voice` (how they",
    "talk, in a few words) and one `trait` — you will be asked to play them again.",
    "",
    "THREADS are the side of the story nobody wrote down: a favour asked, a debt, a",
    "warning, an errand. Open one the moment the player takes something on — one per",
    "scene at most, and only when they actually agreed to it. RESOLVE one the moment it",
    "is settled, kept or broken. An open thread you never close is a promise the world",
    "forgot it made.",
    "Anything else — damage, healing, items, gold, quest status, combat — is the engine's",
    "and is discarded if you propose it. When in doubt, propose nothing and just narrate.",
  ].join("\n");
}

function renderScene(s: GameState, verbose: boolean): string {
  const loc = s.locations[pc(s).location_id]!;
  const first = loc.visited_count <= 1;
  const lines = [
    `${loc.name} — ${timeOfDayLabel(s)}, ${s.world.weather.current}, light: ${loc.ambient.light}`,
    (first || verbose) && loc.long_desc ? loc.long_desc : loc.short_desc,
  ];
  if (loc.ambient.sound) lines.push(`Sound: ${loc.ambient.sound}. Smell: ${loc.ambient.smell}.`);
  for (const f of loc.features) {
    lines.push(`Feature — ${f.name}: ${f.desc}`);
  }
  const loose = itemsAt(s, loc.id);
  if (loose.length) {
    lines.push(`Lying here: ${loose.map((i) => s.item_defs[i.def_id]?.name ?? i.def_id).join(", ")}`);
  }
  lines.push(`Exits: ${visibleExits(s, loc).map((x) => `${x.dir}${x.locked_by ? " (locked)" : ""}`).join(", ") || "none visible"}`);
  return lines.filter(Boolean).join("\n");
}

function renderPc(s: GameState): string {
  const p = pc(s);
  const held = itemsOwnedBy(s, p.id)
    .map((i) => `${s.item_defs[i.def_id]?.name ?? i.def_id}${i.qty > 1 ? ` x${i.qty}` : ""}`)
    .join(", ");
  const lines = [
    `${p.name}, level ${p.level}. ${p.descriptor}`,
    `HP ${p.hp.current}/${p.hp.max}${p.hp.temp ? ` (+${p.hp.temp} temp)` : ""}, AC ${p.ac}.`,
    `Notable skills: ${["stealth", "perception", "persuasion", "investigation"]
      .map((sk) => `${sk} ${fmtMod(skillModifier(p, sk as never))}`).join(", ")}`,
    held ? `Carrying: ${held}` : "Carrying nothing.",
  ];
  if (p.conditions.length) lines.push(`Conditions: ${p.conditions.map((c) => c.id).join(", ")}`);
  return lines.join("\n");
}

function renderNpcs(s: GameState, npcIds: readonly string[], presentIds: readonly string[]): string {
  if (npcIds.length === 0) return "Nobody else is here.";

  return npcIds.map((id) => {
    const e = s.entities[id]!;
    const rel = s.relationships[`${e.id}->${s.meta.pc_id}`];
    const lines = [`${e.name} — ${e.descriptor}`];

    if (e.personality.voice) lines.push(`  Voice: ${e.personality.voice}`);
    // Which wing of their faction. Two people under the same banner can want opposite
    // things, and a DM told only the banner plays the banner.
    const wing = wingOf(s, e);
    if (wing) lines.push(`  ${wing.faction}, ${wing.name} wing — wants: ${wing.wants}`);
    if (e.personality.traits.length) lines.push(`  Traits: ${e.personality.traits.join("; ")}`);
    if (e.personality.flaw) lines.push(`  Flaw: ${e.personality.flaw}`);

    if (rel) {
      lines.push(
        `  Feels toward you: ${dispositionOf(rel.dims.affinity)} ` +
        `(affinity ${rel.dims.affinity}, trust ${rel.dims.trust}, fear ${rel.dims.fear}, respect ${rel.dims.respect})`,
      );
      if (rel.opinion) lines.push(`  Their view: ${rel.opinion}`);
      if (!willShareSecrets(rel)) lines.push(`  They will NOT share anything secret with you.`);
      if (offersUnpromptedAid(rel)) lines.push(`  They would offer help without being asked.`);
    } else {
      lines.push(`  Feels toward you: no particular opinion yet.`);
    }

    const goal = e.goals[0];
    if (goal) lines.push(`  Wants: ${goal.text}`);

    // Only what THIS npc knows about the people in the room. The engine's knowledge model
    // reaching all the way into the prompt is what stops an NPC knowing your business.
    //
    // Split by whether they would actually say it. The DM needs both halves: the first to
    // speak from, the second to deflect from — an NPC changing the subject is only
    // convincing if the writer knows what is being changed away from.
    const known = factsKnownBy(s, e.id, presentIds).slice(-6);
    const willSay = known.filter((f) => !f.secret || willShareSecrets(rel));
    const withholds = known.filter((f) => f.secret && !willShareSecrets(rel));
    if (willSay.length) lines.push(`  Knows and would say: ${willSay.map((f) => f.text).join(" | ")}`);
    if (withholds.length) {
      lines.push(`  KNOWS BUT WILL NOT TELL YOU: ${withholds.map((f) => f.text).join(" | ")}`);
      lines.push(`  → Deflect if asked. Let it show that there is something. Do not say it.`);
    }
    return lines.join("\n");
  }).join("\n\n");
}

function renderParty(s: GameState): string {
  const party = Object.values(s.entities)
    .filter((e) => e.kind === "companion" && e.alive)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (party.length === 0) return "";
  return party
    .map((e) => `${e.name}: HP ${e.hp.current}/${e.hp.max}, behaviour ${e.ai_policy ?? "cautious"}`)
    .join("\n");
}

function renderQuests(s: GameState, ids: readonly string[]): string {
  if (ids.length === 0) return "";
  return ids.map((id) => {
    const q = s.quests[id]!;
    const step = q.steps.find((st) => st.id === q.current_step_id);
    const lines = [`${q.title} — ${q.summary}`];
    if (step) lines.push(`  Current objective: ${step.desc}`);
    for (const l of q.leads.slice(-3)) lines.push(`  Lead the player has: ${l.text}`);
    // dm_notes is truth the player has not earned yet. Labelled so the model hints and
    // withholds rather than blurting.
    if (q.dm_notes) lines.push(`  DM ONLY (do not reveal, may foreshadow): ${q.dm_notes}`);
    return lines.join("\n");
  }).join("\n\n");
}

function fmtMod(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}
