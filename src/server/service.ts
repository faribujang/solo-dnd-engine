import path from "node:path";
import { z } from "zod";
import type { GameEvent } from "../schema/event.js";
import type { GameState } from "../schema/state.js";
import type { CampaignSummary, FeedRow, StateStore } from "../state/store.js";
import type { LLMClient, LLMRequest, LLMResponse, StreamHandlers } from "../llm/client.js";
import { takeLLMTurn } from "../engine/llmTurn.js";
import { answer, classify } from "../engine/questions.js";
import { rewind } from "../engine/rollback.js";
import type { Action } from "../engine/turn.js";
import { preview, type Preview } from "../rules/preview.js";
import { actionKeyOf } from "../rules/suggest.js";
import { Rng, seedToState } from "../rules/rng.js";
import { BACKGROUNDS, CLASSES, RACES } from "../content/srd/data.js";
import { BACKGROUND_SOCIAL } from "../rules/backgrounds.js";
import { changesBetween } from "../rules/changes.js";
import { loadCampaign } from "../content/loadCampaign.js";
import {
  applyCreation, initialStateFor, CreateSaveRequest, CreationError, type Creation,
} from "../content/createSave.js";
import {
  combatModel, rollCard, screen, timelineModel,
  type CombatModel, type ScreenModel, type TimelineRowModel,
} from "../view/models.js";
import { linkText, type TextSpan } from "../view/link.js";
import {
  BudgetPolicy, CostLedgerEntry, RewindRequest, TurnRequest, type TurnFrame,
} from "./contract.js";

/**
 * THE GAME, AS A SERVICE.
 *
 * This is the implementation of server/contract.ts, kept free of any HTTP framework so it
 * can be driven by a test as easily as by a socket. Every method either reads a view model
 * or submits a turn; nothing here reaches into GameState on a client's behalf, because the
 * client never sees GameState at all.
 *
 * Three things it is responsible for that the engine is not:
 *
 *   THE LOCK.     One turn at a time per save. Two players, two tabs, one device that
 *                 double-tapped — the second waits, then finds the version moved, and is
 *                 refused rather than applied to a world that no longer exists.
 *
 *   THE VERSION.  The journal's length. Free, monotonic, and already the truth.
 *
 *   THE ORDER.    Mechanics are committed and sent BEFORE the narrator is called. If the
 *                 model dies mid-sentence the save is already consistent; the player is
 *                 down a paragraph, never a turn.
 */

// ────────────────────────────────────────────────────────────── frames

/**
 * The contract's frames, plus three the implementation needed: a conflict inside a stream
 * (the HTTP layer catches most of these before the stream opens, but the lock can still
 * find one), a clarifying question back to the player, and a richer `done`.
 */
export type Frame =
  | Exclude<TurnFrame, { t: "done" }>
  | {
      t: "done";
      suggestions: string[];
      version: number;
      rejects: number;
      /** `mechanics_only` when the narrator was skipped or failed. The turn still happened. */
      mode: "narrated" | "mechanics_only";
      /** A line for the player about why, when the mode is not the normal one. */
      note: string | null;
      turn: number;
    }
  | { t: "conflict"; actual_version: number; message: string }
  | { t: "clarify"; question: string };

export type ScreenView = ScreenModel & { combat: CombatModel | null };

export interface Snapshot {
  save_id: string;
  title: string;
  turn: number;
  version: number;
  screen: ScreenView;
  recent: FeedRow[];
  session_zero: GameState["meta"]["session_zero"];
  player: { id: string; name: string };
}

export interface VersionConflict {
  error: "version_conflict";
  actual_version: number;
  message: string;
}

export class ServiceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ServiceError";
  }
}

export interface ServiceOptions {
  /** Where authored campaigns live. Default `content/campaign`. */
  contentRoot?: string;
  budget?: Partial<z.input<typeof BudgetPolicy>>;
  /** How many recent exchanges the narrator sees. */
  recentTurns?: number;
  now?: () => number;
}

