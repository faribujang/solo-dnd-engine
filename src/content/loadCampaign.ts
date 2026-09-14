import { promises as fs } from "node:fs";
import path from "node:path";
import { GameState } from "../schema/state.js";
import { fileURLToPath } from "node:url";
import { BACKGROUNDS } from "./srd/data.js";

const SRD_ITEMS = path.join(path.dirname(fileURLToPath(import.meta.url)), "srd", "items.json");

/**
 * Load an authored campaign from content/campaign/<name>/ into a validated GameState.
 *
 * Authored content is parsed through the same Zod schemas as a save file. Content is the
 * likeliest source of a malformed world, so it gets the strictest gate.
 */
export async function loadCampaign(dir: string): Promise<GameState> {
  const read = async (f: string): Promise<unknown> =>
    JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));

  const readOr = async (f: string, fallback: unknown): Promise<unknown> => {
    try { return await read(f); } catch { return fallback; }
  };

  const [meta, world, entities, locations, items, quests, relationships, facts, settlements, layer, extra] =
    await Promise.all([
      read("campaign.json"),
      read("world.json"),
      read("entities.json"),
      read("locations.json"),
      read("items.json"),
      read("quests.json"),
      read("relationships.json"),
      read("facts.json"),
      readOr("settlements.json", {}),
      readOr("campaign_layer.json", { groups: {}, arcs: {}, campaigns: {}, legacy: [] }),
      readOr("world_extra.json", { clocks: {}, vows: {}, encounter_tables: {} }),
    ]);
  const wx = extra as { clocks: unknown; vows: unknown; encounter_tables: unknown };
  const cl = layer as { groups: unknown; arcs: unknown; campaigns: unknown; legacy: unknown };

  const m = meta as Record<string, unknown>;
  const it = items as { defs: Record<string, unknown>; instances: unknown };
  // SRD definitions are shared by every campaign. Campaign-authored defs win on collision.
  const srd = JSON.parse(await fs.readFile(SRD_ITEMS, "utf8")) as Record<string, unknown>;
  it.defs = { ...srd, ...it.defs };

  const state = GameState.parse({
    meta: m,
    world,
    entities,
    locations,
    item_defs: it.defs,
    items: it.instances,
    quests,
    relationships,
    facts,
    settlements,
    groups: cl.groups,
    arcs: cl.arcs,
    campaigns: cl.campaigns,
    legacy: cl.legacy,
    clocks: wx.clocks,
    vows: wx.vows,
    encounter_tables: wx.encounter_tables,
  });

  // Derive the party from the lead if content did not spell it out, so a solo campaign
  // file never has to repeat itself.
  if (state.meta.party_ids.length === 0) state.meta.party_ids = [state.meta.pc_id];
  if (state.meta.player_controlled.length === 0) state.meta.player_controlled = [state.meta.pc_id];
  if (Object.keys(state.groups).length === 0) {
    state.groups["grp_main"] = { id: "grp_main", member_ids: [...state.meta.party_ids], lead_id: state.meta.pc_id };
  }
  for (const id of state.meta.party_ids) {
    const e = state.entities[id];
    if (e) { e.group_id ??= "grp_main"; if (state.meta.player_controlled.includes(id)) e.controller = "human"; }
  }

  /**
   * Wherever the lead begins, they have been there.
   *
   * `visited_count` only ever rose on ENTERING a room, so the one room nobody enters —
   * the one they start in — read as never visited. The map drew the character's own home
   * as a place they had merely heard of, and, worse, an authored trigger conditioned on
   * `visited(that room)` could never fire, which is a content trap with no symptom.
   *
   * Done here rather than in the reducer so it is part of the world a save STARTS from:
   * replay and live play both come through this function, so they cannot disagree.
   */
  const start = state.entities[state.meta.pc_id]?.location_id;
  const startLoc = start ? state.locations[start] : undefined;
  if (startLoc) {
    startLoc.discovered = true;
    if (startLoc.visited_count === 0) startLoc.visited_count = 1;
  }

  validateReferences(state);
  return state;
}

/**
 * Referential integrity across files. Zod validates each object's shape; this catches the
 * other half — an exit pointing at a room that does not exist, a quest reward naming an
 * item definition nobody wrote. Content bugs found here are cheap; found at turn 200 they
 * are not.
 */
