import type { Roll } from "../schema/common.js";
import { crowdAt } from "../engine/bystanders.js";
import { describeObjective } from "../rules/objectives.js";
import { TERRAIN, describeZone } from "../rules/terrain.js";
import type { GameEvent } from "../schema/event.js";
import type { GameState } from "../schema/state.js";
import type { Affordance, Cost } from "../rules/affordances.js";
import { affordances } from "../rules/affordances.js";
import { computeAC } from "../rules/equipment.js";
import { skillModifier, SKILL_ABILITY, abilityMod, DEGREE_LABEL } from "../rules/checks.js";
import { xpToNext, XP_THRESHOLDS } from "../rules/progression.js";
import { inspirationOf, inspirationCap } from "../rules/inspiration.js";
import { tierOf, willRefuse, wouldLeave } from "../rules/approval.js";
import { dispositionOf } from "../rules/social.js";
import { filledBoxes } from "../schema/clock.js";
import { timeline } from "../engine/rollback.js";
import { reachable } from "../engine/pathfind.js";
import {
  factsKnownToPc, hourOfDay, itemsOwnedBy, npcsPresent, pc, timeOfDayLabel,
  visibleExits, whereaboutsTold,
} from "../state/selectors.js";
import { formatCoin, purseOf } from "../rules/economy.js";
import { linkText, type TextSpan } from "./link.js";
import { topicsFor, type Topic } from "../engine/conversation.js";
import { choosePolicyAction } from "../engine/combat.js";
import type { Action } from "../engine/turn.js";
import type { Entity } from "../schema/entity.js";
import type { Rng } from "../rules/rng.js";
import { SPELLS } from "../content/srd/spells.js";

/**
 * VIEW MODELS — the contract between the engine and any client.
 *
 * Everything a UI needs, already computed, already explained. No client should have to
 * reach into `GameState` and re-derive an armour class or work out why a DC moved: the
 * engine knows, and it knows *why*, so it says so here.
 *
 * That is the point of this layer. It keeps game logic out of components, it means the
 * mobile and desktop clients cannot disagree about a number, and it makes the UI job pure
 * rendering rather than archaeology.
 */

// ------------------------------------------------------------------ roll card

export interface RollCardModel {
  purpose: string;
  natural: number;
  /** The other die under advantage or disadvantage. */
  other: number | null;
  advantage: "none" | "advantage" | "disadvantage";
  /** Each modifier with where it came from: "+3 dex", "−2 dim light". */
  parts: Array<{ label: string; value: number }>;
  total: number;
  target: number | null;
  outcome: string;
  /** Degree band for checks; null on attacks. */
  degree: Roll["degree"];
  critical: boolean;
  fumble: boolean;
}

/**
 * The most important component in the client.
 *
 * A DM who rolls behind a screen is trusted because they are a person. Software that rolls
 * behind a screen is suspected because it is not — so every number, and every reason for
 * it, is on the card.
 */
export function rollCard(r: Roll): RollCardModel {
  return {
    purpose: r.purpose,
    natural: r.raw,
    other: r.raw_second,
    advantage: r.advantage,
    // Itemised where the engine recorded sources, and honest about the total where it
    // did not — never an invented split.
    parts: r.parts.length > 0 ? r.parts : r.mods === 0 ? [] : [{ label: "modifiers", value: r.mods }],
    total: r.total,
    target: r.target,
    outcome: r.degree
      ? DEGREE_LABEL[r.degree]
      : r.success === null ? "" : r.success ? (r.critical ? "CRITICAL HIT" : "HIT") : (r.fumble ? "CRITICAL MISS" : "MISS"),
    degree: r.degree,
    critical: r.critical,
    fumble: r.fumble,
  };
}

// -------------------------------------------------------------- action palette

export interface PaletteGroup {
  key: string;
  label: string;
  items: Affordance[];
}

export interface PaletteModel {
  groups: PaletteGroup[];
  /** Combat only: which pips are still available. */
  economy: { action: boolean; bonus: boolean; moves: number; reaction: boolean } | null;
  round: number | null;
  /** Rules lines not yet shown to this player, to surface once. */
  teach: Array<{ key: string; text: string }>;
}

const GROUP_LABEL: Record<string, string> = {
  turn: "Turn", attack: "Attack", spell: "Spells", move: "Movement",
  check: "Checks", talk: "Talk", item: "Items", rest: "Rest", self: "Other",
};
const GROUP_ORDER = ["attack", "spell", "check", "talk", "move", "item", "rest", "turn", "self"];

/**
 * The action bar, grouped and hotkey-ready.
 *
 * Unavailable entries are kept, with their reason. "No 2nd-level slots remaining" teaches
 * the resource; hiding the option teaches nothing, and the player learns the action economy
 * by watching pips go out rather than by reading a manual.
 */
