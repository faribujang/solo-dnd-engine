import { z } from "zod";
import { Dim, Dims, Id, Json } from "./common.js";
import { ItemOwner } from "./item.js";
import { CombatState } from "./combat.js";

/**
 * The trigger DSL. Declarative data, evaluated by src/engine/.
 * This is how world, characters and quests affect one another — never a hardcoded if-tree,
 * and never the LLM's job.
 */

export const QuestStatus = z.enum([
  "unknown", "available", "active", "complete", "failed", "expired",
]);
export type QuestStatus = z.infer<typeof QuestStatus>;

/**
 * Condition is recursive (all/any/not), which zod cannot infer through z.lazy.
 * This is the one place we hand-write a type beside its schema; the schema below is
 * annotated `z.ZodType<Condition>` so the two are checked against each other.
 */
export type Condition =
  | { t: "flag"; key: string; eq: unknown }
  | { t: "has_item"; entity_id: string; item_def_id: string; min?: number }
  | { t: "entity_at"; entity_id: string; location_id: string }
  | { t: "entity_dead"; entity_id: string }
  | { t: "entity_alive"; entity_id: string }
  | { t: "affinity"; subject: string; object: string; dim: z.infer<typeof Dim>; op: "gte" | "lte"; value: number }
  | { t: "quest_status"; quest_id: string; status: z.infer<typeof QuestStatus> }
  | { t: "quest_step_done"; quest_id: string; step_id: string }
  | { t: "knows_fact"; entity_id: string; fact_id: string }
  | { t: "world_time"; op: "before" | "after"; world_minute: number }
  | { t: "faction_rep"; faction_id: string; op: "gte" | "lte"; value: number }
  | { t: "visited"; location_id: string; min?: number }
  | { t: "all"; of: Condition[] }
  | { t: "any"; of: Condition[] }
  | { t: "not"; of: Condition[] };

export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ t: z.literal("flag"), key: z.string(), eq: Json }),
    z.object({ t: z.literal("has_item"), entity_id: Id, item_def_id: Id, min: z.number().int().optional() }),
    z.object({ t: z.literal("entity_at"), entity_id: Id, location_id: Id }),
    z.object({ t: z.literal("entity_dead"), entity_id: Id }),
    z.object({ t: z.literal("entity_alive"), entity_id: Id }),
    z.object({ t: z.literal("affinity"), subject: Id, object: Id, dim: Dim, op: z.enum(["gte", "lte"]), value: z.number() }),
    z.object({ t: z.literal("quest_status"), quest_id: Id, status: QuestStatus }),
    z.object({ t: z.literal("quest_step_done"), quest_id: Id, step_id: z.string() }),
    z.object({ t: z.literal("knows_fact"), entity_id: Id, fact_id: Id }),
    z.object({ t: z.literal("world_time"), op: z.enum(["before", "after"]), world_minute: z.number().int() }),
    z.object({ t: z.literal("faction_rep"), faction_id: Id, op: z.enum(["gte", "lte"]), value: z.number() }),
    z.object({ t: z.literal("visited"), location_id: Id, min: z.number().int().optional() }),
    z.object({ t: z.literal("all"), of: z.array(Condition) }),
    z.object({ t: z.literal("any"), of: z.array(Condition) }),
    z.object({ t: z.literal("not"), of: z.array(Condition) }),
  ]) as z.ZodType<Condition>,
);

/**
 * Effects are the only way state changes. Every one of these is applied by
 * src/engine/effects.ts. Note that no effect rolls dice: all randomness happens during
 * resolution and is baked into the event, which is what makes replay exact.
 */
