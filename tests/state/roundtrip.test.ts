import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { JsonFileStore } from "../../src/state/jsonFileStore.js";
import type { GameState } from "../../src/schema/state.js";

const WICKMOOR = path.join(process.cwd(), "content", "campaign", "wickmoor");

async function tempStore(): Promise<{ store: JsonFileStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dnd-roundtrip-"));
  return { store: new JsonFileStore(dir), dir };
}

/**
 * EVERY SLICE OF STATE SURVIVES BEING SAVED.
 *
 * `threads` shipped working: the effect applied, the reducer built it, the view model read
 * it, and eight unit tests passed. It was still completely broken in the actual game,
 * because the store writes state as several files and nothing had added threads to any of
 * them. Written nowhere, read back empty — indistinguishable from a feature that does not
 * work, and invisible to every test that held a GameState in memory.
 *
 * So this does not test threads. It tests the CLASS: take a real world, put something in
 * every top-level slice, save it, load it, and check nothing fell out. A field added next
 * year is covered by this without anybody remembering to come back here.
 */
describe("a saved world comes back whole", () => {
  it("keeps every top-level slice of state across a save and load", async () => {
    const { store, dir } = await tempStore();
    try {
      const world = structuredClone(await loadCampaign(WICKMOOR)) as GameState;

      // Put something identifiable in the slices a fresh campaign leaves empty, so an
      // unwritten one comes back visibly wrong rather than plausibly empty.
      world.threads["thr_probe"] = {
        id: "thr_probe", text: "Prove the store writes this.", status: "open",
        subject_ids: [], location_id: null, from_entity_id: null,
        opened_turn: 1, opened_world_minute: 10, fades_at_world_minute: null,
        outcome: "", source: "authored",
      };
      world.world.flags["probe_flag"] = true;

      await store.create("probe", world);
      const back = await store.load("probe");

      const missing = Object.keys(world).filter((k) => !(k in back));
      expect(missing).toEqual([]);

      // The slices that are easy to forget, named individually so a failure says which.
      expect(back.threads["thr_probe"]?.text).toBe("Prove the store writes this.");
      expect(back.world.flags["probe_flag"]).toBe(true);
      // Key ORDER is allowed to change — the store writes stable, sorted JSON on purpose,
      // which is what makes the rebuild gate byte-comparable. Membership is what matters.
      const keys = (o: object) => Object.keys(o).sort();
      expect(keys(back.clocks)).toEqual(keys(world.clocks));
      expect(keys(back.quests)).toEqual(keys(world.quests));
      expect(keys(back.entities)).toEqual(keys(world.entities));
      expect(keys(back.locations)).toEqual(keys(world.locations));
      expect(back.facts.length).toBe(world.facts.length);
      expect(keys(back.settlements)).toEqual(keys(world.settlements));
      expect(keys(back.relationships)).toEqual(keys(world.relationships));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a thread through a second save, which is where a cache would lose it", async () => {
    const { store, dir } = await tempStore();
    try {
      const world = structuredClone(await loadCampaign(WICKMOOR)) as GameState;
      await store.create("probe", world);

      const loaded = await store.load("probe");
      loaded.threads["thr_second"] = {
        id: "thr_second", text: "Added after the first write.", status: "open",
        subject_ids: [], location_id: null, from_entity_id: null,
        opened_turn: 2, opened_world_minute: 20, fades_at_world_minute: null,
        outcome: "", source: "narrator",
      };
      await store.commit("probe", [], loaded);

      const again = await store.load("probe");
      expect(again.threads["thr_second"]?.text).toBe("Added after the first write.");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