export function palette(s: GameState, actorId?: string): PaletteModel {
  const list = affordances(s, actorId ?? s.meta.pc_id);
  const byGroup = new Map<string, Affordance[]>();
  for (const a of list) {
    const g = byGroup.get(a.group) ?? [];
    g.push(a);
    byGroup.set(a.group, g);
  }

  const groups = GROUP_ORDER
    .filter((g) => byGroup.has(g))
    .map((g) => ({ key: g, label: GROUP_LABEL[g] ?? g, items: byGroup.get(g)! }));

  const me = s.combat?.order.find((c) => c.entity_id === (actorId ?? s.meta.pc_id));
  const teach: Array<{ key: string; text: string }> = [];
  const seen = new Set(s.meta.taught);
  for (const a of list) {
    if (a.teaches && !seen.has(a.teaches.key)) { teach.push(a.teaches); seen.add(a.teaches.key); }
  }

  return {
    groups,
    economy: me ? { action: me.economy.action, bonus: me.economy.bonus, moves: me.economy.moves, reaction: me.economy.reaction } : null,
    round: s.combat?.round ?? null,
    teach,
  };
}

// ------------------------------------------------------------------ the map

export interface MapNode {
  id: string;
  name: string;
  x: number;
  y: number;
  /**
   * known    — a landmark you have heard of but never walked
   * seen     — discovered in play, not yet entered
   * visited  — you have been there
   */
  state: "known" | "seen" | "visited";
  danger: number;
  settlement_id: string | null;
  /** Why it is pinned, if it is. */
  pins: Array<"player" | "quest" | "lead" | "settlement">;
  /** Minutes to walk there, or null if there is no known route. */
  travel_minutes: number | null;
  /**
   * Who the player knows is here.
   *
   * Deliberately NOT everybody who is here. A map that shows the position of every person
   * in the world is a map that answers questions the player has not asked anybody — it
   * would give away where Saveri Crole is before they have found a single person willing
   * to say her name. So: everyone in the room you are standing in, and elsewhere, only
   * people you have actually met, in places you have actually been.
   */
  people: string[];
  /** The ground inside, for the scale where you are standing in it. */
  zones: Array<{ id: string; name: string; terrain: string[]; people: string[]; you: boolean }>;
}

/**
 * A town, as one thing.
 *
 * The map has three honest scales and they answer different questions. A region asks
 * "where in the world"; a town asks "which building"; a building asks "which room, and
 * who is in it". Drawing all three at once produces a map that answers none of them,
 * which is what a single flat grid of every location was doing.
 */
export interface MapSettlement {
  id: string;
  name: string;
  x: number;
  y: number;
  location_ids: string[];
  /** Everyone the player knows is anywhere inside. */
  people: string[];
  /** True when the player is standing somewhere in it. */
  here: boolean;
}

export interface MapModel {
  settlements: MapSettlement[];
  nodes: MapNode[];
  edges: Array<{ from: string; to: string; locked: boolean }>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  player_at: string;
}

/**
 * Fog of war is not a rendering choice: undiscovered locations are simply absent, so a
 * client cannot leak the shape of the map by drawing greyed nodes in the right places.
 */
/**
 * WHO THE PLAYER KNOWS IS WHERE.
 *
 * Two separate jobs, and conflating them is how a map either lies or becomes unreadable.
 *
 * KNOWLEDGE. A dot on a map is an assertion that you know where somebody is. You know it
 * if you can see them, or if somebody told you — and "somebody told you" is a real thing
 * in this engine, not a guess: a fact you know whose subjects name both the person and the
 * place IS being told where to find them. Anything else would hand you Saveri Crole
 * before a single person has been willing to say her name.
 *
 * CLUTTER. Two hundred and fifty named locals are the texture of a living town and they
 * are not map furniture. A local shows only in the room you are standing in — which is
 * exactly when they matter, because that is when you can talk to them. The barkeep with
 * the rumour is still there; he is just not a pin on a regional map.
 */
function peopleKnownAt(
  s: GameState,
  locationId: string,
  here: string,
  met: ReadonlySet<string>,
  told: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const loc = s.locations[locationId];
  if (!loc) return [];

  return Object.values(s.entities)
    .filter((e) => {
      if (!e.alive || e.id === s.meta.pc_id || e.kind === "monster") return false;
      if (e.location_id !== locationId) return false;
      // In the room with you: you can see them, whoever they are.
      if (locationId === here) return true;
      // Extras stay off the regional map. They are texture, not landmarks.
      if (e.tier === "local") return false;
      // Somewhere you have been, and somebody you have met.
      if (loc.visited_count > 0 && met.has(e.id)) return true;
      // Or somebody told you exactly where to find them.
      return told.get(e.id)?.has(locationId) === true;
    })
    .map((e) => e.name)
    .sort();
}


