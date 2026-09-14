import { z } from "zod";

/**
 * THE SERVING CONTRACT.
 *
 * No HTTP server here — that is implementation, and it wants a test loop. What is here is
 * the part that is expensive to get wrong and cheap to get right on paper: what a turn is
 * over a network, how two tabs are prevented from corrupting a save, and how prose that
 * takes four seconds reaches a player who has already been told whether they hit.
 *
 * Three decisions this encodes, each of which is easy to regret later:
 *
 *   1. MECHANICS FIRST, PROSE STREAMED. The dice resolve in microseconds and the narration
 *      takes seconds. A player should never wait on the narrator to learn whether they hit
 *      — the roll card is sent immediately and the prose arrives after it, streaming.
 *
 *   2. OPTIMISTIC CONCURRENCY ON THE JOURNAL. Event sourcing already gives us a version
 *      number for free: the journal's length. A turn submitted against a stale length is
 *      rejected rather than merged, because two turns interleaved is a corrupted world and
 *      there is no sensible automatic resolution.
 *
 *   3. THE SERVER OWNS THE STATE. The client holds view models, never `GameState`. It
 *      cannot compute an outcome, so it cannot disagree with one — which is the same
 *      reason the narrator does not hold state.
 */

// ────────────────────────────────────────────────────────────── requests

export const TurnRequest = z.object({
  save_id: z.string(),
  /** What the player typed. Free text; the intent parser handles it. */
  text: z.string().min(1).max(2000),
  /**
   * The journal length the client last saw. A mismatch means someone else moved the world
   * — another tab, another device — and the turn is refused rather than applied blind.
   */
  expect_version: z.number().int().nonnegative(),
  /** Set when the player tapped a chip or a bar entry rather than typing. */
  action_hint: z.unknown().optional(),
});
export type TurnRequest = z.infer<typeof TurnRequest>;

export const AskRequest = z.object({
  save_id: z.string(),
  text: z.string().min(1).max(500),
});
export type AskRequest = z.infer<typeof AskRequest>;

export const PreviewRequest = z.object({
  save_id: z.string(),
  /** An Action, as the affordance bar produced it. */
  action: z.unknown(),
});
export type PreviewRequest = z.infer<typeof PreviewRequest>;

export const RewindRequest = z.object({
  save_id: z.string(),
  to_turn: z.number().int().nonnegative(),
  expect_version: z.number().int().nonnegative(),
});
export type RewindRequest = z.infer<typeof RewindRequest>;

// ───────────────────────────────────────────────────────── the turn stream
//
// A turn is one POST that returns a stream of these, in this order. Server-sent events
// are the right shape: one direction, text, and they survive a proxy.

export type TurnFrame =
  /** Immediately. What the player asked for, as the parser understood it. */
  | { t: "intent"; action: unknown; confidence: number }
  /**
   * Immediately after resolution — BEFORE the narrator has written a word. This is the
   * frame that makes the game feel fast: the roll card is on screen while the prose is
   * still being written.
   */
  | { t: "mechanics"; rolls: unknown[]; summary: string; version: number }
  /** The world after the dice, so bars and pips move before the prose lands. */
  | { t: "state"; screen: unknown }
  /** Prose, as it is generated. Many of these. */
  | { t: "prose"; delta: string }
  /**
   * Throw away every `prose` frame received so far and start the paragraph again.
   *
   * The narrator's first attempt failed partway through and another is taking its place.
   * Rare, and cheaper than the alternative, which is the reader being shown two endings.
   */
  | { t: "prose_reset" }
  /** After narration: chips, and anything the narrator's proposals changed. */
  | { t: "done"; suggestions: string[]; version: number; rejects: number }
  /** A question, which never becomes a turn. */
  | { t: "answer"; lines: string[] }
  /** Refused, with the reason in the resolver's own words. */
  | { t: "refused"; reason: string }
  /** The provider failed after the fallback chain. The turn did NOT happen. */
  | { t: "error"; message: string; retryable: boolean };

/**
 * Why `mechanics` carries a version and `done` carries it again: the mechanics are already
 * committed when that frame is sent, but the narrator's own effects are journaled after it.
 * A client that reconnects mid-stream resumes from the later number.
 */

// ────────────────────────────────────────────────────────────── responses

export const VersionConflict = z.object({
  error: z.literal("version_conflict"),
  /** What the server actually has. The client re-fetches and re-shows before retrying. */
  actual_version: z.number().int(),
  message: z.string(),
});

