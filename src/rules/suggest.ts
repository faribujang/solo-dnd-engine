import type { GameState } from "../schema/state.js";
import type { Affordance } from "./affordances.js";
import { affordances } from "./affordances.js";
import { skillModifier } from "./checks.js";
import { npcsPresent, pc, relationship } from "../state/selectors.js";

/**
 * SUGGESTION CHIPS — three or four things worth doing, beneath the prose.
 *
 * Distinct from the affordance bar, and the distinction is the whole design:
 *
 *   affordance bar   "what CAN I do?"        exhaustive, code, executes on tap
 *   suggestion chips "what is INTERESTING?"  three or four, RANKED BY CODE and
 *                                            PHRASED BY THE NARRATOR, and tapping one
 *                                            FILLS THE TEXT BOX rather than submitting
 *
 * The ranking has to be code, because it depends on what is newly available, what advances
 * a quest, and what the player has already tried — all of which are state. The narrator
 * only turns the winners into something a person would say. Same division as everywhere
 * else: code decides, the model phrases.
 *
 * Chips fill the box rather than submitting because that is what teaches phrasing. Tap
 * "Ask Thorne about the ledger", watch it appear, edit it to "ask Thorne who he owes money
 * to" — and now the player knows they could have typed that in the first place.
 */

export interface Suggestion {
  affordance: Affordance;
  score: number;
  /** Why it scored, for the debug view and for the narrator's phrasing hint. */
  because: string[];
  /** A plain-language fallback, used when there is no model or it declines to phrase. */
  fallback: string;
}

export interface SuggestContext {
  /** Action keys taken this scene, so we do not keep suggesting the same thing. */
  triedThisScene?: readonly string[];
  /** Ids revealed or acquired on the turn just resolved — the strongest signal there is. */
  newThisTurn?: readonly string[];
  limit?: number;
}

/** A stable key for "the same kind of thing", used for tried/repeat scoring. */
export function actionKeyOf(a: Affordance): string {
  const act = a.action;
  switch (act.type) {
    case "move": return `move:${act.dir}`;
    case "skill_check": return `check:${act.skill}:${act.target_id ?? act.tag ?? "-"}`;
    case "talk": return `talk:${act.target_id}`;
    case "attack": return `attack:${act.target_id}`;
    case "take": return `take:${act.item_instance_id}`;
    case "cast": return `cast:${act.spell_id}`;
    default: return act.type;
  }
}

