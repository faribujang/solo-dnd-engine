import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import type { GameState } from "../../src/schema/state.js";

const ROOT = path.join(process.cwd(), "content", "campaign");

async function campaigns(): Promise<string[]> {
  const dirs = await fs.readdir(ROOT);
  const out: string[] = [];
  for (const d of dirs) {
    try { await loadCampaign(path.join(ROOT, d)); out.push(d); } catch { /* not a campaign */ }
  }
  return out;
}

/** Everywhere you can get to from the start, ignoring flags — a hidden exit still exists. */
function reachableFrom(s: GameState, start: string): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of s.locations[id]?.exits ?? []) {
      if (!seen.has(e.to) && s.locations[e.to]) { seen.add(e.to); queue.push(e.to); }
    }
  }
  return seen;
}

/**
 * CONTENT NOBODY CAN GET TO IS NOT CONTENT.
 *
 * Six locations shipped with exits leading OUT and no exits leading in. They loaded, they
 * validated, they appeared on the map, and not one of them could be walked to — the whole
 * of arc three was unreachable and nothing said so. Exits are written per-location and the
 * reciprocal is easy to forget, so this is checked rather than remembered.
 *
 * One-way is still allowed: a drop you cannot climb, a door that locks behind you. What is
 * not allowed is a room with no way in at all.
 */
describe("every authored place can be walked to", () => {
  it("reaches every location from where the campaign starts", async () => {
    for (const name of await campaigns()) {
      const s = await loadCampaign(path.join(ROOT, name));
      const start = s.entities[s.meta.pc_id]?.location_id;
      expect(start, `${name}: no start location`).toBeTruthy();

      const seen = reachableFrom(s, start!);
      const dead = Object.keys(s.locations).filter((id) => !seen.has(id));
      expect(dead, `${name}: unreachable locations`).toEqual([]);
    }
  });

  it("names a real place on every exit", async () => {
    for (const name of await campaigns()) {
      const s = await loadCampaign(path.join(ROOT, name));
      const broken: string[] = [];
      for (const l of Object.values(s.locations)) {
        for (const e of l.exits) if (!s.locations[e.to]) broken.push(`${l.id} --${e.dir}--> ${e.to}`);
      }
      expect(broken, `${name}: exits to nowhere`).toEqual([]);
    }
  });

  it("points every encounter table reference at a table that exists", async () => {
    for (const name of await campaigns()) {
      const s = await loadCampaign(path.join(ROOT, name));
      const missing = Object.values(s.locations)
        .filter((l) => l.encounter_table_id && !s.encounter_tables[l.encounter_table_id])
        .map((l) => `${l.id} -> ${l.encounter_table_id}`);
      expect(missing, `${name}: encounter tables that are not there`).toEqual([]);
    }
  });
});
