import path from "node:path";
import { z } from "zod";
import type { GameState } from "../schema/state.js";
import type { StateStore } from "../state/store.js";
import { SessionZero } from "../schema/campaign.js";
import { ItemInstance } from "../schema/item.js";
import { Skill } from "../schema/common.js";
import { createCharacter } from "../rules/character.js";
import { computeAC } from "../rules/equipment.js";
import { CLASSES } from "./srd/data.js";
import { loadCampaign } from "./loadCampaign.js";

/**
 * MAKING A SAVE FROM A CAMPAIGN, REPLAYABLY.
 *
 * A save is authored content plus three decisions made at the table: which content, which
 * session-zero agreement, and who the player is. The journal replays from the world those
 * decisions produce — so they have to be recorded, or a rebuild starts from the wrong
 * world and reports a difference that is not a bug.
 *
 * `Creation` is that record. It is written once beside the journal and never edited.
 * `applyCreation` is the single function that turns content into a starting world, used by
 * the server when a save is made and by `rebuild` when one is checked. Two callers, one
 * transformation: there is nothing for them to disagree about.
 */

export const CharacterRequest = z.object({
  name: z.string().min(1).max(40),
  pronouns: z.string().default("they/them"),
  race_id: z.string(),
  class_id: z.string(),
  background_id: z.string(),
  skills: z.array(Skill),
  scores: z.union([
    z.object({ method: z.literal("standard"), assignment: z.record(z.string(), z.number()) }),
    z.object({ method: z.literal("point_buy"), scores: z.record(z.string(), z.number()) }),
    z.object({ method: z.literal("rolled"), scores: z.record(z.string(), z.number()) }),
  ]),
  alignment: z.string().optional(),
});
export type CharacterRequest = z.infer<typeof CharacterRequest>;

export const CreateSaveRequest = z.object({
  campaign: z.string().regex(/^[a-z0-9_]+$/).default("drowned_bell"),
  /**
   * A save id is an `Id` like everything else in this world — it is written into
   * `meta.id`, and a world whose own id does not parse cannot be loaded back. Constrained
   * here rather than discovered at load time, with a message that says what to type.
   */
  save_id: z.string().max(40).regex(
    /^[a-z][a-z0-9]*_[a-z0-9_]+$/,
    "a save id looks like `prefix_name`: lower case, and at least one underscore",
  ).optional(),
  session_zero: SessionZero.partial().optional(),
  character: CharacterRequest.optional(),
});
export type CreateSaveRequest = z.infer<typeof CreateSaveRequest>;

export const Creation = z.object({
  save_id: z.string(),
  campaign: z.string(),
  created_at: z.string(),
  session_zero: SessionZero.partial().optional(),
  character: CharacterRequest.optional(),
});
export type Creation = z.infer<typeof Creation>;

export class CreationError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
    this.name = "CreationError";
  }
}

/** Content → the world this save starts from. Pure: returns a new state. */
export function applyCreation(base: GameState, c: Creation): GameState {
  const s: GameState = structuredClone(base);
  s.meta.id = c.save_id;
  s.meta.content_dir = c.campaign;
  s.meta.created_at = c.created_at;
  if (c.session_zero) {
    s.meta.session_zero = SessionZero.parse({ ...s.meta.session_zero, ...c.session_zero });
  }
  if (c.character) replacePlayer(s, c.character);
  return s;
}

/**
 * Swap the authored player for the one the table made.
 *
 * The id is kept — relationships, facts, groups and the campaign's own triggers all name
 * the lead by id, and a new person standing in the same place in the story is the point.
 * Everything else is theirs: the old kit goes, the class's kit is minted from whatever the
 * campaign's item catalogue can actually supply.
 */
function replacePlayer(s: GameState, ch: CharacterRequest): void {
  const pcId = s.meta.pc_id;
  const old = s.entities[pcId];
  if (!old) throw new CreationError([`campaign has no player entity ${pcId}`]);

  const made = createCharacter({
    id: pcId,
    name: ch.name,
    pronouns: ch.pronouns,
    race_id: ch.race_id,
    class_id: ch.class_id,
    background_id: ch.background_id,
    skills: ch.skills,
    scores: ch.scores as never,
    alignment: (ch.alignment ?? old.alignment) as never,
    location_id: old.location_id,
  });
  if (!made.ok) throw new CreationError(made.problems);

  // The old character's things leave with them.
  for (const inst of Object.values(s.items)) {
    if (inst.owner.t === "entity" && inst.owner.id === pcId) delete s.items[inst.id];
  }

  const me = made.entity;
  me.zone_id = old.zone_id;
  me.inventory = [];

  // Starting kit, from defs the campaign actually has. A class whose kit the campaign
  // cannot supply starts light rather than failing — content can always add the def.
  const cls = CLASSES[ch.class_id];
  let n = 0;
  for (const defId of cls?.starting_items ?? []) {
    const def = s.item_defs[defId];
    if (!def) continue;
    const id = `item_inst_start_${String(++n).padStart(2, "0")}`;
    s.items[id] = ItemInstance.parse({ id, def_id: defId, owner: { t: "entity", id: pcId }, qty: 1 });
    me.inventory.push(id);
    if (def.kind === "weapon" && !me.equipped.main_hand) me.equipped.main_hand = id;
    else if (def.kind === "armor" && !me.equipped.armor) me.equipped.armor = id;
    else if (def.kind === "shield" && !me.equipped.off_hand) me.equipped.off_hand = id;
  }

  s.entities[pcId] = me;
  // AC is computed from what is worn; the stored number is a cache the combat resolver reads.
  s.entities[pcId]!.ac = computeAC(s, me).total;
}

/**
 * The world a save started from, for replay. Content plus the recorded creation; a save
 * made by `npm run seed` has no record and starts from content as-is.
 */
export async function initialStateFor(
  store: StateStore,
  contentRoot: string,
  saveId: string,
  fallbackCampaign: string,
): Promise<GameState> {
  const raw = await store.readCreation(saveId);
  const creation = raw ? Creation.parse(raw) : null;
  const dir = creation?.campaign ?? fallbackCampaign;
  const base = await loadCampaign(path.join(contentRoot, dir));
  return creation ? applyCreation(base, creation) : base;
}
