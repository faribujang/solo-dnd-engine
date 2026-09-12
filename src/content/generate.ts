import { z } from "zod";
import type { GameState } from "../schema/state.js";
import { validateReferences } from "./loadCampaign.js";
import { Arc, Campaign } from "../schema/campaign.js";
import { Quest } from "../schema/quest.js";
import { Location } from "../schema/location.js";
import { Entity } from "../schema/entity.js";

/**
 * THE CONTENT GENERATOR — pipeline and guardrails.
 *
 * This is the right place for a language model to write, and it is worth being precise
 * about why: it produces **content, not runtime truth**. Output is validated, reviewed and
 * frozen as authored data, after which the engine cannot tell it from hand-written content
 * and the DM at play time has no authority it did not have before.
 *
 * The generator runs OFFLINE, in stages, because asking for a whole campaign in one call
 * produces a world where the third quest references a town the second one never built. Each
 * stage sees the frozen output of the last.
 */

export const STAGES = [
  "premise",     // one paragraph: what this campaign is about
  "world",       // regions, factions, settlements
  "arcs",        // 3–5 movements, each with a climax and seeds
  "quests",      // the quest graph, with dependencies
  "locations",   // rooms with coordinates, exits, features
  "cast",        // NPCs with personalities, secrets, relationships
  "wiring",      // triggers, leads, clocks connecting it together
  "validate",    // referential integrity + the three-clue lint
] as const;
export type Stage = (typeof STAGES)[number];

export const StagePrompt: Record<Stage, string> = {
  premise: "One paragraph. What is this campaign about, whose problem is it, and what happens if nobody solves it?",
  world: "The regions, factions and settlements this premise needs. Factions want things that conflict. Settlements have reasons to exist.",
  arcs: "Three to five arcs. Each is a movement of the story with its own climax, and each plants at least one SEED — a thread deliberately left open for a later arc or a later campaign.",
  quests: "The quest graph. Every quest has steps, every step has at least three independent ways to complete it (see the three-clue rule), and dm_notes carry what the player has not earned yet.",
  locations: "Rooms with coordinates on a shared grid, exits with travel times, features worth searching. Coordinates matter: the map is drawn from them.",
  cast: "The people. Each has a personality (trait, ideal, bond, flaw), a voice, something they want, and at least one thing they know that others do not.",
  wiring: "Triggers, leads and clocks connecting everything. A trigger for each way a step can complete. A clock for each situation that develops whether or not the party engages.",
  validate: "Check every reference resolves and every step has three routes.",
};

/** What each stage is expected to return, so a malformed stage fails at its own boundary. */
export const StageSchema: Record<Stage, z.ZodTypeAny> = {
  premise: z.object({ title: z.string(), premise: z.string().min(40) }),
  world: z.object({
    factions: z.array(z.object({ id: z.string(), name: z.string(), goals: z.array(z.string()) })),
    settlements: z.array(z.object({ id: z.string(), name: z.string(), population: z.number() })),
  }),
  arcs: z.object({ arcs: z.array(Arc) }),
  quests: z.object({ quests: z.array(Quest) }),
  locations: z.object({ locations: z.array(Location) }),
  cast: z.object({ entities: z.array(Entity) }),
  wiring: z.object({ ok: z.boolean() }),
  validate: z.object({ ok: z.boolean() }),
};

// ------------------------------------------------------------------ the lint

export interface ContentIssue {
  severity: "error" | "warning";
  where: string;
  message: string;
}

/**
 * THE THREE-CLUE RULE, as a lint.
 *
 * Justin Alexander's rule: any conclusion the players must reach needs three independent
 * routes, because they will miss two. It is the difference between a mystery and a wall,
 * and it is exactly the kind of principle that evaporates unless something checks for it.
 *
 * Our DM *can* improvise a fourth route — but only if the authored world gave it something
 * to improvise from, which is why this stays a warning on authored content rather than a
 * shrug at runtime.
 */
export function lintThreeClues(s: GameState): ContentIssue[] {
  const out: ContentIssue[] = [];

  for (const q of Object.values(s.quests)) {
    for (const step of q.steps) {
      if (step.status === "complete") continue;

      // Routes: a completion trigger, a lead pointing at it, or a fact that names it.
      let routes = step.completion_triggers.length;
      routes += q.leads.filter((l) => l.points_to_location_id || l.source_entity_id).length;
      routes += s.facts.filter((f) => f.quest_ids.includes(q.id) && !f.secret).length;

      if (routes < 3) {
        out.push({
          severity: "warning",
          where: `${q.id}/${step.id}`,
          message: `only ${routes} route(s) to "${step.desc}". Players will miss two — the rule of thumb is three.`,
        });
      }
    }
  }
  return out;
}