export function suggest(s: GameState, ctx: SuggestContext = {}): Suggestion[] {
  const player = pc(s);
  const tried = new Set(ctx.triedThisScene ?? []);
  const fresh = new Set(ctx.newThisTurn ?? []);
  const activeQuests = Object.values(s.quests).filter((q) => q.status === "active");

  // Ids a lead points at, and ids named by a lead's text — both are "the player has a
  // reason to care about this".
  // A promise whose subject is in the room is the most actionable thing there is —
  // stronger than any lead, because the player made it themselves.
  const threadTargets = new Set<string>();
  for (const th of Object.values(s.threads)) {
    if (th.status !== "open") continue;
    for (const id of th.subject_ids) threadTargets.add(id);
    if (th.location_id) threadTargets.add(th.location_id);
  }

  const leadTargets = new Set<string>();
  const leadText: string[] = [];
  for (const q of activeQuests) {
    for (const l of q.leads) {
      if (l.points_to_location_id) leadTargets.add(l.points_to_location_id);
      if (l.source_entity_id) leadTargets.add(l.source_entity_id);
      leadText.push(l.text.toLowerCase());
    }
  }

  const best = new Set(
    (["stealth", "investigation", "perception", "persuasion", "athletics", "insight"] as const)
      .filter((sk) => skillModifier(player, sk) >= player.proficiency_bonus + 2),
  );

  const out: Suggestion[] = [];

  for (const a of affordances(s)) {
    if (!a.available) continue;
    // Gear management and looking around are bar verbs, never *suggestions*. "Unequip your
    // armour" is a legal action and has never once been the interesting thing to do.
    if (a.action.type === "equip" || a.action.type === "look") continue;
    // Travel is a map decision, not a chip. It belongs on the bar and the map.
    if (a.action.type === "travel") continue;
    if (a.group === "rest" && a.action.type === "rest" && a.action.kind === "long") continue;

    const key = actionKeyOf(a);
    const because: string[] = [];
    let score = 0;

    // Newly available beats everything: an exit that just opened is what the player
    // most wants to know they can use.
    const touches = touchedIds(a);
    if (touches.some((id) => fresh.has(id))) { score += 3; because.push("just became possible"); }

    // Advancing the current objective of an active quest.
    if (touches.some((id) => questRelevant(s, activeQuests, id))) { score += 3; because.push("advances a quest"); }

    // A lead the player holds but has not followed.
    if (touches.some((id) => leadTargets.has(id))) { score += 2; because.push("follows a lead"); }
    // Scored above a lead on purpose: a lead is the world pointing, a thread is the
    // player having already said yes.
    if (touches.some((id) => threadTargets.has(id))) { score += 3; because.push("you said you would"); }
    if (a.action.type === "talk") {
      const who = nameOf(s, a.action.target_id).toLowerCase();
      if (leadText.some((t) => t.includes(who))) { score += 1; because.push("named in a lead"); }
    }

    // Someone present has something they have never said.
    if (a.action.type === "talk") {
      const e = s.entities[a.action.target_id];
      if (e && e.on_first_talk.length > 0 && !s.world.fired_trigger_ids.some((f) => f.startsWith(`ent:${e.id}:talk:`))) {
        score += 2; because.push("they have not spoken to you yet");
      }
    }

    // A verb the player has not reached for this scene.
    if (!tried.has(key)) { score += 2; because.push("not tried yet"); }
    else { score -= 2; because.push("already tried this scene"); }

    // Things this character is actually good at — nudging the player toward their own sheet.
    if (a.action.type === "skill_check" && best.has(a.action.skill as never)) {
      score += 1; because.push("you are good at this");
    }

    // Talking is the most natural and least committal thing to do with a person, so it
    // should outrank a social check on the same NPC unless there is a reason to press.
    if (a.action.type === "talk") { score += 2; }

    // Lying to and leaning on someone are not neutral openers. Suggest them only when the
    // relationship gives a reason — otherwise the chips read like a list of ways to be
    // unpleasant to a stranger.
    if (a.action.type === "skill_check" && (a.action.skill === "deception" || a.action.skill === "intimidation")) {
      const rel = a.action.target_id ? relationship(s, a.action.target_id, player.id) : undefined;
      const hostile = (rel?.dims.affinity ?? 0) < -10 || (rel?.dims.trust ?? 0) < -10;
      if (hostile) { score += 1; because.push("they are already against you"); }
      else score -= 3;
    }

    /**
     * Doing something to the room.
     *
     * Talking scored +2 and working on a place scored nothing, so conversation won every
     * ranking and the chips taught the player, four at a time and for a hundred turns,
     * that this is a game about asking people things. The bias was in the scoring, not in
     * the player.
     */
    if (a.action.type === "interact") {
      score += 3;
      because.push("there is something here to work on");
    }

    /**
     * Background insights are colour, not a lead.
     *
     * They are always open and never spent until used, so "not tried yet" kept them
     * permanently fresh and "read the weather for them" appeared on the bar in the middle
     * of a break-in. Worth having, worth offering last.
     */
    if (a.action.type === "talk" && a.action.topic_id?.startsWith("t_insight_")) score -= 3;

    // Attacking is a big decision and should never be *suggested* out of nowhere.
    if (a.action.type === "attack" && !s.combat) score -= 6;

    // A short rest is legitimate when hurt and noise otherwise.
    if (a.group === "rest") score += player.hp.current < player.hp.max * 0.5 ? 1 : -3;

    out.push({ affordance: a, score, because, fallback: a.label });
  }

  out.sort((x, y) => y.score - x.score || actionKeyOf(x.affordance).localeCompare(actionKeyOf(y.affordance)));

  // Keep the shortlist varied. Two caps, because one is not enough: without the per-target
  // cap you get "Persuade Thorne / Lie to Thorne / Lean on Thorne", which is one idea
  // wearing three hats and tells the player nothing they did not already know.
  const perGroup = new Map<string, number>();
  const perTarget = new Map<string, number>();
  const picked: Suggestion[] = [];
  for (const sug of out) {
    if (picked.length >= (ctx.limit ?? 4)) break;
    const g = sug.affordance.group;
    if ((perGroup.get(g) ?? 0) >= 2) continue;

    const target = touchedIds(sug.affordance)[0] ?? "";
    if (target && (perTarget.get(target) ?? 0) >= 2) continue;

    perGroup.set(g, (perGroup.get(g) ?? 0) + 1);
    if (target) perTarget.set(target, (perTarget.get(target) ?? 0) + 1);
    picked.push(sug);
  }

  /**
   * Keep a seat for the world itself.
   *
   * Scoring alone is not enough: four talkable people in a room will still crowd out the
   * one pryable grate, and then the only thing the bar ever offers is another
   * conversation. If this place can be worked on at all, one of those ways is shown.
   */
  const physical = out.find((sg) => sg.affordance.action.type === "interact" && sg.affordance.available);
  if (physical && !picked.some((sg) => sg.affordance.action.type === "interact")) {
    // Drop the weakest pick rather than growing the bar: four chips is the shape that fits.
    if (picked.length >= (ctx.limit ?? 4)) picked.pop();
    picked.push(physical);
  }
  return picked;
}

/** The entity, location and item ids an affordance concerns. */
function touchedIds(a: Affordance): string[] {
  const act = a.action;
  switch (act.type) {
    case "move": return [];
    case "talk": case "attack": return [act.target_id];
    case "skill_check": return act.target_id ? [act.target_id] : [];
    case "take": return [act.item_instance_id];
    case "cast": return act.target_id ? [act.target_id] : [];
    default: return [];
  }
}

