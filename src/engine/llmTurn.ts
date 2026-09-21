import type { GameEvent } from "../schema/event.js";
import type { GameState } from "../schema/state.js";
import type { Roll } from "../schema/common.js";
import type { LLMClient } from "../llm/client.js";
import type { Intent } from "../llm/contracts.js";
import { DMAnswer, Narration } from "../llm/contracts.js";
import { buildContext, type BuiltContext } from "../context/build.js";
import { parseIntent, splitCompound } from "../llm/intent.js";
import { validateNarration, type Reject } from "../llm/validate.js";
import { npcsPresent, pc } from "../state/selectors.js";
import { answer, type Answer } from "./questions.js";
import { chipsFrom, renderSuggestionsForPrompt, suggest, type SuggestionOut } from "../rules/suggest.js";
import { reduce } from "./reduce.js";
import { type Action } from "./turn.js";
import { takeTurn } from "./session.js";

/**
 * The full six-step turn.
 *
 *   1 intent      LLM      free text → a structured proposal
 *   2 resolve     CODE     legality, DC lookup, dice, costs
 *   3 reduce      CODE     event → state, cascading through the trigger DSL
 *   4 context     CODE     deterministic, budgeted prompt assembly
 *   5 narrate     LLM      prose, plus soft proposals
 *   6 commit      CODE     whitelist validation → a second journaled event
 *
 * Note what step 6 does: the narrator's accepted effects become their OWN root event in the
 * journal. That is what keeps replay exact across a non-deterministic narrator — a rebuild
 * re-applies what the model said last time rather than asking it again and getting
 * something different.
 */

/**
 * Moments in the turn a caller may want to see as they happen, rather than all at once
 * when the turn returns. They exist for one reason: the serving contract puts the roll
 * card on the player's screen BEFORE the narrator has written a word, and only the turn
 * loop knows when that moment is.
 *
 * `onMechanics` may be async. A server commits the mechanics inside it, so that a crash
 * during narration leaves a world with the dice already landed and no prose — which is
 * exactly the `mechanics_only` outcome, reached a different way.
 */
export interface TurnHooks {
  onIntent?: (info: { intent: Intent; action: Action }) => void;
  onMechanics?: (info: {
    state: GameState;
    journal: GameEvent[];
    mechanics: string;
    rolls: Roll[];
  }) => void | Promise<void>;
  /** Prose as it arrives. Only fires when the client can stream; otherwise never. */
  onProse?: (delta: string) => void;
  /** The prose streamed so far was withdrawn — a retry is about to write its own. */
  onProseReset?: () => void;
}

export interface LLMTurnOptions {
  /** Verbatim recent turns for the prompt, oldest first. */
  recent?: readonly string[];
  digests?: readonly string[];
  maxPromptTokens?: number;
  /** Skip narration; useful for tests that only care about mechanics. */
  skipNarration?: boolean;
  /** Action keys already tried this scene, so chips do not repeat. */
  triedThisScene?: readonly string[];
  /**
   * The kinds of thing the last few turns were \u2014 "talking", "moving", "handling",
   * "fighting". Supplied by the caller, which is the only layer that can see further
   * back than the turn being played. Feeds the variety rule in rules/suggest.ts.
   */
  recentGroups?: readonly string[];
  hooks?: TurnHooks;
}

export interface LLMTurnOutcome {
  ok: boolean;
  /** Prose for the player, or the clarifying question, or the refusal. */
  text: string;
  kind: "narrated" | "clarify" | "refused" | "meta" | "answer" | "mechanics_only";
  state: GameState;
  journal: GameEvent[];
  rejects: Reject[];
  suggestedActions: SuggestionOut[];
  /** Everything the turn touched, for the debug view and the test suite. */
  debug: {
    intent: Intent | null;
    action: Action | null;
    mechanics: string | null;
    context: BuiltContext | null;
    fired: string[];
    truncated: boolean;
    promptTokens: number;
    /**
     * Why the narrator was not used, when it was not.
     *
     * Swallowing this is how "the Dungeon Master could not be reached" becomes
     * unfalsifiable: the player is told prose is missing and the operator is told
     * nothing at all, with no provider, no status and no schema issue to chase. The turn
     * still stands either way — this changes nothing about the game, only about whether
     * the failure can be found.
     */
    narratorError: string | null;
  };
}

