import { promises as fs } from "node:fs";
import path from "node:path";
import { GameEvent } from "../schema/event.js";
import { GameState } from "../schema/state.js";
import type { CampaignSummary, StateStore } from "./store.js";

/**
 * Phase-0 persistence: one directory per campaign, plain JSON, no database.
 *
 * The layout mirrors the domain rather than the code, so a save is readable and hand-
 * editable — which matters a great deal when you are debugging a world rather than a
 * program. `journal.jsonl` is the real source of truth; every other file is a cache
 * rebuildable from it by `npm run rebuild`.
 */
export class JsonFileStore implements StateStore {
  constructor(private readonly root: string) {}

  private dir(id: string): string {
    return path.join(this.root, id);
  }

  async exists(id: string): Promise<boolean> {
    try {
      await fs.access(path.join(this.dir(id), "campaign.json"));
      return true;
    } catch {
      return false;
    }
  }

  async create(id: string, initial: GameState): Promise<void> {
    const d = this.dir(id);
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, "journal.jsonl"), "", "utf8");
    await fs.writeFile(path.join(d, "facts.jsonl"), "", "utf8");
    await fs.writeFile(path.join(d, "rejects.jsonl"), "", "utf8");
    await fs.writeFile(path.join(d, "digests.json"), stable([]), "utf8");
    await fs.writeFile(path.join(d, "settlements.json"), stable({}), "utf8");
    await fs.writeFile(path.join(d, "campaign_layer.json"), stable({ groups: {}, arcs: {}, campaigns: {}, legacy: [], combat: null }), "utf8");
    await fs.writeFile(path.join(d, "world_extra.json"), stable({ clocks: {}, vows: {}, encounter_tables: {} }), "utf8");
    await this.writeState(id, initial);
  }

  async load(id: string): Promise<GameState> {
    const d = this.dir(id);
    const [meta, world, entities, locations, itemsFile, quests, relationships, facts, settlements, layer, extra] =
      await Promise.all([
        readJson(path.join(d, "campaign.json")),
        readJson(path.join(d, "world.json")),
        readJson(path.join(d, "entities.json")),
        readJson(path.join(d, "locations.json")),
        readJson(path.join(d, "items.json")),
        readJson(path.join(d, "quests.json")),
        readJson(path.join(d, "relationships.json")),
        readJsonl(path.join(d, "facts.jsonl")),
        readJsonOr(path.join(d, "settlements.json"), {}),
        readJsonOr(path.join(d, "campaign_layer.json"), { groups: {}, arcs: {}, campaigns: {}, legacy: [], combat: null }),
        readJsonOr(path.join(d, "world_extra.json"), { clocks: {}, vows: {}, encounter_tables: {} }),
      ]);

    const items = itemsFile as { defs: unknown; instances: unknown };
    const cl = layer as { groups: unknown; arcs: unknown; campaigns: unknown; legacy: unknown; combat?: unknown };
    const wx = extra as { clocks: unknown; vows: unknown; encounter_tables: unknown };

    // Parsing here rather than trusting the disk is deliberate: an authored campaign or a
    // hand-edited save is exactly where a malformed world would otherwise slip in.
    return GameState.parse({
      meta,
      world,
      entities,
      locations,
      item_defs: items.defs,
      items: items.instances,
      quests,
      relationships,
      facts,
      settlements,
      groups: cl.groups,
      arcs: cl.arcs,
      campaigns: cl.campaigns,
      legacy: cl.legacy,
      combat: cl.combat ?? null,   // a save made mid-fight resumes mid-fight
      conversation: (cl as { conversation?: unknown }).conversation ?? null,
      clocks: wx.clocks,
      vows: wx.vows,
      encounter_tables: wx.encounter_tables,
    });
  }

  private async writeState(id: string, s: GameState): Promise<void> {
    const d = this.dir(id);
    await fs.mkdir(d, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(d, "campaign.json"), stable(s.meta), "utf8"),
      fs.writeFile(path.join(d, "world.json"), stable(s.world), "utf8"),
      fs.writeFile(path.join(d, "entities.json"), stable(s.entities), "utf8"),
      fs.writeFile(path.join(d, "locations.json"), stable(s.locations), "utf8"),
      fs.writeFile(
        path.join(d, "items.json"),
        stable({ defs: s.item_defs, instances: s.items }),
        "utf8",
      ),
      fs.writeFile(path.join(d, "quests.json"), stable(s.quests), "utf8"),
      fs.writeFile(path.join(d, "relationships.json"), stable(s.relationships), "utf8"),
      fs.writeFile(path.join(d, "settlements.json"), stable(s.settlements), "utf8"),
      fs.writeFile(path.join(d, "campaign_layer.json"),
        stable({ groups: s.groups, arcs: s.arcs, campaigns: s.campaigns, legacy: s.legacy, combat: s.combat, conversation: s.conversation }), "utf8"),
      fs.writeFile(path.join(d, "world_extra.json"),
        stable({ clocks: s.clocks, vows: s.vows, encounter_tables: s.encounter_tables }), "utf8"),
      fs.writeFile(
        path.join(d, "facts.jsonl"),
        s.facts.map((f) => stableLine(f)).join("\n") + (s.facts.length ? "\n" : ""),
        "utf8",
      ),
    ]);
  }

  async commit(id: string, events: readonly GameEvent[], next: GameState): Promise<void> {
    const d = this.dir(id);
    await fs.mkdir(d, { recursive: true });
    if (events.length > 0) {
      const lines = events.map((e) => stableLine(e)).join("\n") + "\n";
      await fs.appendFile(path.join(d, "journal.jsonl"), lines, "utf8");
    }
    await this.writeState(id, next);
  }

  async readJournal(id: string): Promise<GameEvent[]> {
    const rows = await readJsonl(path.join(this.dir(id), "journal.jsonl"));
    return rows.map((r) => GameEvent.parse(r));
  }

  async appendRejects(id: string, rows: readonly unknown[]): Promise<void> {
    if (rows.length === 0) return;
    const line = rows.map((r) => stableLine(r)).join("\n") + "\n";
    await fs.appendFile(path.join(this.dir(id), "rejects.jsonl"), line, "utf8");
  }

  async writeJournal(id: string, events: readonly GameEvent[]): Promise<void> {
    const body = events.map((e) => stableLine(e)).join("\n") + (events.length ? "\n" : "");
    await fs.writeFile(path.join(this.dir(id), "journal.jsonl"), body, "utf8");
  }

  async archiveBranch(id: string, events: readonly GameEvent[], label: string): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const branchId = `${stamp}_${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
    const dir = path.join(this.dir(id), "branches");
    await fs.mkdir(dir, { recursive: true });
    const body = events.map((e) => stableLine(e)).join("\n") + (events.length ? "\n" : "");
    await fs.writeFile(path.join(dir, `${branchId}.jsonl`), body, "utf8");
    return branchId;
  }

  async listBranches(id: string): Promise<string[]> {
    try {
      const files = await fs.readdir(path.join(this.dir(id), "branches"));
      return files.filter((f) => f.endsWith(".jsonl")).map((f) => f.replace(/\.jsonl$/, "")).sort();
    } catch {
      return [];
    }
  }

  async readBranch(id: string, branchId: string): Promise<GameEvent[]> {
    const rows = await readJsonl(path.join(this.dir(id), "branches", `${branchId}.jsonl`));
    return rows.map((r) => GameEvent.parse(r));
  }

  async listCampaigns(): Promise<CampaignSummary[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch {
      return [];
    }
    const out: CampaignSummary[] = [];
    for (const name of names.sort()) {
      if (!(await this.exists(name))) continue;
      const meta = (await readJson(path.join(this.dir(name), "campaign.json"))) as {
        id: string; title: string; turn: number;
      };
      const world = (await readJson(path.join(this.dir(name), "world.json"))) as {
        world_minute: number;
      };
      const st = await fs.stat(path.join(this.dir(name), "campaign.json"));
      out.push({
        id: meta.id,
        title: meta.title,
        turn: meta.turn,
        world_minute: world.world_minute,
        saved_at: st.mtime.toISOString(),
      });
    }
    return out;
  }

  async snapshot(id: string, label: string): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const snapId = `${stamp}_${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
    const src = this.dir(id);
    const dst = path.join(src, "snapshots", snapId);
    await fs.mkdir(dst, { recursive: true });
    for (const f of await fs.readdir(src)) {
      if (f === "snapshots") continue;
      await fs.copyFile(path.join(src, f), path.join(dst, f));
    }
    return snapId;
  }

  async restore(id: string, snapshotId: string): Promise<void> {
    const src = path.join(this.dir(id), "snapshots", snapshotId);
    const dst = this.dir(id);
    for (const f of await fs.readdir(src)) {
      await fs.copyFile(path.join(src, f), path.join(dst, f));
    }
  }
}

async function readJson(p: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

/** Older saves predate some files. A missing one means "empty", not "corrupt". */
async function readJsonOr(p: string, fallback: unknown): Promise<unknown> {
  try { return await readJson(p); } catch { return fallback; }
}

async function readJsonl(p: string): Promise<unknown[]> {
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch {
    return [];
  }
  return raw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
}

/**
 * Key-sorted JSON. Byte-for-byte comparison of two saves is the phase-0 gate, and
 * JavaScript's insertion-ordered object keys would otherwise make an identical world
 * serialize two different ways.
 */
export function stable(value: unknown): string {
  return JSON.stringify(sortDeep(value), null, 2) + "\n";
}

export function stableLine(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

export function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}
