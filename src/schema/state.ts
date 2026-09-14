import { z } from "zod";
import { Id } from "./common.js";
import { Entity } from "./entity.js";
import { Fact } from "./fact.js";
import { ItemDef, ItemInstance } from "./item.js";
import { Location } from "./location.js";
import { Quest } from "./quest.js";
import { Relationship } from "./relationship.js";
import { World } from "./world.js";
import { Arc, Campaign, Group, LegacyEntry, SessionZero, Settlement } from "./campaign.js";
import { CombatState } from "./combat.js";
import { Clock, Vow } from "./clock.js";
import { EncounterTable } from "./encounter.js";
import { Conversation } from "../engine/conversation.js";

export const CampaignMeta = z.object({
  id: Id,
  title: z.string(),
  /**
   * The lead player character. In solo play this is the whole party's perspective; with a
   * party, it is whose location defines "the scene" when groups have not split.
   */
  pc_id: Id,
  party_ids: z.array(Id).default([]),        // everyone travelling with the lead, lead included
  player_controlled: z.array(Id).default([]), // subset a human is currently driving
  session_zero: SessionZero.default({}),
  taught: z.array(z.string()).default([]),   // rules concepts already explained once
  campaign_id: Id.nullable().default(null),
  /** Which authored content this save was made from — the directory under content/campaign. */
  content_dir: z.string().default(""),
  /**
   * Which backgrounds this campaign offers, and what each one MEANS here.
   *
   * The SRD list is generic on purpose, and a generic list handed to a specific opening
   * produces a specific contradiction: Wickmoor's prologue says you are a village smith's
   * apprentice of three years, and `bg_noble` says you were born to a great house. The
   * mechanical half was never the problem — `standing` already makes commoners wary of a
   * noble, and it works — the fiction was. A campaign that frames its own lead has to be
   * able to say which lives that lead could have had.
   *
   * Empty means every background, which is what a campaign with no opinion should get.
   * The gloss is shown at creation, in the campaign's voice, beside the SRD blurb.
   */
  backgrounds: z.array(z.object({
    id: z.string(),
    /** One line: what someone with this background is, in THIS place. */
    local: z.string(),
  })).default([]),
  seed: z.string(),                           // every die derives from this + the situation
  turn: z.number().int().nonnegative().default(0),
  next_ids: z.record(z.string(), z.number().int().nonnegative()).default({}), // id counters
  created_at: z.string().default(""),
  schema_version: z.number().int().default(1),
});
export type CampaignMeta = z.infer<typeof CampaignMeta>;

/**
 * The complete in-memory world. Everything the engine reads or writes lives here, and
 * every field is reachable from the journal by replay.
 */
export const GameState = z.object({
  meta: CampaignMeta,
  world: World,
  entities: z.record(z.string(), Entity).default({}),
  locations: z.record(z.string(), Location).default({}),
  item_defs: z.record(z.string(), ItemDef).default({}),
  items: z.record(z.string(), ItemInstance).default({}),
  quests: z.record(z.string(), Quest).default({}),
  relationships: z.record(z.string(), Relationship).default({}),  // keyed "subject->object"
  facts: z.array(Fact).default([]),
  settlements: z.record(z.string(), Settlement).default({}),
  groups: z.record(z.string(), Group).default({}),
  arcs: z.record(z.string(), Arc).default({}),
  campaigns: z.record(z.string(), Campaign).default({}),
  legacy: z.array(LegacyEntry).default([]),
  combat: CombatState.nullable().default(null),
  clocks: z.record(z.string(), Clock).default({}),
  vows: z.record(z.string(), Vow).default({}),
  encounter_tables: z.record(z.string(), EncounterTable).default({}),
  /** Who the player is currently talking to, if anyone. Talking is a state, not an action. */
  conversation: Conversation.nullable().default(null),
});
export type GameState = z.infer<typeof GameState>;