/** Everything a client needs on connect or after a conflict. */
export const SnapshotResponse = z.object({
  save_id: z.string(),
  version: z.number().int(),
  screen: z.unknown(),
  /** Last N feed entries, so a refresh does not lose the thread. */
  recent: z.array(z.unknown()),
});

// ───────────────────────────────────────────────────────────── the surface

/**
 * Deliberately small. Everything the client does is one of these, and every one of them
 * either reads a view model or submits a turn.
 */
export const ENDPOINTS = {
  /** GET — list saves. */
  saves: "/api/saves",
  /** POST — create a save from a campaign, with session zero. */
  create: "/api/saves",
  /** GET — the whole screen plus version. Called on connect and after a conflict. */
  snapshot: "/api/saves/:id",
  /** POST, streams TurnFrame. The only endpoint that changes the world. */
  turn: "/api/saves/:id/turn",
  /** POST — a clarifying question. Costs nothing, changes nothing, never streams. */
  ask: "/api/saves/:id/ask",
  /** POST — dry-run an action for its cost and odds. Changes nothing. */
  preview: "/api/saves/:id/preview",
  /** GET — the timeline with cascade chains. */
  history: "/api/saves/:id/history",
  /** POST — rewind to a turn. Archives what it drops. */
  rewind: "/api/saves/:id/rewind",
  /** GET — what the narrator proposed and was refused. The debugging view. */
  rejects: "/api/saves/:id/rejects",
} as const;

// ─────────────────────────────────────────────────────── cost accounting

/**
 * Tokens are the one resource a runaway loop can spend without anyone noticing until the
 * bill. Every model call records here, and a save that crosses its ceiling stops calling
 * the narrator and falls back to mechanics-only turns rather than silently costing money.
 */
export const CostLedgerEntry = z.object({
  turn: z.number().int(),
  role: z.string(),
  provider: z.string(),
  model: z.string(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  ms: z.number().int(),
});
export type CostLedgerEntry = z.infer<typeof CostLedgerEntry>;

export const BudgetPolicy = z.object({
  /** Stop calling the narrator past this, per save. Zero means no ceiling. */
  max_tokens_per_save: z.number().int().nonnegative().default(0),
  /** Refuse a turn that would take longer than this, so a hung provider is not a hung game. */
  turn_timeout_ms: z.number().int().positive().default(45_000),
  /** Past this many turns in a minute, something is looping. */
  max_turns_per_minute: z.number().int().positive().default(30),
});
export type BudgetPolicy = z.infer<typeof BudgetPolicy>;

// ────────────────────────────────────────────────────────────── migration

/**
 * Saves outlive schemas. `CampaignMeta.schema_version` exists; this is the policy for it.
 *
 * The event-sourced design makes this unusually cheap: a save that cannot be migrated in
 * place can be REBUILT by replaying its journal through the current reducer, because the
 * journal is the truth and everything else is a cache. A migration only has to handle the
 * journal's own shape — and events have never needed a breaking change, only added fields
 * with defaults, which Zod fills in on load.
 */
export const MIGRATION_POLICY = [
  "Added fields get a Zod default. An old save loads and the new field is populated.",
  "Renamed or removed fields need a migrator in src/state/migrate.ts, keyed by schema_version.",
  "If a save cannot be migrated: replay its journal through the current reducer. The journal is the truth.",
  "A migration that cannot be expressed as a replay is a design smell — it means state drifted out of the journal.",
] as const;

// ─────────────────────────────────────────────────────────────── notes

/**
 * ON CONCURRENCY. The journal length is the version. Two tabs, both at version 40, both
 * submit: the first turn commits at 41 and the second is refused with `version_conflict`
 * carrying 41. The second client re-fetches, shows the player what happened, and lets them
 * decide — because merging two turns is not a thing that can be done correctly and pretending
 * otherwise corrupts worlds quietly.
 *
 * ON SESSIONS. A save is single-player. Co-op (§26) makes a save multi-*controller*, which
 * changes this: the version check stays, but the server must also know whose turn it is, and
 * refuse a turn submitted for a character the requester is not driving.
 *
 * ON AUTH. A shared secret per deployment is enough for one person's own game. Anything
 * multi-tenant needs real accounts, and that is a different project.
 */
export const SERVING_NOTES = true;