export function validateReferences(s: GameState): void {
  const problems: string[] = [];

  const ent = (id: string, where: string) => {
    if (!s.entities[id]) problems.push(`${where}: unknown entity ${id}`);
  };
  const loc = (id: string, where: string) => {
    if (!s.locations[id]) problems.push(`${where}: unknown location ${id}`);
  };
  const def = (id: string, where: string) => {
    if (!s.item_defs[id]) problems.push(`${where}: unknown item definition ${id}`);
  };

  if (!s.entities[s.meta.pc_id]) problems.push(`campaign: pc_id ${s.meta.pc_id} not in entities`);
  for (const id of s.meta.party_ids) ent(id, "campaign party_ids");
  for (const id of s.meta.player_controlled) {
    if (!s.meta.party_ids.includes(id)) problems.push(`campaign: player_controlled ${id} is not in party_ids`);
  }
  for (const g of Object.values(s.groups)) {
    for (const m of g.member_ids) ent(m, `group ${g.id}`);
    if (!g.member_ids.includes(g.lead_id)) problems.push(`group ${g.id}: lead ${g.lead_id} is not a member`);
  }
  for (const st of Object.values(s.settlements)) {
    for (const l of st.location_ids) loc(l, `settlement ${st.id}`);
    for (const sv of st.services) loc(sv.location_id, `settlement ${st.id} service`);
  }
  for (const a of Object.values(s.arcs)) {
    for (const q of a.quest_ids) if (!s.quests[q]) problems.push(`arc ${a.id}: unknown quest ${q}`);
  }
  for (const l of Object.values(s.locations)) {
    if (l.settlement_id && !s.settlements[l.settlement_id]) problems.push(`location ${l.id}: unknown settlement ${l.settlement_id}`);
  }

  for (const e of Object.values(s.entities)) {
    loc(e.location_id, `entity ${e.id}`);
    for (const b of e.schedule) loc(b.location_id, `entity ${e.id} schedule`);
    for (const instId of e.inventory) {
      const inst = s.items[instId];
      if (!inst) { problems.push(`entity ${e.id}: unknown item instance ${instId}`); continue; }
      if (inst.owner.t !== "entity" || inst.owner.id !== e.id) {
        problems.push(`entity ${e.id}: carries ${instId}, but its owner says ${JSON.stringify(inst.owner)}`);
      }
    }
    for (const slot of ["main_hand", "off_hand", "armor", "trinket"] as const) {
      const v = e.equipped[slot];
      if (v && !s.items[v]) problems.push(`entity ${e.id}: equips unknown instance ${v}`);
    }
    for (const fid of e.known_fact_ids) {
      if (!s.facts.some((f) => f.id === fid)) problems.push(`entity ${e.id}: unknown fact ${fid}`);
    }
  }

  for (const l of Object.values(s.locations)) {
    for (const x of l.exits) {
      loc(x.to, `location ${l.id} exit ${x.dir}`);
      if (x.locked_by) def(x.locked_by, `location ${l.id} exit ${x.dir}`);
    }
    for (const iid of l.contains_item_ids) {
      const inst = s.items[iid];
      if (!inst) { problems.push(`location ${l.id}: unknown item instance ${iid}`); continue; }
      if (inst.owner.t !== "location" || inst.owner.id !== l.id) {
        problems.push(`location ${l.id}: lists ${iid}, but its owner says ${JSON.stringify(inst.owner)}`);
      }
    }
  }

  for (const inst of Object.values(s.items)) {
    def(inst.def_id, `item instance ${inst.id}`);
    if (inst.owner.t === "entity") ent(inst.owner.id, `item instance ${inst.id} owner`);
    if (inst.owner.t === "location") loc(inst.owner.id, `item instance ${inst.id} owner`);
  }

  for (const q of Object.values(s.quests)) {
    if (q.giver_entity_id) ent(q.giver_entity_id, `quest ${q.id} giver`);
    for (const d of q.rewards.item_def_ids) def(d, `quest ${q.id} reward`);
    for (const rd of q.rewards.relationship_deltas) {
      ent(rd.subject, `quest ${q.id} reward`);
      ent(rd.object, `quest ${q.id} reward`);
    }
    if (q.current_step_id && !q.steps.some((st) => st.id === q.current_step_id)) {
      problems.push(`quest ${q.id}: current_step_id ${q.current_step_id} is not one of its steps`);
    }
    for (const l of q.leads) {
      if (l.points_to_location_id) loc(l.points_to_location_id, `quest ${q.id} lead`);
    }
  }

  for (const key of Object.keys(s.relationships)) {
    const rel = s.relationships[key]!;
    if (key !== `${rel.subject}->${rel.object}`) {
      problems.push(`relationship ${key}: key does not match subject->object`);
    }
    ent(rel.subject, `relationship ${key}`);
    ent(rel.object, `relationship ${key}`);
  }

  for (const f of s.facts) {
    for (const k of f.known_by) ent(k, `fact ${f.id} known_by`);
  }

  for (const b of s.meta.backgrounds) {
    if (!BACKGROUNDS[b.id]) problems.push(`meta.backgrounds: no background "${b.id}"`);
    if (!b.local.trim()) problems.push(`meta.backgrounds: "${b.id}" has no local gloss`);
  }

  if (problems.length > 0) {
    throw new Error(`Campaign content has ${problems.length} broken reference(s):\n  - ${problems.join("\n  - ")}`);
  }
}
