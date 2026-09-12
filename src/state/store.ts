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
 * Persistence boundary. Game code never touches the filesystem; it goes through this.
 * `JsonFileStore` is the phase-0 implementation, `PostgresStore` arrives in phase 6, and
 * nothing above this interface changes when it does.
 */
export interface StateStore {
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