export function mapModel(s: GameState): MapModel {
  const here = pc(s).location_id;
  // "Met" is a relationship row in either direction — the same test the rest of the
  // engine uses for whether two people have any history at all.
  const met = new Set<string>();
  for (const key of Object.keys(s.relationships)) {
    const [a, b] = key.split("->");
    if (a === s.meta.pc_id && b) met.add(b);
    if (b === s.meta.pc_id && a) met.add(a);
  }
  const told = whereaboutsTold(s);
  const routes = new Map(reachable(s, here).map((r) => [r.id, r.path.minutes]));

  const questTargets = new Set<string>();
  const leadTargets = new Set<string>();
  for (const q of Object.values(s.quests)) {
    if (q.status !== "active") continue;
    const step = q.steps.find((st) => st.id === q.current_step_id);
    for (const t of step?.completion_triggers ?? []) {
      if (t.match?.location_id) questTargets.add(t.match.location_id);
    }
    for (const l of q.leads) if (l.points_to_location_id) leadTargets.add(l.points_to_location_id);
  }

  const nodes: MapNode[] = [];
  for (const l of Object.values(s.locations)) {
    // Landmarks are on the map from the start — someone who grew up in this world knows
    // where the towns are. Everything else has to be found.
    if (!l.discovered && l.map_visibility !== "landmark") continue;
    const pins: MapNode["pins"] = [];
    if (l.id === here) pins.push("player");
    if (questTargets.has(l.id)) pins.push("quest");
    if (leadTargets.has(l.id)) pins.push("lead");
    if (l.settlement_id) pins.push("settlement");
    nodes.push({
      id: l.id, name: l.name, x: l.coords.x, y: l.coords.y,
      state: l.visited_count > 0 ? "visited" : l.discovered ? "seen" : "known",
      people: peopleKnownAt(s, l.id, here, met, told),
      // Zones only matter at the scale where you are standing in the building.
      zones: l.zones.map((z) => ({
        id: z.id,
        name: z.name,
        terrain: z.terrain,
        people: l.id === here
          ? Object.values(s.entities)
              .filter((e) => e.alive && e.location_id === l.id && e.zone_id === z.id && e.id !== s.meta.pc_id)
              .map((e) => e.name).sort()
          : [],
        you: l.id === here && pc(s).zone_id === z.id,
      })),
      danger: l.danger_level, settlement_id: l.settlement_id, pins,
      travel_minutes: l.id === here ? 0 : (routes.get(l.id) ?? null),
    });
  }

  const known = new Set(nodes.map((n) => n.id));
  const edges: MapModel["edges"] = [];
  const seenEdge = new Set<string>();
  for (const l of Object.values(s.locations)) {
    if (!known.has(l.id)) continue;
    for (const x of visibleExits(s, l)) {
      if (!known.has(x.to)) continue;
      const key = [l.id, x.to].sort().join("|");
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      edges.push({ from: l.id, to: x.to, locked: !!x.locked_by });
    }
  }

  const xs = nodes.map((n) => n.x); const ys = nodes.map((n) => n.y);
  // Towns are the middle scale: the centre of mass of their locations, and everybody the
  // player knows is inside any of them.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const settlements: MapSettlement[] = Object.values(s.settlements).map((st) => {
    const mine = st.location_ids.map((id) => byId.get(id)).filter((n): n is MapNode => !!n);
    const n = Math.max(1, mine.length);
    return {
      id: st.id,
      name: st.name,
      x: mine.reduce((a, m) => a + m.x, 0) / n,
      y: mine.reduce((a, m) => a + m.y, 0) / n,
      location_ids: mine.map((m) => m.id),
      people: [...new Set(mine.flatMap((m) => m.people))].sort(),
      here: st.location_ids.includes(here),
    };
  }).filter((st) => st.location_ids.length > 0);

  return {
    settlements,
    nodes, edges, player_at: here,
    bounds: {
      minX: Math.min(...xs, 0), minY: Math.min(...ys, 0),
      maxX: Math.max(...xs, 1), maxY: Math.max(...ys, 1),
    },
  };
}

// ------------------------------------------------------------------ the party

export interface CompanionModel {
  id: string;
  name: string;
  pronouns: string;
  hp: { current: number; max: number };
  /** A word, not a number. Numbers live in the debug view. */
  tier: string;
  opinion: string;
  /** Their recent reactions, newest first: what moved them and why. */
  history: Array<{ turn: number; reason: string; direction: "up" | "down" }>;
  policy: string;
  down: boolean;
  refusing: boolean;
  about_to_leave: boolean;
  arc_quest_id: string | null;
}

export function partyModel(s: GameState): CompanionModel[] {
  return s.meta.party_ids
    .filter((id) => id !== s.meta.pc_id)
    .map((id) => s.entities[id])
    .filter((e): e is NonNullable<typeof e> => !!e)
    .map((e) => {
      const rel = s.relationships[`${e.id}->${s.meta.pc_id}`];
      return {
        id: e.id, name: e.name, pronouns: e.pronouns,
        hp: { current: e.hp.current, max: e.hp.max },
        tier: tierOf(s, e.id),
        opinion: rel?.opinion ?? "",
        history: (rel?.history ?? []).slice(-6).reverse().map((h) => ({
          turn: h.turn,
          reason: h.reason,
          direction: (h.dims.affinity ?? 0) >= 0 ? "up" as const : "down" as const,
        })),
        policy: e.ai_policy ?? "cautious",
        down: e.hp.current === 0,
        refusing: willRefuse(s, e.id),
        about_to_leave: wouldLeave(s, e.id),
        arc_quest_id: e.personal_arc_quest_id,
      };
    });
}

// ---------------------------------------------------------- quests and clocks

export interface QuestModel {
  id: string;
  title: string;
  status: string;
  summary: string;
  objective: string | null;
  leads: Array<{ text: string; from: string | null; points_to: string | null }>;
  clocks: Array<{ id: string; name: string; filled: number; segments: number }>;
  /**
   * What you could actually do about this, from where you are standing.
   *
   * The journal used to list the quest and its leads and stop there, which reads as a
   * record of the past rather than a way into the next scene: the player knew they were
   * looking for Bryn and had no idea what the game wanted from them next. These are
   * derived from live state every turn — a lead that points somewhere you can reach says
   * how far, a person who was named says where they were last seen.
   */
  next: Array<{ text: string; detail: string }>;
  /** The turn this quest last moved, so the client can mark what is new. */
  updated_turn: number;
}