export const Effect = z.discriminatedUnion("t", [
  z.object({ t: z.literal("set_flag"), key: z.string(), value: Json }),
  // give_item MINTS a new object from a definition — a reward, a spawn, loot appearing.
  z.object({ t: z.literal("give_item"), entity_id: Id, item_def_id: Id, qty: z.number().int().positive().default(1) }),
  z.object({ t: z.literal("remove_item"), entity_id: Id, item_def_id: Id, qty: z.number().int().positive().default(1) }),
  // move_item MOVES an object that already exists. Picking something up must use this:
  // minting a copy would leave the original where it lay and duplicate the world's things.
  z.object({ t: z.literal("move_item"), instance_id: Id, to: ItemOwner }),
  z.object({ t: z.literal("move_entity"), entity_id: Id, location_id: Id }),
  z.object({ t: z.literal("spawn_entity"), template_id: Id, location_id: Id, instance_id: Id }),
  z.object({ t: z.literal("damage"), entity_id: Id, amount: z.number().int().nonnegative(), damage_type: z.string() }),
  z.object({ t: z.literal("heal"), entity_id: Id, amount: z.number().int().nonnegative() }),
  z.object({ t: z.literal("adjust_attitude"), subject: Id, object: Id, dims: Dims, reason: z.string() }),
  z.object({ t: z.literal("faction_rep"), faction_id: Id, delta: z.number() }),
  z.object({ t: z.literal("set_quest_status"), quest_id: Id, status: QuestStatus }),
  z.object({ t: z.literal("advance_quest"), quest_id: Id, step_id: z.string() }),
  z.object({ t: z.literal("add_lead"), quest_id: Id, text: z.string(), points_to_location_id: Id.nullable().default(null), source_entity_id: Id.nullable().default(null) }),
  z.object({ t: z.literal("reveal_location"), location_id: Id }),
  z.object({ t: z.literal("reveal_exit"), location_id: Id, dir: z.string() }),
  z.object({ t: z.literal("add_fact"), text: z.string(), subjects: z.array(Id).default([]), importance: z.number().int().min(1).max(5).default(3), secret: z.boolean().default(false), known_by: z.array(Id).default([]) }),
  z.object({ t: z.literal("teach_fact"), entity_id: Id, fact_id: Id }),
  /**
   * A named local, invented at the table and then real.
   *
   * The narrator could already invent people — it just could not KEEP them, so the
   * innkeeper it named last scene was a different innkeeper this scene, which is the
   * single most world-destroying thing a DM can do. This makes them persist, with a
   * commoner's stat block and a relationship row, inside a hard cap.
   */
  z.object({
    t: z.literal("introduce_local"),
    name: z.string().min(1).max(60),
    descriptor: z.string().min(1).max(200),
    pronouns: z.string().default("they/them"),
    location_id: Id,
    /**
     * How they talk. Throwaway is not the same as cardboard — a local the DM can hear is
     * a local it will voice consistently, which is the whole reason to keep them at all.
     * Drives the narrator only; the rules never read it.
     */
    voice: z.string().max(200).default(""),
    trait: z.string().max(200).default(""),
  }),
  /**
   * The same problem as `introduce_local`, one level up: a place the narrator describes
   * but the world does not contain.
   *
   * A player was told to follow somebody down into a cellar. The cellar was prose. It had
   * no id, so it was on no map, and "go to the cellar" could not resolve — the scene had
   * named a destination the engine could not offer. This mints it: a real location, joined
   * to where the player is standing by a two-way exit, discovered, and therefore drawable
   * and walkable like anywhere else.
   *
   * Deliberately NOT a way to invent geography at large. It hangs the new place off the
   * CURRENT one, inherits its region and settlement, and the validator caps it hard.
   */
  z.object({
    t: z.literal("introduce_place"),
    name: z.string().min(1).max(60),
    short_desc: z.string().min(1).max(300),
    /** How you get there from where you are: "down the stair", "through the back door". */
    dir: z.string().min(1).max(40),
    /** The way back, so nobody is ever sealed in by a narrator's turn of phrase. */
    back: z.string().min(1).max(40).default("back"),
    light: z.enum(["bright", "dim", "dark"]).default("bright"),
  }),
  z.object({ t: z.literal("advance_time"), minutes: z.number().int().nonnegative() }),
  /**
   * Pick up an obligation. The narrator is trusted with these precisely because they
   * have no mechanical teeth: a thread is a sentence and a status, and nothing in the
   * rules engine reads one.
   */
  z.object({
    t: z.literal("open_thread"),
    text: z.string().min(1).max(240),
    subject_ids: z.array(Id).default([]),
    location_id: Id.nullable().default(null),
    from_entity_id: Id.nullable().default(null),
  }),
  z.object({
    t: z.literal("resolve_thread"),
    thread_id: Id,
    as: z.enum(["kept", "broken", "faded"]),
    outcome: z.string().max(240).default(""),
  }),
  z.object({ t: z.literal("start_combat"), enemy_ids: z.array(Id) }),
  z.object({ t: z.literal("add_condition"), entity_id: Id, condition_id: z.string(), duration_minutes: z.number().int().nonnegative(), rounds: z.number().int().nonnegative().default(0) }),
  z.object({ t: z.literal("remove_condition"), entity_id: Id, condition_id: z.string() }),
  // Prose about how one character regards another. The LLM writes this; it has no
  // mechanical consequence, which is exactly why the model is trusted with it and not
  // with the numbers sitting beside it.
  z.object({ t: z.literal("set_opinion"), subject: Id, object: Id, opinion: z.string() }),
  // Progression. Both journaled, both replay exactly.
  z.object({ t: z.literal("grant_xp"), entity_ids: z.array(Id), amount: z.number().int().nonnegative(), reason: z.string().default("") }),
  z.object({ t: z.literal("level_up"), entity_id: Id, hp_gain: z.number().int().positive() }),
  // Dying. `death_save` records one roll's outcome; `stabilise` ends the dying state.
  z.object({ t: z.literal("death_save"), entity_id: Id, outcome: z.enum(["success", "failure", "crit_success", "crit_failure"]) }),
  z.object({ t: z.literal("stabilise"), entity_id: Id }),
  z.object({ t: z.literal("equip"), entity_id: Id, instance_id: Id, slot: z.enum(["main_hand", "off_hand", "armor", "trinket"]).nullable() }),
  // Combat. `start_combat` (above) is the authored form and only sets a pending flag, because
  // initiative needs dice; `begin_combat` carries a pre-rolled order from resolution.
  z.object({ t: z.literal("begin_combat"), combat: CombatState }),
  z.object({ t: z.literal("end_combat"), winner: z.enum(["party", "enemy", "none"]) }),
  z.object({ t: z.literal("next_turn") }),
  z.object({ t: z.literal("spend"), entity_id: Id, action: z.boolean().optional(), bonus: z.boolean().optional(), reaction: z.boolean().optional(), moves: z.number().int().optional() }),
  z.object({ t: z.literal("grant_moves"), entity_id: Id, moves: z.number().int().positive() }),
  z.object({ t: z.literal("mark"), entity_id: Id, dodging: z.boolean().optional(), disengaged: z.boolean().optional(), fled: z.boolean().optional() }),
  z.object({ t: z.literal("set_zone"), entity_id: Id, zone_id: z.string() }),
  z.object({ t: z.literal("spend_slot"), entity_id: Id, level: z.number().int().min(1).max(9) }),
  z.object({ t: z.literal("set_concentration"), entity_id: Id, spell_id: z.string().nullable() }),
  z.object({ t: z.literal("set_entity_flag"), entity_id: Id, key: z.string(), value: Json }),
  /**
   * A feature's own small state bag: the boards are pried up, the chain is cut, the
   * ledger has been read. Kept on the feature rather than in world flags so a room
   * carries its own history and two winch houses cannot share one barred lock.
   */
  z.object({
    t: z.literal("set_feature_state"),
    location_id: Id,
    feature_id: z.string(),
    key: z.string(),
    value: Json,
  }),
  // Inspiration. Earned by playing your character, spent to reroll.
  z.object({ t: z.literal("grant_inspiration"), entity_id: Id, reason: z.string().default("") }),
  z.object({ t: z.literal("spend_inspiration"), entity_id: Id }),
  // Progress clocks and vows.
  z.object({ t: z.literal("tick_clock"), clock_id: Id, segments: z.number().int().default(1) }),
  z.object({ t: z.literal("add_clock"), clock: z.unknown() }),
  z.object({ t: z.literal("advance_vow"), vow_id: Id, ticks: z.number().int() }),
  z.object({ t: z.literal("set_vow_status"), vow_id: Id, status: z.enum(["sworn", "fulfilled", "forsworn"]) }),

  // ---- succession. A campaign ending is a turn like any other, so every change it makes
  // is an effect. The alternative — mutating the world beside the journal — is how a save
  // stops replaying, and the rebuild gate catches it immediately.
  z.object({
    t: z.literal("add_legacy"),
    entries: z.array(z.object({
      campaign_id: Id,
      completed_turn: z.number().int().nonnegative(),
      world_minute: z.number().int().nonnegative(),
      party_ids: z.array(Id).default([]),
      text: z.string(),
      subject_ids: z.array(Id).default([]),
    })),
  }),
  z.object({ t: z.literal("set_campaign_status"), campaign_id: Id, status: z.enum(["available", "active", "complete"]) }),
  z.object({ t: z.literal("set_arc_status"), arc_id: Id, status: z.enum(["locked", "active", "complete", "abandoned"]) }),
  z.object({ t: z.literal("promote_seed"), arc_id: Id, seed_id: Id }),

  /**
   * The front moves. A town changing hands is an ordinary event, so a campaign whose
   * background engine is a war does not need machinery outside the journal.
   */
  z.object({
    t: z.literal("set_presence"),
    settlement_id: Id,
    faction_id: Id,
    allegiance: z.enum(["holds", "contests", "present", "hunted"]).optional(),
    strength: z.number().int().min(0).max(100).optional(),
    openness: z.enum(["open", "quiet", "covert"]).optional(),
  }),
  // Conversation. Talking is a state you enter and leave, not a single action.
  z.object({ t: z.literal("begin_conversation"), entity_id: Id, agenda: z.string().default("") }),
  z.object({ t: z.literal("end_conversation"), reason: z.string().default("") }),
  z.object({ t: z.literal("raise_topic"), topic_id: z.string(), friction: z.number().int().default(0) }),
  z.object({ t: z.literal("grant_action"), entity_id: Id }),
  z.object({ t: z.literal("recharge_features"), entity_id: Id, kind: z.enum(["short", "long"]) }),
  z.object({ t: z.literal("tag_relationship"), subject: Id, object: Id, tag: z.string() }),
  z.object({ t: z.literal("join_party"), entity_id: Id }),
  z.object({ t: z.literal("leave_party"), entity_id: Id, reason: z.string().default("") }),
]);
export type Effect = z.infer<typeof Effect>;