interface SaveContext {
  state: GameState;
  version: number;
  /** Action keys reached for this scene, so chips rotate. Reset when the scene changes. */
  tried: string[];
  sceneId: string;
  /** Tokens spent on this save so far, for the budget ceiling. */
  tokens: number;
  /** Turn timestamps in the last minute, for the loop guard. */
  recentAt: number[];
}

// ─────────────────────────────────────────────────────────── the service

export class GameService {
  private readonly contentRoot: string;
  private readonly budget: z.infer<typeof BudgetPolicy>;
  private readonly recentTurns: number;
  private readonly now: () => number;
  private readonly ctx = new Map<string, SaveContext>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly llm: RecordingLLM;

  constructor(private readonly store: StateStore, llm: LLMClient, opts: ServiceOptions = {}) {
    this.contentRoot = opts.contentRoot ?? path.join("content", "campaign");
    this.budget = BudgetPolicy.parse(opts.budget ?? {});
    this.recentTurns = opts.recentTurns ?? 6;
    this.now = opts.now ?? Date.now;
    this.llm = new RecordingLLM(llm);
  }

  // ───────────────────────────────────────────────── saves

  listSaves(): Promise<CampaignSummary[]> {
    return this.store.listCampaigns();
  }

  /** What a new-game screen needs: campaigns to pick, and the SRD options for a character. */
  async catalogue(): Promise<{
    campaigns: Array<{ id: string; title: string; premise: string }>;
    races: Array<{ id: string; name: string }>;
    classes: Array<{ id: string; name: string; hit_die: number; skill_choices: string[]; skill_count: number; caster: string }>;
    backgrounds: Array<{ id: string; name: string; blurb: string; local: string; skills: string[]; campaigns: string[] }>;
    /** "<campaign>:<background>" -> what that campaign calls this life. */
    background_local: Record<string, string>;
  }> {
    const { promises: fs } = await import("node:fs");
    const campaigns: Array<{ id: string; title: string; premise: string }> = [];
    /** background id -> the campaigns that offer it. Empty list on a campaign means all. */
    const offeredIn = new Map<string, string[]>();
    /** "<campaign>:<background>" -> that campaign's one-line gloss. */
    const localGloss: Record<string, string> = {};
    let dirs: string[] = [];
    try { dirs = await fs.readdir(this.contentRoot); } catch { dirs = []; }
    for (const d of dirs.sort()) {
      try {
        const s = await loadCampaign(path.join(this.contentRoot, d));
        const camp = s.meta.campaign_id ? s.campaigns[s.meta.campaign_id] : undefined;
        campaigns.push({ id: d, title: s.meta.title, premise: camp?.premise ?? "" });
        const offered = s.meta.backgrounds.length
          ? s.meta.backgrounds
          : Object.values(BACKGROUNDS).map((b) => ({ id: b.id, local: "" }));
        for (const b of offered) {
          offeredIn.set(b.id, [...(offeredIn.get(b.id) ?? []), d]);
          if (b.local) localGloss[`${d}:${b.id}`] = b.local;
        }
      } catch { /* not a campaign directory */ }
    }
    return {
      campaigns,
      races: Object.values(RACES).map((r) => ({ id: r.id, name: r.name })),
      classes: Object.values(CLASSES).map((c) => ({
        id: c.id, name: c.name, hit_die: c.hit_die, skill_choices: c.skill_choices, skill_count: c.skill_count, caster: c.caster,
      })),
      // Every background the SRD has, plus which campaigns offer it and what each of
       // those calls it. The client filters by the campaign being started, so a creation
       // screen never offers a life the opening scene contradicts.
      backgrounds: Object.values(BACKGROUNDS).map((b) => ({
        id: b.id,
        name: b.name,
        blurb: BACKGROUND_SOCIAL[b.id]?.blurb ?? "",
        local: "",
        skills: b.skills,
        campaigns: offeredIn.get(b.id) ?? [],
      })),
      background_local: localGloss,
    };
  }

