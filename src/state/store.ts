import type { GameEvent } from "../schema/event.js";
import type { GameState } from "../schema/state.js";

/** Metadata shown in a campaign list, without loading the whole world. */
export interface CampaignSummary {
  id: string;
  title: string;
  turn: number;
  world_minute: number;
  saved_at: string;
}

/**
 * One entry in the player-facing feed: what they said, what the narrator answered, what
 * the dice did. The feed is NOT the journal. The journal is truth and replays the world;
 * the feed is the transcript, kept so a refresh or a new device shows the conversation
 * rather than a bare room. Rolls are stored already rendered as roll cards, because the
 * client that reads them has no engine to compute one.
 */
export interface FeedRow {
  turn: number;
  /** Journal length after this row's turn, so a client can line it up with history. */
  version: number;
  kind: "player" | "narration" | "mechanics" | "answer" | "system" | "ambient";
  text: string;
  rolls: unknown[];
  at: string;
}

/**
 * Persistence boundary. Game code never touches the filesystem; it goes through this.
 * `JsonFileStore` is the phase-0 implementation, `PostgresStore` arrives in phase 6, and
 * nothing above this interface changes when it does.
 */
export interface StateStore {
  // ---- the transcript and the ledgers. None of these are the journal.
  appendFeed(campaignId: string, rows: readonly FeedRow[]): Promise<void>;
  readFeed(campaignId: string, limit?: number): Promise<FeedRow[]>;
  /** After a rewind: rows from turns that no longer happened go with them. */
  truncateFeed(campaignId: string, maxTurn: number): Promise<void>;
  appendCosts(campaignId: string, rows: readonly unknown[]): Promise<void>;
  readCosts(campaignId: string): Promise<unknown[]>;
  readRejects(campaignId: string): Promise<unknown[]>;
  /**
   * How this save was made from its campaign: which content, which session-zero choices,
   * which character. Recorded once so a replay can rebuild the SAME starting world — the
   * journal replays from the initial state, and the initial state is content plus this.
   */
  writeCreation(campaignId: string, creation: unknown): Promise<void>;
  readCreation(campaignId: string): Promise<unknown | null>;

  load(campaignId: string): Promise<GameState>;
  /** Persist new state and append the events that produced it to the journal. */
  commit(campaignId: string, events: readonly GameEvent[], next: GameState): Promise<void>;
  listCampaigns(): Promise<CampaignSummary[]>;
  /** Every root event ever committed, in order. Cascades are included but flagged. */
  readJournal(campaignId: string): Promise<GameEvent[]>;
  /** Append-only log of LLM proposals the validator refused. */
  appendRejects(campaignId: string, rows: readonly unknown[]): Promise<void>;
  /**
   * Replace the journal wholesale. Only rewind should call this, and only after archiving
   * what it is dropping — the journal is the source of truth, so overwriting it without a
   * copy would be the one genuinely destructive operation in the system.
   */
  writeJournal(campaignId: string, events: readonly GameEvent[]): Promise<void>;
  /** Park removed events in a branch file so a rewind is itself reversible. */
  archiveBranch(campaignId: string, events: readonly GameEvent[], label: string): Promise<string>;
  listBranches(campaignId: string): Promise<string[]>;
  readBranch(campaignId: string, branchId: string): Promise<GameEvent[]>;
  snapshot(campaignId: string, label: string): Promise<string>;
  restore(campaignId: string, snapshotId: string): Promise<void>;
  exists(campaignId: string): Promise<boolean>;
  create(campaignId: string, initial: GameState): Promise<void>;
}
