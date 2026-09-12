import { z } from "zod";
import { Id } from "./common.js";

/**
 * The fact ledger. Append-only, never edited. If the world changes, write a NEW fact and
 * set `superseded_by` on the old one. That is precisely what makes recall lossless where
 * a rolling summary degrades.
 */

export const FactKind = z.enum(["world", "npc", "item", "quest", "pc_action", "lore"]);
export type FactKind = z.infer<typeof FactKind>;

export const FactSource = z.enum(["narrator", "authored", "player_action", "engine"]);

export const Fact = z.object({
  id: Id,
  turn: z.number().int().nonnegative(),
  world_minute: z.number().int().nonnegative(),
  text: z.string(),                          // one atomic assertion, stated plainly
  kind: FactKind.default("world"),
  subjects: z.array(Id).default([]),         // entity/faction/quest ids this is ABOUT
  location_id: Id.nullable().default(null),
  quest_ids: z.array(Id).default([]),
  importance: z.number().int().min(1).max(5).default(3),  // 5 is never dropped from context
  secret: z.boolean().default(false),        // hidden from the player until learned
  known_by: z.array(Id).default([]),         // the knowledge model; see engine/knowledge.ts
  source: FactSource.default("narrator"),
  superseded_by: Id.nullable().default(null),
  /**
   * A door that no roll opens — and, by construction, the key to it.
   *
   * Most reticence is a DC: trust makes a person harder or easier to get things out of,
   * and the dice decide. A SEAL is the rarer case where saying it costs them more than any
   * argument can cover, so a check cannot buy it at any total.
   *
   * The field is shaped so a seal cannot exist without naming what would lift it. A closed
   * door that says only "no" is a wall; a closed door that says "not until his brother is
   * out of the Ashen Hand's debt" is a quest hook, and that is the only kind we allow.
   */
  seal: z.object({
    /** What the player is told, in the NPC's terms. "He will not discuss his debts." */
    why: z.string().min(1),
    /** What would open it. Shown to the player once they have pressed and failed. */
    opens_when: z.string().min(1),
    /** Set this flag to lift the seal. Empty means the seal lifts at SECRET_TRUST instead. */
    lifted_by_flag: z.string().default(""),
  }).nullable().default(null),
});
export type Fact = z.infer<typeof Fact>;