  async createSave(raw: unknown): Promise<{ save_id: string; version: number }> {
    const req = CreateSaveRequest.parse(raw);
    const saveId = req.save_id ?? `${req.campaign}_${Math.random().toString(36).slice(2, 8)}`;
    if (await this.store.exists(saveId)) throw new ServiceError(409, `A save called "${saveId}" already exists.`);

    let base: GameState;
    try {
      base = await loadCampaign(path.join(this.contentRoot, req.campaign));
    } catch {
      throw new ServiceError(404, `No campaign "${req.campaign}".`);
    }

    const creation: Creation = {
      save_id: saveId,
      campaign: req.campaign,
      created_at: new Date(this.now()).toISOString(),
      ...(req.session_zero ? { session_zero: req.session_zero } : {}),
      ...(req.character ? { character: req.character } : {}),
    };

    let state: GameState;
    try {
      state = applyCreation(base, creation);
    } catch (err) {
      if (err instanceof CreationError) throw new ServiceError(400, err.message);
      throw err;
    }

    await this.store.create(saveId, state);
    await this.store.writeCreation(saveId, creation);
    await this.store.appendFeed(saveId, [{
      turn: 0, version: 0, kind: "system", rolls: [], at: creation.created_at,
      text: `${state.meta.title} begins.`,
    }]);
    return { save_id: saveId, version: 0 };
  }

  async snapshot(saveId: string): Promise<Snapshot> {
    const c = await this.context(saveId);
    return this.snapshotOf(saveId, c);
  }

  private async snapshotOf(saveId: string, c: SaveContext): Promise<Snapshot> {
    const me = c.state.entities[c.state.meta.pc_id]!;
    return {
      save_id: saveId,
      title: c.state.meta.title,
      turn: c.state.meta.turn,
      version: c.version,
      screen: this.view(c.state),
      recent: await this.store.readFeed(saveId, 80),
      session_zero: c.state.meta.session_zero,
      player: { id: me.id, name: me.name },
    };
  }

  // ───────────────────────────────────────────────── the turn