/** Effect names the narrator is permitted to propose. Everything else is engine-only. */
export const NARRATOR_ALLOWED_EFFECTS = [
  "set_flag", "add_lead", "reveal_location", "reveal_exit",
  "add_fact", "teach_fact", "adjust_attitude", "move_entity", "advance_time",
  "set_opinion", "grant_inspiration", "tick_clock", "introduce_local", "introduce_place",
  "open_thread", "resolve_thread",
  /**
   * Handing something over — and ONLY things that cannot change a roll.
   *
   * The narrator describing a gift the engine never made is the worst lie this system
   * tells: the player is told they have a thing, opens their pack, and it is not there.
   * But "no items from the narrator" was the right instinct for the wrong reason — a
   * sword is a mechanical outcome; a loaf, a lantern and a dead man's ring are props.
   *
   * validate.ts enforces the line: the definition must already exist in the campaign,
   * and its kind must not be weapon, armour or shield.
   */
  "give_item",
] as const;

/** The event types the engine understands. Triggers match on these. */
export const EventType = z.enum([
  "move", "enter_location", "attack", "skill_check", "dialogue", "item_transfer",
  "cast", "rest", "trade", "observe", "quest_update", "death", "time_pass",
  "effect", "campaign_start", "level_up", "downed", "death_save", "combat_start", "combat_end", "round",
  "clock", "vow", "inspiration", "conversation", "scene_break", "faction",
]);
export type EventType = z.infer<typeof EventType>;

/** A structural match against an event. All present keys must match. */
export const TriggerMatch = z.object({
  actor_id: Id.optional(),
  location_id: Id.optional(),
  target_ids: z.array(Id).optional(),        // matches if every listed id is in the event's targets
  payload_key: z.string().optional(),        // require payload[payload_key] to be truthy
});
export type TriggerMatch = z.infer<typeof TriggerMatch>;

export const Trigger = z.object({
  id: Id,                                    // stable id; `fired` is tracked against it
  on: EventType,                             // event type this listens for
  match: TriggerMatch.optional(),            // structural match on the event
  when: Condition.optional(),                // additional state predicate
  then: z.array(Effect),                     // what happens
  once: z.boolean().default(true),           // fire at most once per campaign
});
export type Trigger = z.infer<typeof Trigger>;
