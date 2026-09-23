import { z } from "zod";
import { DifficultyBand, Flags, Id, Skill } from "./common.js";

export const ItemKind = z.enum(["weapon", "armor", "shield", "consumable", "tool", "key", "treasure", "misc"]);

export const Damage = z.object({
  dice: z.string(),                          // "1d8"
  type: z.string(),                          // "slashing"
  versatile: z.string().nullable().default(null),
});

/**
 * What having this item lets you DO.
 *
 * The fix for the Hitchhiker's failure mode: the player should never have to guess that the
 * game modelled their crowbar. Carrying one injects "Pry open the door" into the action bar
 * wherever prying is possible, with the item named in the reason.
 */
export const ItemGrant = z.object({
  /** Player-facing verb: "Pry open", "Climb down", "Pick the lock". */
  verb: z.string(),
  skill: Skill,
  band: DifficultyBand.default("medium"),
  /** Lands in the event payload so authored triggers can match this specific attempt. */
  tag: z.string(),
  /** When this verb is offered at all. */
  requires: z.discriminatedUnion("t", [
    // A flag on the location, e.g. `climbable`.
    z.object({ t: z.literal("location_flag"), key: z.string() }),
    // A feature here that supports this interaction, e.g. a well you can climb down.
    z.object({ t: z.literal("feature"), interaction: z.string() }),
    // Any locked exit in this room. Thieves' tools.
    z.object({ t: z.literal("locked_exit") }),
  ]),
  /** The tool makes it easier, not merely possible. */
  advantage: z.boolean().default(false),
});
export type ItemGrant = z.infer<typeof ItemGrant>;

/** Shared, static definition. One per kind of thing that exists in the world. */
export const ItemDef = z.object({
  id: Id,
  name: z.string(),
  kind: ItemKind,
  desc: z.string().default(""),
  weight: z.number().nonnegative().default(0),
  value_cp: z.number().int().nonnegative().default(0),   // copper pieces, the base unit
  /**
   * Whether a character may simply hand this over in a scene.
   *
   * True by default, because a DM giving you gear the campaign already defines is
   * ordinary play and the stats were written by a person either way. Set it false on
   * the thing that is supposed to be fought for, stolen, or earned — the decision
   * belongs to whoever authored the item, not to a blanket rule about kinds.
   */
  gift_ok: z.boolean().default(true),
  damage: Damage.nullable().default(null),
  ac_base: z.number().int().nullable().default(null),    // for armor
  ac_bonus: z.number().int().default(0),                 // for shields
  dex_cap: z.number().int().nullable().default(null),    // medium armor caps dex mod at 2
  properties: z.array(z.string()).default([]),           // "versatile", "finesse", "two_handed"
  tags: z.array(z.string()).default([]),
  /**
   * The quest this object belongs to, if it belongs to one.
   *
   * Only for things that MATTER: the sealed docket, the ledger you were sent for, the
   * sister's toggle. Ordinary gear has none, and should not — a journal that annotates
   * your whetstone with a quest is a journal nobody reads twice.
   *
   * It is what lets the world keep track of a quest object after it leaves your hands:
   * the item ledger always knew who owned what, and nothing ever asked it on a quest's
   * behalf.
   */
  quest_id: Id.nullable().default(null),
  stackable: z.boolean().default(false),
  grants: z.array(ItemGrant).default([]),
  /**
   * What happens when a character drinks/eats/applies it. The heal is DICE, not a number,
   * because it is rolled at resolution like everything else and baked into the event.
   * A consumable with no `on_use` is flavour — you can still eat it, it just does nothing
   * but pass the time, and the engine says so rather than pretending.
   */
  on_use: z
    .object({
      heal: z.string().nullable().default(null),   // "2d4+2"
      minutes: z.number().int().nonnegative().default(1),
      /** False for a tool you use without spending it. */
      consumed: z.boolean().default(true),
      /** Said back to the player when code, not the DM, is describing the act. */
      text: z.string().default(""),
    })
    .nullable()
    .default(null),
});
export type ItemDef = z.infer<typeof ItemDef>;

/**
 * Owner is a tagged union. One field is the single source of truth for where every
 * object in the world is: carried, on the floor, or inside a container.
 */
export const ItemOwner = z.discriminatedUnion("t", [
  z.object({ t: z.literal("entity"), id: Id }),
  z.object({ t: z.literal("location"), id: Id }),
  z.object({ t: z.literal("container"), id: Id }),
]);
export type ItemOwner = z.infer<typeof ItemOwner>;

/** A concrete object with a history. */
export const ItemInstance = z.object({
  id: Id,
  def_id: Id,
  owner: ItemOwner,
  qty: z.number().int().positive().default(1),
  charges: z.number().int().nonnegative().nullable().default(null),
  attunement: Id.nullable().default(null),   // entity attuned to it
  nickname: z.string().nullable().default(null),   // the narrator may set this
  condition: z.string().default("fine"),     // "fine", "worn", "broken"
  flags: Flags,
});
export type ItemInstance = z.infer<typeof ItemInstance>;