  /**
   * One POST, one stream of frames, in the contract's order. Returns when the stream is
   * complete; every path through here ends in exactly one terminal frame (`done`,
   * `answer`, `refused`, `clarify`, `conflict`, or `error`).
   */
  async turn(saveId: string, raw: unknown, emit: (f: Frame) => void): Promise<void> {
    const req = TurnRequest.parse({ ...(raw as object), save_id: saveId });

    await this.locked(saveId, async () => {
      const c = await this.context(saveId);

      if (req.expect_version !== c.version) {
        emit({
          t: "conflict", actual_version: c.version,
          message: `The world moved since you last looked (you had ${req.expect_version}, it is at ${c.version}). Take a look before acting.`,
        });
        return;
      }

      // The loop guard. A client stuck in a retry loop burns money at machine speed.
      const t = this.now();
      c.recentAt = c.recentAt.filter((x) => t - x < 60_000);
      if (c.recentAt.length >= this.budget.max_turns_per_minute) {
        emit({ t: "error", message: "Too many turns in a minute. Slow down — the world will keep.", retryable: true });
        return;
      }
      c.recentAt.push(t);

      // The ceiling. Past it the narrator is not called; the game goes on in mechanics.
      const overBudget = this.budget.max_tokens_per_save > 0 && c.tokens >= this.budget.max_tokens_per_save;

      const recent = await this.recentForPrompt(saveId);
      // The world as it stood before this turn. Held for the diff at the end: the
      // player is owed one receipt for the turn, not one for the dice and another for
      // the prose.
      const worldBefore = c.state;
      const before = c.version;
      let committed = 0;
      let landedVersion = before;

      this.llm.begin(c.state.meta.turn + 1);

      const out = await withTimeout(
        takeLLMTurn(this.llm, c.state, req.text, {
          recent,
          triedThisScene: c.tried,
          ...(overBudget ? { skipNarration: true } : {}),
          hooks: {
            onIntent: (i) => emit({ t: "intent", action: i.action, confidence: i.intent.confidence }),
            onMechanics: async (m) => {
              // Committed BEFORE the narrator is asked. The frame's version is true when sent.
              await this.store.commit(saveId, m.journal, m.state);
              committed = m.journal.length;
              landedVersion = before + committed;
              emit({ t: "mechanics", rolls: m.rolls.map(rollCard), summary: m.mechanics, version: landedVersion });
              emit({ t: "state", screen: this.view(m.state) });
            },
            onProse: (delta) => emit({ t: "prose", delta }),
            onProseReset: () => emit({ t: "prose_reset" }),
          },
        }),
        this.budget.turn_timeout_ms,
      ).catch((err: unknown) => err);

      if (out instanceof Error || !isOutcome(out)) {
        // Only reachable if something threw outside the narrator's own guarded call —
        // the intent parser, or a genuine bug. Mechanics that already landed stay landed.
        if (committed > 0) {
          const s = await this.store.load(saveId);
          this.ctx.set(saveId, { ...c, state: s, version: landedVersion });
        }
        const msg = out instanceof Error ? out.message : "The turn failed.";
        emit({ t: "error", message: msg, retryable: /timed out|unreachable|ECONN/i.test(msg) });
        return;
      }

      const at = new Date(this.now()).toISOString();
      const costs = this.llm.drain();
      if (costs.length) {
        await this.store.appendCosts(saveId, costs);
        c.tokens += costs.reduce((n, r) => n + r.input_tokens + r.output_tokens, 0);
      }

      if (!out.ok) {
        if (out.kind === "answer") {
          const lines = out.text.split("\n").filter(Boolean);
          // Not a turn — but it is part of the conversation, and the transcript keeps it.
          await this.store.appendFeed(saveId, [
            { turn: c.state.meta.turn, version: c.version, kind: "player", text: req.text, rolls: [], at },
            { turn: c.state.meta.turn, version: c.version, kind: "answer", text: lines.join("\n"), rolls: [], at },
          ]);
          emit({ t: "answer", lines });
        } else if (out.kind === "clarify") {
          emit({ t: "clarify", question: out.text });
        } else if (out.kind === "meta") {
          emit({ t: "answer", lines: ["Your sheet has everything you are carrying."] });
        } else {
          emit({ t: "refused", reason: out.text });
        }
        return;
      }

      // The narrator's own effects, and anything else the mechanics hook did not see.
      const rest = out.journal.slice(committed);
      await this.store.commit(saveId, rest, out.state);
      const version = before + out.journal.length;

      const rolls = out.journal.flatMap((e) => e.rolls).map(rollCard);
      const rows: FeedRow[] = [
        { turn: out.state.meta.turn, version, kind: "player", text: req.text, rolls: [], at },
        {
          turn: out.state.meta.turn, version,
          kind: out.kind === "mechanics_only" ? "mechanics" : "narration",
          text: out.text, rolls, at,
        },
      ];
      await this.store.appendFeed(saveId, rows);
      if (out.rejects.length) await this.store.appendRejects(saveId, out.rejects);

      // Chips turn over rather than repeat, and a new scene starts the count again.
      const sceneId = out.state.world.scene_id;
      let tried = sceneId === c.sceneId ? [...c.tried] : [];
      if (out.debug.action) {
        const k = actionKeyOf({ action: out.debug.action } as never);
        if (!tried.includes(k)) tried.push(k);
        if (tried.length > 12) tried = tried.slice(-12);
      }
      this.ctx.set(saveId, { ...c, state: out.state, version, tried, sceneId });

      // The one line that makes a silent narrator diagnosable. It does not reach the
      // player — they were already told the prose is missing — it reaches whoever is
      // watching the server wondering why.
      if (out.debug.narratorError) {
        console.warn(`[narrator] ${saveId} turn ${out.state.meta.turn}: ${out.debug.narratorError}`);
      }

      emit({ t: "state", screen: this.view(out.state) });

      // One receipt for the whole turn: mechanics, cascades and the narrator's own
      // accepted effects, diffed against the world as it stood before any of it ran.
      emit({ t: "changed", changes: changesBetween(worldBefore, out.state) });

      emit({
        t: "done",
        suggestions: out.suggestedActions,
        version,
        rejects: out.rejects.length,
        // `skipNarration` comes back as kind "narrated" — it is the flag tests use for a
        // turn they did not want prose from. The service knows better: it is the thing
        // that switched the narrator off, so it names the mode rather than asking.
        mode: overBudget || out.kind === "mechanics_only" ? "mechanics_only" : "narrated",
        note: overBudget
          ? "This save has reached its narration budget. The dice still roll; the prose has stopped."
          : out.kind === "mechanics_only" ? "The Dungeon Master could not be reached. The turn stands; only the words are missing." : null,
        turn: out.state.meta.turn,
      });
    });
  }