function questRelevant(s: GameState, quests: readonly { id: string; current_step_id: string | null; steps: { id: string; completion_triggers: { match?: { target_ids?: string[]; location_id?: string } }[] }[] }[], id: string): boolean {
  for (const q of quests) {
    const step = q.steps.find((st) => st.id === q.current_step_id);
    if (!step) continue;
    for (const t of step.completion_triggers) {
      if (t.match?.target_ids?.includes(id)) return true;
      if (t.match?.location_id === id) return true;
    }
  }
  void s;
  return false;
}

function nameOf(s: GameState, id: string): string {
  return s.entities[id]?.name ?? id;
}

/** Render the shortlist for the narrator, which is asked to phrase each in the player's voice. */
export function renderSuggestionsForPrompt(list: readonly Suggestion[]): string {
  if (list.length === 0) return "";
  return list
    .map((x) => `- ${x.fallback}${x.because.length ? `  (${x.because.join("; ")})` : ""}`)
    .join("\n");
}

/**
 * A chip, with the thing it would actually DO attached.
 *
 * Chips used to travel as bare strings. The ranking picked an affordance, the narrator
 * rephrased it, and the action was dropped on the floor — so "Remind them who I am and
 * take the lead" reached the player as a sentence with nothing behind it, and tapping it
 * sent free text back through the parser to be guessed at from scratch. It guessed
 * "conversation", nothing happened, and the player learned that chips do not work.
 *
 * `mechanic` is the other half of the same fix: a chip that is going to cost a roll should
 * SAY so before it is tapped. Players at a real table ask "is this a Persuasion check?"
 * constantly; the answer is knowable here, so it should be printed.
 */
export interface SuggestionOut {
  /** What the chip says — the narrator's phrasing where there is one. */
  text: string;
  /** The exact Action, so tapping an unedited chip does precisely what it advertised. */
  action: unknown;
  /** "Persuasion", "Attack", "" — shown as a prefix so the cost is never a surprise. */
  mechanic: string;
  /** The arithmetic, where there is any: "d20 +2 · DC 13". */
  detail: string;
}

const SKILL_LABEL: Record<string, string> = {
  animal_handling: "Animal Handling", sleight_of_hand: "Sleight of Hand",
};

function mechanicOf(a: Affordance): string {
  const act = a.action;
  switch (act.type) {
    case "skill_check":
      return SKILL_LABEL[act.skill] ?? act.skill.charAt(0).toUpperCase() + act.skill.slice(1);
    case "attack": return "Attack";
    case "montage": return "Hours";
    case "travel": return "Travel";
    case "cast": return "Cast";
    case "rest": return "Rest";
    default: return "";
  }
}

/**
 * Pair the narrator's phrasings with the actions they were phrased FROM.
 *
 * By position, because that is the only correspondence the model is given — and when the
 * counts disagree the ranked labels win, since a chip that does the wrong thing is worse
 * than one that reads plainly.
 */
/**
 * Does this read as something the player DOES, or as the narrator talking?
 *
 * The narrator is asked to rephrase the ranked shortlist as instructions, and mostly it
 * does. When it drifts it produces recaps — "Sibby said the smoke is coming off the
 * green, not the fields. That means houses" — which is a sentence about the past sitting
 * on a button that claims to be a next move. A player taps that and gets nothing they
 * expected, which is worse than a plainer chip.
 *
 * So the phrasing is checked rather than trusted, and a line that fails falls back to the
 * ranked label. Per chip, not all-or-nothing: one bad line should cost one chip.
 */
export function looksLikeAnAction(text: string): boolean {
  const t = text.trim();
  if (t.length < 3 || t.length > 72) return false;
  // Two sentences is a paragraph, not a button.
  if (/[.!?]\s+\S/.test(t)) return false;
  // Reported speech and commentary, rather than an instruction.
  if (/\b(said|says|told|tells|means|meant|seems|looks like|apparently|remember(s|ed)?)\b/i.test(t)) return false;
  if (/["“”]/.test(t)) return false;
  // "You have ...", "There is ..." — describing the world, not acting on it.
  if (/^(you|there|it|that|this|he|she|they|the)\b/i.test(t)) return false;
  return true;
}

export function chipsFrom(shortlist: readonly Suggestion[], phrased: readonly string[]): SuggestionOut[] {
  // Line i phrases entry i, and only if the model returned one line per entry. A model
  // that returns a different count has not rephrased the shortlist, it has written its
  // own list, and mapping those onto these actions would mislabel every button.
  const aligned = phrased.length === shortlist.length;
  return shortlist.map((sg, i) => {
    const said = aligned ? phrased[i] : undefined;
    return {
      text: said && looksLikeAnAction(said) ? said : sg.fallback,
      action: sg.affordance.action,
      mechanic: mechanicOf(sg.affordance),
      detail: sg.affordance.detail ?? "",
    };
  });
}

/** Everyone worth naming in a chip, for the client. */
export function presentNames(s: GameState): string[] {
  return npcsPresent(s, pc(s).location_id).map((e) => e.name);
}