/**
 * Put an answer into the DM's mouth. Falls back to the raw lines on any failure, because
 * a question the player asked must always get something back.
 */
async function sayIt(llm: LLMClient, question: string, a: Answer): Promise<string> {
  const raw = a.lines.join("\n");
  if (a.lines.length === 0) return raw;
  try {
    const res = await llm.complete({
      role: "answer",
      system: [
        "You are the Dungeon Master, answering a question between beats. Not narrating.",
        "",
        "Answer the question in one or two sentences, second person, in your own voice.",
        "Use ONLY what is listed below — it has already been filtered to what this player",
        "knows, and anything else would be invention. Do not list the items back; do not",
        "recite everything you were given; do not add colour that is not in them.",
        "If what you were given does not answer the question, say so plainly in one line.",
        a.brief ? `Guidance: ${a.brief}` : "",
      ].filter(Boolean).join("\n"),
      user: `QUESTION: ${question}\n\nWHAT THEY KNOW:\n${a.lines.map((l: string) => `- ${l}`).join("\n")}`,
      schema: DMAnswer,
      schemaName: "DMAnswer",
      maxTokens: 220,
      temperature: 0.4,
    });
    const text = res.value.answer.trim();
    return text.length > 0 ? text : raw;
  } catch {
    return raw;
  }
}


/**
 * The same question, asked twice, with nothing having happened in between.
 *
 * "Did we get any gear from Cotter" was asked three times in one scene and answered three
 * different ways, the last of them "I cannot say" about gear the player was carrying. The
 * FACTS were identical every time — they are selected from state by code — but the prose
 * is written by a model at a non-zero temperature, so asking again rolled the dice on the
 * wording, and a DM that contradicts itself under repetition is a DM nobody can trust.
 *
 * So an answer is remembered for exactly as long as it stays true. The key carries the
 * turn and the clock, and a question costs neither, so repeats hit; anything that moves
 * the world misses and the question is answered afresh.
 *
 * Prose only. Questions write no events, so none of this reaches a save or a replay.
 */
const ANSWER_CACHE = new Map<string, string>();
const ANSWER_CACHE_MAX = 64;

function answerKey(s: GameState, kind: string, subject: string | null, asked: string): string {
  const norm = asked.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
  return [s.meta.id, s.meta.turn, s.world.world_minute, kind, subject ?? "-", norm].join("|");
}

function rememberAnswer(key: string, said: string): void {
  // Oldest out first. A Map iterates in insertion order, which is all the eviction this
  // needs: the cache exists to survive a scene, not a session.
  if (ANSWER_CACHE.size >= ANSWER_CACHE_MAX) {
    const oldest = ANSWER_CACHE.keys().next().value;
    if (oldest !== undefined) ANSWER_CACHE.delete(oldest);
  }
  ANSWER_CACHE.set(key, said);
}