/** Content problems that are not broken references but will still ruin a session. */
export function lintContent(s: GameState): ContentIssue[] {
  const out: ContentIssue[] = [...lintThreeClues(s)];

  for (const l of Object.values(s.locations)) {
    if (l.coords.x === 0 && l.coords.y === 0 && l.id !== Object.keys(s.locations)[0]) {
      out.push({ severity: "warning", where: l.id, message: "no map coordinates; it will stack at the origin." });
    }
    if (l.exits.length === 0) {
      out.push({ severity: "error", where: l.id, message: "no exits — anyone who walks in is stuck." });
    }
    if (!l.short_desc) out.push({ severity: "error", where: l.id, message: "no short description; it is sent every turn." });
  }

  for (const e of Object.values(s.entities)) {
    if (e.kind === "npc" || e.kind === "companion") {
      if (!e.personality.voice) out.push({ severity: "warning", where: e.id, message: "no voice; the DM will make one up and it will drift." });
      if (!e.descriptor) out.push({ severity: "warning", where: e.id, message: "no descriptor; the DM has nothing to describe." });
    }
    if (e.kind === "companion" && e.approval.length === 0) {
      out.push({ severity: "warning", where: e.id, message: "a companion with no approval table reacts to nothing and reads as furniture." });
    }
  }

  for (const q of Object.values(s.quests)) {
    if (!q.dm_notes) out.push({ severity: "warning", where: q.id, message: "no dm_notes; the DM has no truth to withhold, so it cannot foreshadow." });
    if (q.steps.length === 0) out.push({ severity: "error", where: q.id, message: "no steps." });
  }

  // A world with nothing developing on its own is a world that waits for the player.
  if (Object.keys(s.clocks).length === 0) {
    out.push({ severity: "warning", where: "world", message: "no progress clocks; nothing develops unless the party touches it." });
  }

  return out;
}

/** Everything: references, then content. Run before freezing generated output. */
export function validateGenerated(s: GameState): { ok: boolean; issues: ContentIssue[] } {
  const issues: ContentIssue[] = [];
  try {
    validateReferences(s);
  } catch (err) {
    issues.push({ severity: "error", where: "references", message: err instanceof Error ? err.message : String(err) });
  }
  issues.push(...lintContent(s));
  return { ok: !issues.some((i) => i.severity === "error"), issues };
}

/**
 * The system prompt a generation stage runs under. Note what it forbids: this is content
 * authoring, so it may invent freely — but it may not invent IDS that do not resolve, and
 * it may not write mechanics, because those are the engine's.
 */
export function generatorSystem(stage: Stage, campaignTitle: string): string {
  return [
    `You are writing CONTENT for a solo D&D 5e campaign called "${campaignTitle}".`,
    `Stage: ${stage}. ${StagePrompt[stage]}`,
    "",
    "RULES:",
    "1. You are authoring a world, not running one. Invent freely — but every id you",
    "   reference must be one you or an earlier stage actually defined.",
    "2. Ids are snake_case with a type prefix: npc_, loc_, q_, item_def_, fac_, arc_.",
    "3. Never write numbers the engine owns: no DCs, no hit points you did not roll up as",
    "   a stat block, no XP values. Difficulty is expressed as a BAND.",
    "4. Use SRD 5.1 content only. No named published adventures, no Forgotten Realms",
    "   proper nouns, no non-SRD monsters.",
    "5. Every conclusion a player must reach needs at least THREE independent routes.",
    "   They will miss two.",
    "6. Every NPC gets a voice, a want, and one thing they know that others do not.",
    "7. Leave threads open on purpose. A seed is not a loose end; it is the next campaign.",
  ].join("\n");
}

export const CampaignBundle = z.object({
  campaign: Campaign,
  arcs: z.array(Arc),
  quests: z.array(Quest),
  locations: z.array(Location),
  entities: z.array(Entity),
});
export type CampaignBundle = z.infer<typeof CampaignBundle>;