export function questModel(s: GameState): QuestModel[] {
  return Object.values(s.quests)
    .filter((q) => q.visibility !== "hidden")
    .sort((a, b) => (a.status === "active" ? -1 : 1) - (b.status === "active" ? -1 : 1))
    .map((q) => ({
      id: q.id, title: q.title, status: q.status, summary: q.summary,
      objective: q.steps.find((st) => st.id === q.current_step_id)?.desc ?? null,
      leads: q.leads.map((l) => ({
        text: l.text,
        from: l.source_entity_id ? s.entities[l.source_entity_id]?.name ?? null : null,
        points_to: l.points_to_location_id,
      })),
      // dm_notes NEVER appears here. It is the DM's, not the player's.
      clocks: Object.values(s.clocks)
        .filter((c) => c.quest_id === q.id && c.visible && !c.done)
        .map((c) => ({ id: c.id, name: c.name, filled: c.filled, segments: c.segments })),
      next: q.status === "active" ? nextMoves(s, q.id) : [],
      updated_turn: q.updated_turn ?? 0,
    }));
}

/**
 * Concrete next moves for an active quest, read off the world as it is right now.
 *
 * Deliberately code-derived rather than written by the narrator: a suggestion that says
 * "go to the Waterline, 14 minutes" is only worth printing if the route is real, and the
 * only thing that knows whether it is real is the pathfinder. Knowledge-gated throughout
 * — a lead pointing at a place you have never heard of says so rather than naming it.
 */
function nextMoves(s: GameState, questId: string): Array<{ text: string; detail: string }> {
  const q = s.quests[questId];
  if (!q) return [];
  const here = pc(s).location_id;
  const routes = new Map(reachable(s, here).map((r) => [r.id, r.path.minutes]));
  const told = whereaboutsTold(s);
  const out: Array<{ text: string; detail: string; minutes?: number }> = [];
  const seen = new Set<string>();
  // Deduped on the TEXT: the same lead arrives twice often enough, and two identical rows
  // in a list of five is a list of four that looks broken.
  const push = (text: string, detail: string, minutes?: number) => {
    const k = text.toLowerCase().trim();
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ text, detail, ...(minutes === undefined ? {} : { minutes }) });
  };

  /**
   * Newest leads first, and not many of them.
   *
   * Leads accumulate for the whole campaign, so an untrimmed list offers the player
   * something Sibby said two in-game days and one town ago as though it were the next
   * move. That is the same failure the suggestion chips had, one screen over.
   */
  for (const l of [...q.leads].reverse().slice(0, 6)) {
    const dest = l.points_to_location_id ? s.locations[l.points_to_location_id] : undefined;
    if (dest && (dest.discovered || dest.visited_count > 0)) {
      if (dest.id === here) { push(l.text, "you are here", 0); continue; }
      const mins = routes.get(dest.id);
      if (mins === undefined) { push(`Go to ${dest.name}`, "no way you know"); continue; }
      // Somewhere a day's walk away is not a next move, it is a decision. Say the cost
      // in units a person uses, and let the far ones sort to the bottom.
      push(`Go to ${dest.name}`, travelWords(mins), mins);
    } else {
      push(l.text, l.source_entity_id ? `from ${s.entities[l.source_entity_id]?.name ?? "someone"}` : "");
    }
  }

  // People the quest names, and where you last knew them to be. This is what turns
  // "find out about the courier" into "Cotter Vane is at the forge".
  const named = new Set<string>([
    ...(q.giver_entity_id ? [q.giver_entity_id] : []),
    ...s.facts.filter((f) => f.quest_ids.includes(q.id) && f.known_by.includes(s.meta.pc_id))
      .flatMap((f) => f.subjects),
  ]);
  for (const id of named) {
    const e = s.entities[id];
    if (!e || !e.alive || id === s.meta.pc_id) continue;
    if (e.location_id === here) { push(`Speak with ${e.name}`, "here with you", 0); continue; }
    const where = s.locations[e.location_id];
    if (!where) continue;
    const known = told.get(id)?.has(e.location_id) || where.visited_count > 0;
    if (!known) continue;
    const mins = routes.get(where.id);
    push(`Find ${e.name} at ${where.name}`, mins !== undefined ? travelWords(mins) : "", mins);
  }

  // Near things first. A player asking what to do next means what to do NEXT.
  out.sort((a, b) => (a.minutes ?? 9999) - (b.minutes ?? 9999));
  return out.slice(0, 5).map(({ text, detail }) => ({ text, detail }));
}

/** "40 min", "3 hours", "most of a day" - never "926 min". */
function travelWords(mins: number): string {
  if (mins < 90) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 10) return `${hours} hours`;
  if (hours < 20) return "most of a day";
  return `${Math.round(hours / 24)} days`;
}

/**
 * What you are carrying, and what you can do with it WITHOUT typing a sentence.
 *
 * The pack tab listed names and nothing else, which was reasonable while the item verbs
 * were unimplemented and absurd afterwards: the player could see the Accord steel and
 * still had to guess the words that would draw it. Every action here comes from the
 * affordance engine, so a button can never offer something the resolver would refuse.
 */
