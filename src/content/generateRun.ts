import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { LLMClient } from "../llm/client.js";
import type { GameState } from "../schema/state.js";
import { GameState as GameStateSchema } from "../schema/state.js";
import { Arc, Campaign } from "../schema/campaign.js";
import { Entity } from "../schema/entity.js";
import { Location } from "../schema/location.js";
import { Quest } from "../schema/quest.js";
import { Faction } from "../schema/world.js";
import { Settlement } from "../schema/campaign.js";
import { stable } from "../state/jsonFileStore.js";
import { STAGES, generatorSystem, validateGenerated, type ContentIssue, type Stage } from "./generate.js";

/**
 * THE GENERATOR LOOP.
 *
 * `generate.ts` has the stages, the prompts, the schemas and the lint. This is the thing
 * that runs them — and the reason it is a loop rather than one call is worth restating: ask
 * a model for a whole campaign at once and you get a world where the third quest references
 * a town the second one never built. Each stage here sees the FROZEN output of the last, as
 * text it cannot edit, so a later stage can only add.
 *
 * The output is content, not runtime truth. It is validated, written to disk as ordinary
 * authored JSON, and from that moment the engine cannot tell it from hand-written content —
 * the DM at play time gains no authority it did not already have. That is the whole reason
 * a model is allowed to write here at all.
 *
 * Nothing is written until validation passes. A campaign with a broken reference is not a
 * campaign that needs fixing later; it is a campaign that would crash on load, and the
 * cheapest place to catch that is before it reaches the disk.
 */

export interface GenerateOptions {
  title: string;
  premise?: string;
  /** Where to write. The directory must not already exist. */
  outDir: string;
  /** Stop after this stage, for inspecting a partial run. */
  until?: Stage;
  /** Retries per stage when the model returns something that will not parse. */
  attempts?: number;
  onStage?: (stage: Stage, note: string) => void;
}