export async function takeLLMTurn(
  llm: LLMClient,
  state: GameState,
  playerText: string,
  opts: LLMTurnOptions = {},
): Promise<LLMTurnOutcome> {
  const empty = {
    intent: null, action: null, mechanics: null, context: null,
    fired: [], truncated: false, promptTokens: 0, narratorError: null };

  // ---------------------------------------------------------- 1. intent
  // Two instructions in one line are common and used to cost the player the second one.
  // Split BEFORE parsing, so the first clause is read on its own terms.
  const compound = splitCompound(playerText);
  const firstText = compound ? compound[0] : playerText;
  const rest = compound ? compound[1] : null;

  const parsed = await parseIntent(llm, state, firstText);

  if (!parsed.ok) {
    // A question is answered from state and costs nothing: no event, no turn, no roll.
    if ("question" in parsed) {
      const a = answer(state, parsed.question, parsed.subject ?? undefined, playerText);

      /**
       * Code selects, the DM speaks.
       *
       * The selection above is the part that must not be guessed at — it is filtered by
       * what this player actually knows. But handing those lines to the player raw is how
       * "did we get any gear from Cotter" came back as a list of true statements and no
       * answer. So the DM is given exactly those lines and asked to answer the question
       * with them, and nothing else.
       *
       * It is still not a turn: no event, no roll, no time. If the model is unreachable
       * the lines go out as they always did, which is worse prose and the same facts.
       */
      // Asked this already, and nothing has happened since? Then the answer is the one
      // already given. See ANSWER_CACHE.
      const key = answerKey(state, parsed.question, parsed.subject ?? null, playerText);
      const said = ANSWER_CACHE.get(key) ?? await sayIt(llm, playerText, a);
      rememberAnswer(key, said);
      return {
        ok: false, kind: "answer", text: said,
        state, journal: [], rejects: [], suggestedActions: [],
        debug: { ...empty, intent: parsed.intent },
      };
    }
    return {
      ok: false,
      kind: parsed.clarify === "__meta__" ? "meta" : "clarify",
      text: parsed.clarify === "__meta__" ? "" : parsed.clarify,
      state, journal: [], rejects: [], suggestedActions: [],
      debug: { ...empty, intent: parsed.intent },
    };
  }

  opts.hooks?.onIntent?.({ intent: parsed.intent, action: parsed.action });

  // ------------------------------------------------- 2. resolve and reduce
  // ONE call. `resolve` is not a query — it rolls the dice — so asking it whether an
  // action is legal and then playing the action resolves twice, and under `karmic` or
  // `true` dice the two draw different entropy. The turn keeps the second roll and the
  // player is shown the first: a roll card and a summary that disagree, and, when the
  // narrator is down, a fallback line reporting a number no event contains.
  //
  // takeTurn also runs any CPU combat turns that follow, and ends the fight when a side
  // is done, so the narrator sees the whole exchange rather than half of it.
  const played = takeTurn(state, parsed.action);

  if (!played.ok || !played.root) {
    // A refused action costs no time and writes nothing. Impossible things are refused in
    // the fiction, never rolled for.
    return {
      ok: false,
      kind: "refused",
      text: played.message,
      state, journal: [], rejects: [], suggestedActions: [],
      debug: { ...empty, intent: parsed.intent, action: parsed.action },
    };
  }

  const root = played.root;
  const reduced = { state: played.state, journal: played.journal, fired: played.fired, truncated: played.truncated };
  let working = reduced.state;
  const journal: GameEvent[] = [...reduced.journal];
  let mechanics = played.message;

  /**
   * "Thank Severi and go to the Fetterlock" is two instructions.
   *
   * The game used to play the first and silently drop the second, so the player typed the
   * second one again having already said it. The second clause is parsed against the
   * world the FIRST one left behind, which is the only correct order: where you can walk
   * depends on what just happened.
   *
   * Chained at most once, never into or inside a fight, and abandoned the moment a clause
   * is refused \u2014 the first half still stands, and the refusal is reported rather than
   * swallowed. A chain that pushed on through a refusal would be guessing at what the
   * player meant after their plan stopped working.
   */
  if (rest && !working.combat) {
    const second = await parseIntent(llm, working, rest);
    if (second.ok) {
      const alsoPlayed = takeTurn(working, second.action);
      if (alsoPlayed.ok && alsoPlayed.root) {
        working = alsoPlayed.state;
        journal.push(...alsoPlayed.journal);
        reduced.fired = [...reduced.fired, ...alsoPlayed.fired];
        mechanics = `${mechanics}\nThen: ${alsoPlayed.message}`;
        opts.hooks?.onIntent?.({ intent: second.intent, action: second.action });
      } else {
        mechanics = `${mechanics}\nThen: ${alsoPlayed.message}`;
      }
    } else if ("clarify" in second) {
      mechanics = `${mechanics}\nThen: ${second.clarify}`;
    }
  }

  // The world has moved and the dice have landed. This is the moment the serving contract
  // cares about most: whoever is listening gets the roll card NOW, and the narrator has not
  // been asked for anything yet.
  if (opts.hooks?.onMechanics) {
    await opts.hooks.onMechanics({
      state: working,
      journal: [...journal],
      mechanics: mechanics,
      rolls: journal.flatMap((e) => e.rolls),
    });
  }

  /**
   * The turn WITHOUT prose.
   *
   * This is the fallback path when the narrator is unavailable, and it is the reason the
   * one rule is worth its cost: the dice have already rolled and the world has already
   * moved, so a dead provider costs the player a paragraph, never a turn. Throwing here
   * would discard `working` — and under `karmic` or `true` dice, retrying would roll a
   * DIFFERENT number for a check the player has already watched resolve.
   */
  const mechanicsOnly = (kind: "narrated" | "mechanics_only", why: string | null = null): LLMTurnOutcome => ({
    ok: true, kind, text: mechanics,
    state: working, journal, rejects: [], suggestedActions: [],
    debug: {
      intent: parsed.intent, action: parsed.action, mechanics: mechanics,
      context: null, fired: reduced.fired, truncated: reduced.truncated, promptTokens: 0,
      narratorError: why,
    },
  });

  if (opts.skipNarration) return mechanicsOnly("narrated");

  // --------------------------------------------------- 4. build context
  // Built from the world AFTER the mechanics resolved, so the narrator describes the
  // world as it now is rather than as it was when the player spoke.
  const present = npcsPresent(working, pc(working).location_id);
  const ambientBeats = (root.payload["beats"] as string[] | undefined) ?? [];

  const cpuLines = journal
    .filter((e) => e.derived_from === null && e.id !== root.id && e.actor_id && e.actor_id !== pc(working).id && e.rolls.length)
    .map((e) => `${working.entities[e.actor_id!]?.name ?? e.actor_id}: ${(e.payload as { hit?: boolean; damage?: number }).hit === undefined ? e.type : (e.payload as { hit?: boolean }).hit ? `hit for ${(e.payload as { damage?: number }).damage}` : "missed"}`);
  // Code ranks what is worth doing; the narrator only phrases it (rules/suggest.ts).
  /**
   * What this turn just put in front of the player.
   *
   * `suggest` has always scored "just became possible" highest and nothing ever told it
   * what was new, so the top of the list was the same every turn — read the weather, ask
   * somebody about nothing. A shortlist that ignores the last thing that happened makes
   * the player the follower rather than the lead, because the game is never pointing at
   * what they just found out.
   */
  const newThisTurn = [
    ...root.target_ids,
    ...journal.flatMap((e) => [
      ...e.target_ids,
      ...e.direct_effects.flatMap((eff) => {
        const f = eff as Record<string, unknown>;
        return [f["entity_id"], f["location_id"], f["fact_id"], f["quest_id"], ...(Array.isArray(f["subjects"]) ? f["subjects"] : [])];
      }),
    ]),
  ].filter((x): x is string => typeof x === "string" && x.length > 0);

  const shortlist = suggest(working, {
    ...(opts.triedThisScene ? { triedThisScene: opts.triedThisScene } : {}),
    newThisTurn: [...new Set(newThisTurn)],
    // What the last few turns WERE, so four turns of talking push the bar elsewhere.
    ...(opts.recentGroups ? { recentGroups: opts.recentGroups } : {}),
  });

  // Companions who spoke this turn. The reducer already wrote their line and moved their
  // opinion; the narrator gets to say it better.
  const companionLines = journal
    .filter((e) => e.type === "dialogue" && typeof e.payload["said"] === "string" && e.payload["reacting_to"])
    .map((e) => ({
      name: working.entities[e.actor_id ?? ""]?.name ?? "A companion",
      sign: String(e.payload["approval"] ?? "mixed"),
      to: String(e.payload["reacting_to"] ?? "").replace(/_/g, " "),
      line: String(e.payload["said"]),
    }));

  const context = buildContext(working, {
    // The narrator answers what was said, not what the parser made of it.
    playerText,
    suggestions: renderSuggestionsForPrompt(shortlist),
    mechanics: [mechanics, ...cpuLines.map((l) => `Then: ${l}`), ...ambientBeats.map((b) => `Meanwhile: ${b}`)].join("\n"),
    ...(opts.recent ? { recent: opts.recent } : {}),
    ...(opts.digests ? { digests: opts.digests } : {}),
    ...(opts.maxPromptTokens ? { maxTokens: opts.maxPromptTokens } : {}),
    verboseLocation: parsed.action.type === "look",
    ...(companionLines.length ? { companionLines } : {}),
  });

  // -------------------------------------------------------- 5. narrate
  // The only step that can fail for reasons outside the engine, and the only one whose
  // failure the player can survive. Mechanics already happened; prose is decoration.
  let narration;
  try {
    const request = {
      role: "narrate" as const,
      system: context.system,
      user: context.user,
      schema: Narration,
      schemaName: "Narration",
      maxTokens: 1200,
      temperature: 0.8,
    };
    // Streamed when someone is listening and the client can; the resolved value is the
    // same either way, which is what keeps the replay tests honest across both paths.
    const onProse = opts.hooks?.onProse;
    const onProseReset = opts.hooks?.onProseReset;
    narration = llm.stream && onProse
      ? await llm.stream(request, {
          onText: onProse,
          ...(onProseReset ? { onReset: onProseReset } : {}),
        })
      : await llm.complete(request);
  } catch (err) {
    // The failure is reported, not rethrown. Mechanics already landed; prose is
    // decoration, and a dead provider must never cost a turn that has been played.
    return mechanicsOnly("mechanics_only", err instanceof Error ? err.message : String(err));
  }

  // ------------------------------------------------ 6. commit proposals
  const validated = validateNarration(working, narration.value, {
    presentEntityIds: [pc(working).id, ...present.map((e) => e.id)],
    locationId: pc(working).location_id,
  });

  if (validated.effects.length > 0) {
    // The narrator's accepted effects are journaled as their own root event. Replay then
    // reproduces this turn exactly without calling a model at all.
    const narratorEvent: GameEvent = {
      ...root,
      id: `evt_n${String(root.turn).padStart(4, "0")}`,
      type: "effect",
      target_ids: [],
      payload: { source: "narrator" },
      rolls: [],
      direct_effects: validated.effects,
      attitude_impact: [],
      witnesses: [],
      fact_ids: [],
      duration_minutes: 0,
      world_minute: working.world.world_minute,
      rng_nonce: "",
      derived_from: null,
      trigger_id: null,
    };

    const applied = reduce(working, narratorEvent);
    working = applied.state;
    journal.push(...applied.journal);
    reduced.fired.push(...applied.fired);
  }

  return {
    ok: true,
    kind: "narrated",
    text: validated.narration,
    state: working,
    journal,
    rejects: validated.rejects,
    // The model phrases the shortlist; if it declined or invented, fall back to the
    // ranked labels so the chips never go missing.
    // The narrator phrases; the ranking decides what the chip DOES. Both travel together
    // now, so tapping one cannot mean something other than what it said.
    suggestedActions: chipsFrom(shortlist, validated.suggestedActions),
    debug: {
      intent: parsed.intent,
      action: parsed.action,
      mechanics: mechanics,
      context,
      fired: reduced.fired,
      truncated: reduced.truncated,
      promptTokens: context.totalTokens,
      narratorError: null,
    },
  };
}