export interface PackItemModel {
  instance_id: string;
  name: string;
  qty: number;
  kind: string;
  desc: string;
  /** "main_hand", "armor", ... when it is being worn or held. */
  slot: string | null;
  /** Things that matter to a quest are worth marking. */
  notable: boolean;
  actions: Array<{ label: string; action: unknown; detail: string }>;
}

export function packModel(s: GameState, actorId?: string): PackItemModel[] {
  const who = actorId ?? s.meta.pc_id;
  const actor = s.entities[who];
  if (!actor) return [];
  const bar = affordances(s, who).filter((a) => a.available);

  return itemsOwnedBy(s, who).map((inst) => {
    const def = s.item_defs[inst.def_id];
    const slot = (["main_hand", "off_hand", "armor", "trinket"] as const)
      .find((sl) => actor.equipped[sl] === inst.id) ?? null;

    // Only the affordances that name THIS object, so the buttons cannot drift from
    // what the engine would actually allow.
    const actions = bar
      .filter((a) => {
        const act = a.action as { type?: string; item_instance_id?: string };
        return (act.type === "equip" || act.type === "use_item") && act.item_instance_id === inst.id;
      })
      .map((a) => ({ label: a.label, action: a.action, detail: a.detail }));

    // The bar already offers "Unequip X" for worn gear, so only add a way to take it off
    // when it does not — two buttons that do the same thing under different words is
    // worse than one, and the pack showed exactly that.
    const canRemove = actions.some((a) => {
      const act = a.action as { type?: string; slot?: string | null };
      return act.type === "equip" && act.slot === null;
    });
    if (slot && !canRemove) {
      actions.push({
        label: `Stow ${def?.name ?? "it"}`,
        action: { type: "equip", item_instance_id: inst.id, slot: null },
        detail: "",
      });
    }

    return {
      instance_id: inst.id,
      name: def?.name ?? inst.def_id,
      qty: inst.qty,
      kind: def?.kind ?? "misc",
      desc: def?.desc ?? "",
      slot,
      notable: def?.tags.includes("quest") ?? false,
      actions,
    };
  });
}

/**
 * Everything you have established as true, for the journal.
 *
 * The fact ledger is the most interesting thing in a save and the player could not see
 * any of it. Knowledge-gated by construction: `factsKnownToPc` is the same gate the
 * prompt uses, so the journal can never show something the DM would not say out loud.
 */
export interface KnownFactModel {
  id: string;
  text: string;
  kind: string;
  turn: number;
  importance: number;
  /** Who or what it is about, in names rather than ids. */
  about: string[];
  /** Where it belongs on the shelf: a place name, a person, or "The world". */
  group: string;
}

export function knownModel(s: GameState): KnownFactModel[] {
  const nameOf = (id: string) =>
    s.entities[id]?.name ?? s.locations[id]?.name ?? s.world.factions[id]?.name ?? null;

  return factsKnownToPc(s)
    .map((f) => {
      const about = f.subjects.map(nameOf).filter((n): n is string => !!n);
      const place = f.location_id ? s.locations[f.location_id]?.name : null;
      return {
        id: f.id,
        text: f.text,
        kind: f.kind,
        turn: f.turn,
        importance: f.importance,
        about,
        group: place ?? about[0] ?? "The world",
      };
    })
    // Newest first: what you just learned is what you are most likely looking for.
    .sort((a, b) => b.turn - a.turn || a.id.localeCompare(b.id));
}

export interface VowModel {
  id: string; text: string; rank: string; boxes: number; progress: number; status: string;
}

export function vowModel(s: GameState): VowModel[] {
  return Object.values(s.vows).map((v) => ({
    id: v.id, text: v.text, rank: v.rank,
    boxes: filledBoxes(v), progress: v.progress, status: v.status,
  }));
}

// ------------------------------------------------------------- character sheet

export interface SheetModel {
  name: string;
  pronouns: string;
  level: number;
  xp: { current: number; next: number | null; into: number; span: number };
  hp: { current: number; max: number; temp: number };
  /** Shown as its computation: "11 leather + 3 dex = 14". */
  ac: { total: number; parts: Array<{ label: string; value: number }> };
  abilities: Array<{ key: string; score: number; mod: number }>;
  skills: Array<{ key: string; mod: number; proficient: boolean; expertise: boolean; ability: string }>;
  conditions: Array<{ id: string; until: string | null }>;
  slots: Array<{ level: number; used: number; max: number }>;
  hit_dice: { used: number; max: number };
  inspiration: { held: number; cap: number };
  purse: string;
  inventory: Array<{
    id: string; name: string; qty: number; equipped: boolean; nickname: string | null;
    /** What the client should lift out of the list. Quest items should never be lost in it. */
    importance: "quest" | "magic" | "valuable" | "mundane";
  }>;
}