export interface GenerateResult {
  ok: boolean;
  outDir: string;
  issues: ContentIssue[];
  /** Every stage's accepted output, for debugging a run that went sideways. */
  stages: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────── stage schemas
//
// Narrower than generate.ts's `StageSchema` in two places, because the loop needs shapes it
// can assemble rather than shapes it can merely validate: factions and settlements are
// records in GameState, and the model finds arrays easier to produce.

const PremiseOut = z.object({ title: z.string(), premise: z.string().min(40) });
const WorldOut = z.object({
  factions: z.array(Faction).min(1),
  settlements: z.array(Settlement).min(1),
});
const ArcsOut = z.object({ arcs: z.array(Arc).min(1) });
const QuestsOut = z.object({ quests: z.array(Quest).min(1) });
const LocationsOut = z.object({ locations: z.array(Location).min(2) });
const CastOut = z.object({ entities: z.array(Entity).min(2) });

// ────────────────────────────────────────────────────────────── the run

export async function generateCampaign(llm: LLMClient, opts: GenerateOptions): Promise<GenerateResult> {
  const attempts = opts.attempts ?? 2;
  const say = opts.onStage ?? (() => {});
  const stages: Record<string, unknown> = {};

  // Everything accepted so far, rendered as text the next stage reads and cannot change.
  const frozen: string[] = [];
  const freeze = (stage: Stage, value: unknown): void => {
    stages[stage] = value;
    frozen.push(`## ${stage.toUpperCase()} — settled, do not contradict\n${JSON.stringify(value, null, 2)}`);
  };

  const ask = async <T>(stage: Stage, schema: z.ZodType<T, z.ZodTypeDef, unknown>, extra = ""): Promise<T> => {
    let last: unknown;
    for (let n = 1; n <= attempts; n++) {
      try {
        const res = await llm.complete({
          role: "narrate_hi",
          system: generatorSystem(stage, opts.title),
          user: [...frozen, extra].filter(Boolean).join("\n\n") || `Begin. The campaign is called "${opts.title}".`,
          schema,
          schemaName: stage,
          maxTokens: 4000,
          temperature: 0.9,
        });
        return res.value;
      } catch (err) {
        last = err;
        say(stage, `attempt ${n} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(`stage "${stage}" failed after ${attempts} attempts: ${last instanceof Error ? last.message : String(last)}`);
  };

  /** True once the stage `--until` named has been reached. Checked after freezing it. */
  const stop = (stage: Stage): boolean =>
    !!opts.until && STAGES.indexOf(stage) >= STAGES.indexOf(opts.until);

  // ---- 1. premise
  say("premise", "what is this about");
  const premise = opts.premise
    ? { title: opts.title, premise: opts.premise }
    : await ask("premise", PremiseOut);
  freeze("premise", premise);
  if (stop("premise")) return partial(opts, stages);

  // ---- 2. world
  say("world", "factions and settlements");
  const world = await ask("world", WorldOut);
  freeze("world", world);
  if (stop("world")) return partial(opts, stages);

  // ---- 3. arcs
  say("arcs", "the movements, and their seeds");
  const arcs = await ask("arcs", ArcsOut);
  freeze("arcs", arcs);
  if (stop("arcs")) return partial(opts, stages);

  // ---- 4. quests
  say("quests", "the quest graph");
  const quests = await ask("quests", QuestsOut,
    "Every step needs at least three independent routes: a completion trigger, a lead, or a fact that names it.");
  freeze("quests", quests);
  if (stop("quests")) return partial(opts, stages);

  // ---- 5. locations
  say("locations", "rooms, exits and coordinates");
  const locations = await ask("locations", LocationsOut,
    "Coordinates are drawn as the map. Spread them out; two places at the same point stack.");
  freeze("locations", locations);
  if (stop("locations")) return partial(opts, stages);

  // ---- 6. cast
  say("cast", "the people");
  const cast = await ask("cast", CastOut,
    "Exactly one entity has kind \"pc\". Give every npc a voice, a descriptor, and one thing they know that others do not.");
  freeze("cast", cast);

  // ---- 7. assemble
  say("wiring", "assembling the world");
  const assembled = assemble({ title: premise.title, premise: premise.premise, world, arcs, quests, locations, cast });

  // ---- 8. validate, and only then write
  say("validate", "checking every reference resolves");
  const check = validateGenerated(assembled);
  if (!check.ok) return { ok: false, outDir: opts.outDir, issues: check.issues, stages };

  await write(opts.outDir, assembled);
  return { ok: true, outDir: opts.outDir, issues: check.issues, stages };
}

function partial(opts: GenerateOptions, stages: Record<string, unknown>): GenerateResult {
  return { ok: false, outDir: opts.outDir, issues: [{ severity: "warning", where: "run", message: "stopped early by --until" }], stages };
}

// ──────────────────────────────────────────────────────── assembly

interface Parts {
  title: string;
  premise: string;
  world: z.infer<typeof WorldOut>;
  arcs: z.infer<typeof ArcsOut>;
  quests: z.infer<typeof QuestsOut>;
  locations: z.infer<typeof LocationsOut>;
  cast: z.infer<typeof CastOut>;
}

/**
 * Stage output → a world.
 *
 * Everything the model was NOT asked for is filled in here rather than requested: turn
 * counters, the seed, the group, which arc is active. Those are the engine's bookkeeping,
 * and asking a model for them is asking it to be wrong about something it has no view of.
 */
function assemble(p: Parts): GameState {
  const slug = p.title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "campaign";
  const campaignId = `cmp_${slug}`;

  const pcs = p.cast.entities.filter((e) => e.kind === "pc");
  const pc = pcs[0];
  if (!pc) throw new Error("the cast has no player character");

  // A BLANK start is filled in; a WRONG one is left alone so validation catches it. Quietly
  // moving the player to the nearest real room would hide the one class of error this whole
  // staged pipeline exists to surface.
  if (!pc.location_id) pc.location_id = p.locations.locations[0]!.id;

  const campaign = Campaign.parse({
    id: campaignId,
    title: p.title,
    premise: p.premise,
    arc_ids: p.arcs.arcs.map((a) => a.id),
    status: "active",
  });

  const arcs = p.arcs.arcs.map((a, i) => ({ ...a, status: i === 0 ? ("active" as const) : ("locked" as const) }));

  return GameStateSchema.parse({
    meta: {
      id: slug.includes("_") ? slug : `cmp_${slug}`,
      title: p.title,
      pc_id: pc.id,
      party_ids: [pc.id],
      player_controlled: [pc.id],
      campaign_id: campaignId,
      content_dir: slug,
      seed: `${slug}-0001`,
      turn: 0,
      created_at: new Date(0).toISOString(),
    },
    world: {
      world_minute: 8 * 60,
      factions: Object.fromEntries(p.world.factions.map((f) => [f.id, f])),
    },
    entities: Object.fromEntries(p.cast.entities.map((e) => [e.id, e])),
    locations: Object.fromEntries(p.locations.locations.map((l) => [l.id, l])),
    quests: Object.fromEntries(p.quests.quests.map((q) => [q.id, q])),
    settlements: Object.fromEntries(p.world.settlements.map((s) => [s.id, s])),
    arcs: Object.fromEntries(arcs.map((a) => [a.id, a])),
    campaigns: { [campaignId]: campaign },
    groups: { grp_main: { id: "grp_main", member_ids: [pc.id], lead_id: pc.id } },
  });
}

// ────────────────────────────────────────────────────────── writing

/**
 * The same file layout `loadCampaign` reads, so generated content and hand-written content
 * are the same thing on disk. Written last and all at once: a half-written campaign
 * directory is worse than none, because it looks loadable.
 */
async function write(dir: string, s: GameState): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const put = (f: string, v: unknown) => fs.writeFile(path.join(dir, f), stable(v), "utf8");
  await Promise.all([
    put("campaign.json", s.meta),
    put("world.json", s.world),
    put("entities.json", s.entities),
    put("locations.json", s.locations),
    put("items.json", { defs: s.item_defs, instances: s.items }),
    put("quests.json", s.quests),
    put("relationships.json", s.relationships),
    put("settlements.json", s.settlements),
    put("campaign_layer.json", { groups: s.groups, arcs: s.arcs, campaigns: s.campaigns, legacy: s.legacy, combat: null, conversation: null }),
    put("world_extra.json", { clocks: s.clocks, vows: s.vows, encounter_tables: s.encounter_tables }),
    // `facts.json`, an array — authored content and saves differ here on purpose: a save
    // streams facts to `facts.jsonl` as they accumulate, and content ships the seed set
    // whole. Writing the save format into a content directory makes it silently unloadable.
    put("facts.json", s.facts),
  ]);
}