  // ───────────────────────────────────────── reads that change nothing

  /** A question to the DM. Answered from state, instantly, without a model. */
  async ask(saveId: string, text: string): Promise<{ lines: string[]; understood: boolean }> {
    const c = await this.context(saveId);
    const q = classify(text);
    if (!q) return { lines: ["Ask about your surroundings, who is here, what you can reach, how hurt something is, what you know, what you are carrying, or the time."], understood: false };
    const a = answer(c.state, q.kind, q.subject);
    return { lines: a.lines, understood: true };
  }

  async preview(saveId: string, action: unknown): Promise<Preview> {
    const c = await this.context(saveId);
    return preview(c.state, action as Action);
  }

  async history(saveId: string): Promise<{ rows: TimelineRowModel[]; version: number; turn: number }> {
    const c = await this.context(saveId);
    const journal = await this.store.readJournal(saveId);
    return { rows: timelineModel(c.state, journal), version: c.version, turn: c.state.meta.turn };
  }

  rejects(saveId: string): Promise<unknown[]> {
    return this.store.readRejects(saveId);
  }

  async costs(saveId: string): Promise<{ rows: unknown[]; total_tokens: number; ceiling: number }> {
    const rows = await this.store.readCosts(saveId);
    return { rows, total_tokens: sumTokens(rows), ceiling: this.budget.max_tokens_per_save };
  }

  /** Entity links for a piece of prose, for a client that wants to re-link older feed rows. */
  async link(saveId: string, text: string): Promise<TextSpan[]> {
    const c = await this.context(saveId);
    return linkText(c.state, text);
  }

  // ───────────────────────────────────────────────── rewind

  async rewind(saveId: string, raw: unknown): Promise<Snapshot | VersionConflict> {
    const req = RewindRequest.parse({ ...(raw as object), save_id: saveId });
    return this.locked(saveId, async () => {
      const c = await this.context(saveId);
      if (req.expect_version !== c.version) {
        return { error: "version_conflict", actual_version: c.version, message: "The world moved since you last looked." } as VersionConflict;
      }
      if (req.to_turn >= c.state.meta.turn) throw new ServiceError(400, `Already at or before turn ${req.to_turn}.`);

      const initial = await initialStateFor(this.store, this.contentRoot, saveId, c.state.meta.content_dir || saveId);
      initial.meta.session_zero = c.state.meta.session_zero;
      const journal = await this.store.readJournal(saveId);
      const back = rewind(initial, journal, req.to_turn);

      // Nothing is destroyed. What is dropped is parked first, so the rewind can be undone.
      await this.store.archiveBranch(saveId, back.removed, `from-turn-${c.state.meta.turn}`);
      await this.store.writeJournal(saveId, back.kept);
      await this.store.commit(saveId, [], back.state);
      await this.store.truncateFeed(saveId, req.to_turn);

      // Cascades are regenerated by replay, so the new version is the replayed journal.
      const version = (await this.store.readJournal(saveId)).length;
      const next: SaveContext = { ...c, state: back.state, version, tried: [], sceneId: back.state.world.scene_id };
      this.ctx.set(saveId, next);
      await this.store.appendFeed(saveId, [{
        turn: back.state.meta.turn, version, kind: "system", rolls: [], at: new Date(this.now()).toISOString(),
        text: `Rewound to turn ${req.to_turn}. ${back.removed.length} event(s) set aside, not deleted.`,
      }]);
      return this.snapshotOf(saveId, next);
    });
  }