export function sheetModel(s: GameState, entityId?: string): SheetModel {
  const e = s.entities[entityId ?? s.meta.pc_id]!;
  const ac = computeAC(s, e);
  const nextAt = e.level < XP_THRESHOLDS.length ? XP_THRESHOLDS[e.level] ?? null : null;
  const prevAt = XP_THRESHOLDS[e.level - 1] ?? 0;

  return {
    name: e.name, pronouns: e.pronouns, level: e.level,
    xp: {
      current: e.xp, next: nextAt,
      // Clamped: an authored character can start at level 2 with 0 XP, and a negative
      // progress bar is a bug the player would see before we would.
      into: Math.max(0, e.xp - prevAt),
      span: nextAt === null ? 0 : nextAt - prevAt,
    },
    hp: { current: e.hp.current, max: e.hp.max, temp: e.hp.temp },
    ac,
    abilities: (["str", "dex", "con", "int", "wis", "cha"] as const).map((k) => ({
      key: k, score: e.abilities[k], mod: abilityMod(e.abilities[k]),
    })),
    skills: Object.keys(SKILL_ABILITY).map((k) => ({
      key: k,
      mod: skillModifier(e, k as never),
      proficient: e.proficiencies.skills.includes(k as never),
      expertise: e.expertise.includes(k as never),
      ability: SKILL_ABILITY[k as never],
    })),
    conditions: e.conditions.map((c) => ({
      id: c.id,
      until: c.expires_round !== null ? `round ${c.expires_round}` : c.expires_world_minute !== null ? "timed" : null,
    })),
    slots: Object.entries(e.resources.spell_slots)
      .map(([lvl, t]) => ({ level: Number(lvl), used: t.used, max: t.max }))
      .sort((a, b) => a.level - b.level),
    hit_dice: e.resources.hit_dice,
    inspiration: { held: inspirationOf(e), cap: inspirationCap(s) },
    purse: formatCoin(purseOf(s, e.id)),
    inventory: itemsOwnedBy(s, e.id).map((i) => {
      const def = s.item_defs[i.def_id];
      return {
        id: i.id,
        name: def?.name ?? i.def_id,
        qty: i.qty,
        equipped: Object.values(e.equipped).includes(i.id),
        nickname: i.nickname,
        importance: itemImportance(def, i.attunement),
      };
    }),
  };
}

/**
 * What the client should lift out of a list of twenty things.
 *
 * A quest item buried between two torches and a rope is a quest item the player will walk
 * past. Sorting is not enough — the list needs to say which line matters.
 */
function itemImportance(
  def: { tags: string[]; value_cp: number; grants: unknown[] } | undefined,
  attuned: string | null,
): "quest" | "magic" | "valuable" | "mundane" {
  if (!def) return "mundane";
  if (def.tags.includes("quest")) return "quest";
  if (attuned !== null || def.tags.includes("magic")) return "magic";
  if (def.value_cp >= 5000 || def.grants.length > 0) return "valuable";
  return "mundane";
}

// ----------------------------------------------------------------- the scene

export interface SceneModel {
  location: { id: string; name: string; description: string; light: string };
  time: { label: string; hour: number; day: number; weather: string };
  present: Array<{ id: string; name: string; descriptor: string; disposition: string; down: boolean }>;
  items_here: Array<{ id: string; name: string }>;
  exits: Array<{ dir: string; to: string | null; name: string | null; locked: boolean }>;
  in_combat: boolean;
  /**
   * The room as one presence, when there are enough people in it to be a room rather than
   * a list. Null in an empty corridor. The client should render this as atmosphere — a
   * line under the scene — never as a row per person.
   */
  crowd: { size: number; mood: number; label: string } | null;
  /** Which scene this is, so the feed can draw a divider when it changes. */
  scene_id: string;
}

export function sceneModel(s: GameState): SceneModel {
  const p = pc(s);
  const loc = s.locations[p.location_id]!;
  return {
    location: {
      id: loc.id, name: loc.name,
      description: loc.visited_count <= 1 && loc.long_desc ? loc.long_desc : loc.short_desc,
      light: loc.ambient.light,
    },
    time: {
      label: timeOfDayLabel(s), hour: hourOfDay(s),
      day: Math.floor(s.world.world_minute / 1440) + 1,
      weather: s.world.weather.current,
    },
    present: npcsPresent(s, loc.id).map((e) => ({
      id: e.id, name: e.name, descriptor: e.descriptor,
      disposition: dispositionOf(s.relationships[`${e.id}->${s.meta.pc_id}`]?.dims.affinity ?? 0),
      down: e.hp.current === 0,
    })),
    items_here: loc.contains_item_ids
      .map((id) => s.items[id])
      .filter((i): i is NonNullable<typeof i> => !!i)
      .map((i) => ({ id: i.id, name: s.item_defs[i.def_id]?.name ?? i.def_id })),
    exits: visibleExits(s, loc).map((x) => ({
      dir: x.dir, to: x.to,
      name: s.locations[x.to]?.discovered ? s.locations[x.to]!.name : null,
      locked: !!x.locked_by,
    })),
    in_combat: s.combat !== null,
    crowd: (() => {
      const c = crowdAt(s, loc.id);
      return c ? { size: c.size, mood: c.mood, label: c.label } : null;
    })(),
    scene_id: s.world.scene_id,
  };
}

// --------------------------------------------------------------- combat view

export interface CombatModel {
  round: number;
  current: string;
  order: Array<{
    id: string; name: string; initiative: number; side: "party" | "enemy";
    hp: { current: number; max: number }; conditions: string[]; fled: boolean; is_current: boolean;
    /** What they are about to do — Slay the Spire's enemy intent. Free, because the CPU
     *  policy is deterministic given state. */
    intent: string | null;
  }>;
  objective: string;
  zones: Array<{ id: string; name: string; occupants: string[]; adjacent: string[]; terrain: string[]; ground: string }>;
  concentration: Array<{ who: string; spell: string }>;
}

