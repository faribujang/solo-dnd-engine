import type { GameEvent } from "../schema/event.js";
import type { GameState } from "../schema/state.js";
import type { Roll } from "../schema/common.js";
import type { LLMClient } from "../llm/client.js";
import type { Intent } from "../llm/contracts.js";
import { Narration } from "../llm/contracts.js";
import { buildContext, type BuiltContext } from "../context/build.js";
import { parseIntent } from "../llm/intent.js";
import { validateNarration, type Reject } from "../llm/validate.js";
import { npcsPresent, pc } from "../state/selectors.js";
import { answer } from "./questions.js";
import { renderSuggestionsForPrompt, suggest } from "../rules/suggest.js";
import { reduce } from "./reduce.js";
import { resolve, type Action } from "./turn.js";
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
  suggestedActions: string[];
  /** Everything the turn touched, for the debug view and the test suite. */
  debug: {
    intent: Intent | null;
    action: Action | null;
    mechanics: string | null;
    context: BuiltContext | null;
    fired: string[];
    truncated: boolean;
    promptTokens: number;
  };
}

export async function takeLLMTurn(
  llm: LLMClient,
  state: GameState,
  playerText: string,
  opts: LLMTurnOptions = {},
): Promise<LLMTurnOutcome> {
  const empty = {
    intent: null, action: null, mechanics: null, context: null,
    fired: [], truncated: false, promptTokens: 0,
  };

  // ---------------------------------------------------------- 1. intent
  const parsed = await parseIntent(llm, state, playerText);

  if (!parsed.ok) {
    // A question is answered from state and costs nothing: no event, no turn, no roll.
    if ("question" in parsed) {
      const a = answer(state, parsed.question, parsed.subject ?? undefined);
      return {
        ok: false, kind: "answer", text: a.lines.join("\n"),
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

  // ------------------------------------------------- 2. validate & resolve
  const resolution = resolve(state, parsed.action);

  if (!resolution.ok) {
    // A refused action costs no time and writes nothing. Impossible things are refused in
    // the fiction, never rolled for.
    return {
      ok: false,
      kind: "refused",
      text: resolution.reason,
      state, journal: [], rejects: [], suggestedActions: [],
      debug: { ...empty, intent: parsed.intent, action: parsed.action },
    };
  }

  opts.hooks?.onIntent?.({ intent: parsed.intent, action: parsed.action });

  // ---------------------------------------------------------- 3. reduce
  // takeTurn also runs any CPU combat turns that follow, and ends the fight when a side is
  // done, so the narrator sees the whole exchange rather than half of it.
  const played = takeTurn(state, parsed.action);
  const reduced = { state: played.state, journal: played.journal, fired: played.fired, truncated: played.truncated };
  let working = reduced.state;
  const journal: GameEvent[] = [...reduced.journal];

  // The world has moved and the dice have landed. This is the moment the serving contract
  // cares about most: whoever is listening gets the roll card NOW, and the narrator has not
  // been asked for anything yet.
  if (opts.hooks?.onMechanics) {
    await opts.hooks.onMechanics({
      state: working,
      journal: [...journal],
      mechanics: resolution.mechanics,
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
  const mechanicsOnly = (kind: "narrated" | "mechanics_only"): LLMTurnOutcome => ({
    ok: true, kind, text: resolution.mechanics,
    state: working, journal, rejects: [], suggestedActions: [],
    debug: {
      intent: parsed.intent, action: parsed.action, mechanics: resolution.mechanics,
      context: null, fired: reduced.fired, truncated: reduced.truncated, promptTokens: 0,
    },
  });

  if (opts.skipNarration) return mechanicsOnly("narrated");

  // --------------------------------------------------- 4. build context
  // Built from the world AFTER the mechanics resolved, so the narrator describes the
  // world as it now is rather than as it was when the player spoke.
  const present = npcsPresent(working, pc(working).location_id);
  const ambientBeats = (resolution.event.payload["beats"] as string[] | undefined) ?? [];

  const cpuLines = journal
    .filter((e) => e.derived_from === null && e.id !== resolution.event.id && e.actor_id && e.actor_id !== pc(working).id && e.rolls.length)
    .map((e) => `${working.entities[e.actor_id!]?.name ?? e.actor_id}: ${(e.payload as { hit?: boolean; damage?: number }).hit === undefined ? e.type : (e.payload as { hit?: boolean }).hit ? `hit for ${(e.payload as { damage?: number }).damage}` : "missed"}`);
  // Code ranks what is worth doing; the narrator only phrases it (rules/suggest.ts).
  const shortlist = suggest(working, {
    ...(opts.triedThisScene ? { triedThisScene: opts.triedThisScene } : {}),
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
    suggestions: renderSuggestionsForPrompt(shortlist),
    mechanics: [resolution.mechanics, ...cpuLines.map((l) => `Then: ${l}`), ...ambientBeats.map((b) => `Meanwhile: ${b}`)].join("\n"),
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
    narration = llm.stream && onProse
      ? await llm.stream(request, { onText: onProse })
      : await llm.complete(request);
  } catch {
    return mechanicsOnly("mechanics_only");
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
      ...resolution.event,
      id: `evt_n${String(resolution.event.turn).padStart(4, "0")}`,
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
    suggestedActions: validated.suggestedActions.length >= Math.min(2, shortlist.length)
      ? validated.suggestedActions
      : shortlist.map((x) => x.fallback),
    debug: {
      intent: parsed.intent,
      action: parsed.action,
      mechanics: resolution.mechanics,
      context,
      fired: reduced.fired,
      truncated: reduced.truncated,
      promptTokens: context.totalTokens,
    },
  };
}