  // ───────────────────────────────────────────────── internals

  private view(s: GameState): ScreenView {
    // A deterministic Rng so enemy intent is a stable preview, not a fresh dice roll.
    const rng = new Rng(seedToState(`${s.meta.seed}|view|${s.meta.turn}`));
    return { ...screen(s), combat: combatModel(s, rng) };
  }

  private async context(saveId: string): Promise<SaveContext> {
    const have = this.ctx.get(saveId);
    if (have) return have;
    if (!(await this.store.exists(saveId))) throw new ServiceError(404, `No save "${saveId}".`);
    const state = await this.store.load(saveId);
    const journal = await this.store.readJournal(saveId);
    const tokens = sumTokens(await this.store.readCosts(saveId));
    const c: SaveContext = { state, version: journal.length, tried: [], sceneId: state.world.scene_id, tokens, recentAt: [] };
    this.ctx.set(saveId, c);
    return c;
  }

  /** The narrator's memory of the last few exchanges, from the transcript. */
  private async recentForPrompt(saveId: string): Promise<string[]> {
    const rows = await this.store.readFeed(saveId, this.recentTurns * 3);
    const out: string[] = [];
    let said = "";
    for (const r of rows) {
      if (r.kind === "player") said = r.text;
      else if (r.kind === "narration" || r.kind === "mechanics") { out.push(`> ${said}\n${r.text}`); said = ""; }
    }
    return out.slice(-this.recentTurns);
  }

  /** Serialise work on one save. Other saves proceed. */
  private locked<T>(saveId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(saveId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(saveId, run.catch(() => undefined));
    return run;
  }
}

// ──────────────────────────────────────────────────── cost recording

/**
 * Wraps the client so every call lands in the cost ledger. The turn number is stamped by
 * the service before each turn, since the client has no idea what a turn is.
 */
class RecordingLLM implements LLMClient {
  readonly name: string;
  private turn = 0;
  private rows: z.infer<typeof CostLedgerEntry>[] = [];

  constructor(private readonly inner: LLMClient) {
    this.name = inner.name;
  }

  begin(turn: number): void { this.turn = turn; }

  drain(): z.infer<typeof CostLedgerEntry>[] {
    const out = this.rows;
    this.rows = [];
    return out;
  }

  async complete<T>(req: LLMRequest<T>): Promise<LLMResponse<T>> {
    const res = await this.inner.complete(req);
    this.record(req, res);
    return res;
  }

  async stream<T>(req: LLMRequest<T>, on: StreamHandlers): Promise<LLMResponse<T>> {
    const res = this.inner.stream ? await this.inner.stream(req, on) : await this.inner.complete(req);
    if (!this.inner.stream) {
      const text = (res.value as { narration?: unknown } | null)?.narration;
      if (typeof text === "string" && on.onText) on.onText(text);
    }
    this.record(req, res);
    return res;
  }

  private record<T>(req: LLMRequest<T>, res: LLMResponse<T>): void {
    this.rows.push({
      turn: this.turn, role: req.role, provider: res.provider, model: res.model,
      input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens, ms: Math.round(res.ms),
    });
  }
}

// ─────────────────────────────────────────────────────────── helpers

/** What a save has spent so far. Rows that do not parse are somebody else's problem. */
function sumTokens(rows: readonly unknown[]): number {
  let n = 0;
  for (const r of rows) {
    const p = CostLedgerEntry.safeParse(r);
    if (p.success) n += p.data.input_tokens + p.data.output_tokens;
  }
  return n;
}

function isOutcome(x: unknown): x is Awaited<ReturnType<typeof takeLLMTurn>> {
  return !!x && typeof x === "object" && "kind" in x && "state" in x;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The turn timed out after ${Math.round(ms / 1000)}s.`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}