// -------------------------------------------------------------- history log

export interface TimelineRowModel {
  turn: number;
  type: string;
  summary: string;
  world_minute: number;
  cascades: number;
  /** The causal chain beneath this turn: what it set off, and via which trigger. */
  children: Array<{ type: string; trigger: string | null; summary: string }>;
}

/**
 * THE CASCADE INSPECTOR.
 *
 * Every consequence already records what caused it and which trigger fired, so any event
 * can show its full chain: you killed Garret → `t_garret_falls` → Ashen Hand −30 → spilled
 * −9 onto four members → a fact was written → three people witnessed it.
 *
 * No other game in this genre can show this, because no other one keeps the graph. Here it
 * costs one join.
 */
export function timelineModel(s: GameState, journal: readonly GameEvent[]): TimelineRowModel[] {
  const rows = timeline(journal, (id) =>
    s.entities[id]?.name ?? s.locations[id]?.name ?? s.quests[id]?.title ?? id);
  const byParent = new Map<string, GameEvent[]>();
  for (const e of journal) {
    if (!e.derived_from) continue;
    const list = byParent.get(e.derived_from) ?? [];
    list.push(e);
    byParent.set(e.derived_from, list);
  }
  const roots = journal.filter((e) => e.derived_from === null);

  return rows.map((r, i) => {
    const root = roots[i];
    const kids = root ? byParent.get(root.id) ?? [] : [];
    return {
      ...r,
      children: kids.map((k) => ({
        type: k.type,
        trigger: k.trigger_id,
        summary: describeCascade(s, k),
      })),
    };
  });
}

function describeCascade(s: GameState, e: GameEvent): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "death": return `${s.entities[String(p["entity_id"] ?? "")]?.name ?? "someone"} died`;
    case "quest_update": return `${s.quests[String(p["quest_id"] ?? "")]?.title ?? "a quest"} → ${String(p["status"] ?? "")}`;
    case "enter_location": return `entered ${s.locations[e.location_id ?? ""]?.name ?? "somewhere"}`;
    case "clock": return `${String(p["name"] ?? "a clock")} ${String(p["filled"])}/${String(p["segments"])}`;
    case "level_up": return `reached level ${String(p["level"])}`;
    case "inspiration": return `earned inspiration`;
    case "combat_end": return `the fight ended (${String(p["winner"])})`;
    default: return e.type;
  }
}

// -------------------------------------------------------------- the whole feed

export interface FeedEntry {
  kind: "narration" | "mechanics" | "ambient" | "system";
  /** Prose, already linked to entities the client can open. */
  spans: TextSpan[];
  rolls: RollCardModel[];
  turn: number;
}

export function narrationEntry(s: GameState, text: string, rolls: readonly Roll[], turn: number): FeedEntry {
  return { kind: "narration", spans: linkText(s, text), rolls: rolls.map(rollCard), turn };
}

/** Everything a client needs for one screen, in one call. */
export interface ConversationModel {
  with: { id: string; name: string; descriptor: string; disposition: string };
  topics: Topic[];
  /** Rising as you press. Past the limit they end it. */
  friction: number;
}

export interface ScreenModel {
  scene: SceneModel;
  conversation: ConversationModel | null;
  sheet: SheetModel;
  party: CompanionModel[];
  quests: QuestModel[];
  /**
   * The turn this screen describes.
   *
   * The journal marks what moved since you last looked, and that comparison needs a
   * number the client can hold on to between paints.
   */
  turn: number;
  /** What you carry, with the buttons that act on it. */
  pack: PackItemModel[];
  /** What you have established as true. */
  known: KnownFactModel[];
  /** Promises, debts and errands the story picked up. See schema/thread.ts. */
  threads: ThreadModel[];
  /** Everyone the player has met. */
  people: PersonModel[];
  vows: VowModel[];
  palette: PaletteModel;
  map: MapModel;
}

export function conversationModel(s: GameState): ConversationModel | null {
  const c = s.conversation;
  if (!c) return null;
  const e = s.entities[c.with_id];
  if (!e) return null;
  return {
    with: {
      id: e.id, name: e.name, descriptor: e.descriptor,
      disposition: dispositionOf(s.relationships[`${e.id}->${s.meta.pc_id}`]?.dims.affinity ?? 0),
    },
    topics: topicsFor(s, e.id),
    friction: c.friction,
  };
}

export interface ThreadModel {
  id: string; text: string; status: string; from: string | null; outcome: string;
  /** True when somebody this is about is standing in front of you. */
  here: boolean;
}

/**
 * Open promises first, then what recently became of the others.
 *
 * Settled threads are kept in the list on purpose, briefly: a side quest you finished is
 * one of the few places a text game can show a player that the world noticed.
 */
export function threadModel(s: GameState): ThreadModel[] {
  const hereIds = new Set(
    Object.values(s.entities)
      .filter((e) => e.alive && e.location_id === pc(s).location_id)
      .map((e) => e.id),
  );
  const all = Object.values(s.threads);
  const rank = (t: { status: string }) => (t.status === "open" ? 0 : 1);
  return all
    .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
    .slice(0, 24)
    .map((t) => ({
      id: t.id,
      text: t.text,
      status: t.status,
      from: t.from_entity_id ? s.entities[t.from_entity_id]?.name ?? null : null,
      outcome: t.outcome,
      here: t.subject_ids.some((id) => hereIds.has(id)),
    }));
}

export interface PersonModel {
  id: string;
  name: string;
  descriptor: string;
  /** How they read to you, in words. */
  disposition: string;
  /** Where you last knew them to be, or "" if you do not. */
  where: string;
  /** Their own words about you, when they have formed any. */
  opinion: string;
}

/**
 * THE CAST, AS THE PLAYER KNOWS IT.
 *
 * The people are the half of a campaign anybody actually keeps in their head, and they
 * lived nowhere in the interface — every name was in scrollback. This is the player's
 * journal, not the DM's notes, so it holds people they have MET: a relationship row in
 * either direction, which is the same test the rest of the engine uses for whether two
 * people have any history at all.
 */
export function peopleModel(s: GameState): PersonModel[] {
  const me = s.meta.pc_id;
  const met = new Set<string>();
  for (const key of Object.keys(s.relationships)) {
    const [a, b] = key.split("->");
    if (a === me && b) met.add(b);
    if (b === me && a) met.add(a);
  }

  const here = pc(s).location_id;
  return [...met]
    .map((id) => s.entities[id])
    .filter((e): e is Entity => !!e && e.kind !== "monster" && e.id !== me)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => {
      const rel = s.relationships[`${e.id}->${me}`];
      const loc = s.locations[e.location_id];
      // Where they are is only knowable if you can see them or have been there.
      const known = e.location_id === here || (loc && loc.visited_count > 0);
      return {
        id: e.id,
        name: e.name,
        descriptor: e.descriptor,
        disposition: e.alive
          ? (rel ? dispositionOf(rel.dims.affinity) : "hard to read")
          : "dead",
        where: known && loc ? loc.name : "",
        opinion: rel?.opinion ?? "",
      };
    });
}

export function screen(s: GameState): ScreenModel {
  return {
    scene: sceneModel(s),
    conversation: conversationModel(s),
    sheet: sheetModel(s),
    party: partyModel(s),
    quests: questModel(s),
    turn: s.meta.turn,
    pack: packModel(s),
    known: knownModel(s),
    threads: threadModel(s),
    people: peopleModel(s),
    vows: vowModel(s),
    palette: palette(s),
    map: mapModel(s),
  };
}

export type { Affordance, Cost };

/**
 * The combat panel, including ENEMY INTENT.
 *
 * Slay the Spire's best idea: every monster shows what it is about to do. It removes
 * guesswork without removing difficulty, and here it is nearly free — the CPU policy is a
 * pure function of state, so asking it what a creature would do costs one call and changes
 * nothing. It is also how a good DM narrates a monster's posture: you can see it winding up.
 */
export function combatModel(s: GameState, rng: Rng): CombatModel | null {
  const c = s.combat;
  if (!c) return null;
  const loc = s.locations[c.location_id];

  const order = c.order.map((cb, i) => {
    const e = s.entities[cb.entity_id]!;
    let intent: string | null = null;
    if (e.controller === "cpu" && e.alive && e.hp.current > 0 && !cb.fled) {
      // Ask the policy what it would do. Deterministic given state, so this is a preview
      // rather than a commitment — and it costs nothing to show.
      const action = choosePolicyAction(s, c, e, rng);
      intent = describeIntent(s, e, action);
    }
    return {
      id: e.id, name: e.name, initiative: cb.initiative, side: cb.side,
      hp: { current: e.hp.current, max: e.hp.max },
      conditions: e.conditions.map((x) => x.id),
      fled: cb.fled, is_current: i === c.current, intent,
    };
  });

  const occupants = new Map<string, string[]>();
  for (const cb of c.order) {
    const e = s.entities[cb.entity_id]!;
    if (cb.fled) continue;
    const z = e.zone_id ?? "";
    occupants.set(z, [...(occupants.get(z) ?? []), e.name]);
  }

  return {
    round: c.round,
    current: c.order[c.current]!.entity_id,
    order,
    // What the fight is for, if it is for anything but a body count. Without this on
    // screen an objective is a rule the player loses to without knowing it existed.
    objective: describeObjective(s, c),
    zones: (loc?.zones ?? []).map((z) => ({
      id: z.id, name: z.name, occupants: occupants.get(z.id) ?? [], adjacent: z.adjacent,
      // The ground, in words. A trait a player cannot see is set dressing.
      terrain: z.terrain.map((t) => TERRAIN[t].label),
      ground: describeZone(s, c.location_id, z.id),
    })),
    concentration: Object.entries(c.concentration).map(([who, con]) => ({
      who: s.entities[who]?.name ?? who,
      spell: con.spell_id.replace("spell_", "").replace(/_/g, " "),
    })),
  };
}

function describeIntent(s: GameState, e: Entity, a: Action): string {
  switch (a.type) {
    case "attack": return `about to strike ${s.entities[a.target_id]?.name ?? "someone"}`;
    case "cast": return `beginning to cast ${SPELLS[a.spell_id]?.name ?? "something"}`;
    case "move_zone": return `moving to ${s.locations[e.location_id]?.zones.find((z) => z.id === a.zone_id)?.name ?? "another position"}`;
    case "flee": return "looking for a way out";
    case "dash": return "closing the distance";
    case "dodge": return "bracing";
    default: return "holding";
  }
}
