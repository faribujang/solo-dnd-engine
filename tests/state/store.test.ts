import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { DEMO_SCRIPT } from "../../src/content/demoScript.js";
import { takeTurn } from "../../src/engine/session.js";
import { reduceAll } from "../../src/engine/reduce.js";
import { JsonFileStore, sortDeep, stable } from "../../src/state/jsonFileStore.js";

const CAMPAIGN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../content/campaign/drowned_bell",
);

const temps: string[] = [];
async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dnd-store-"));
  temps.push(dir);
  return new JsonFileStore(dir);
}
afterEach(async () => {
  for (const d of temps.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe("stable serialization", () => {
  it("sorts keys so an identical world serializes identically", () => {
    expect(stable({ b: 1, a: 2 })).toBe(stable({ a: 2, b: 1 }));
  });

  it("sorts nested keys and leaves array order alone", () => {
    expect(sortDeep({ z: { y: 1, x: 2 }, list: [3, 1, 2] }))
      .toEqual({ list: [3, 1, 2], z: { x: 2, y: 1 } });
  });
});

describe("JsonFileStore round-trip", () => {
  it("writes and reloads a world unchanged", async () => {
    const store = await tempStore();
    const state = await loadCampaign(CAMPAIGN);

    await store.create("t1", state);
    const reloaded = await store.load("t1");

    expect(stable(reloaded)).toBe(stable(state));
  });

  it("appends every event to the journal, cascades included", async () => {
    const store = await tempStore();
    let state = await loadCampaign(CAMPAIGN);
    await store.create("t2", state);

    for (const action of DEMO_SCRIPT.slice(0, 8)) {
      const out = takeTurn(state, action);
      state = out.state;
      await store.commit("t2", out.journal, state);
    }

    const journal = await store.readJournal("t2");
    expect(journal.length).toBeGreaterThan(8);
    expect(journal.some((e) => e.derived_from !== null)).toBe(true);
    expect(journal.filter((e) => e.derived_from === null)).toHaveLength(8);
  });

  it("rebuilds the saved world from its journal, byte for byte", async () => {
    const store = await tempStore();
    const initial = await loadCampaign(CAMPAIGN);
    let state = initial;
    await store.create("t3", state);

    for (const action of DEMO_SCRIPT) {
      const out = takeTurn(state, action);
      state = out.state;
      await store.commit("t3", out.journal, state);
    }

    // Exactly what `npm run rebuild` does: authored content + journal → world.
    const onDisk = await store.load("t3");
    const journal = await store.readJournal("t3");
    const rebuilt = reduceAll(initial, journal.filter((e) => e.derived_from === null));

    expect(stable(rebuilt.state)).toBe(stable(onDisk));
  });

  it("snapshots and restores a world", async () => {
    const store = await tempStore();
    let state = await loadCampaign(CAMPAIGN);
    await store.create("t4", state);

    const snapId = await store.snapshot("t4", "before the crypt");

    for (const action of DEMO_SCRIPT.slice(0, 10)) {
      const out = takeTurn(state, action);
      state = out.state;
      await store.commit("t4", out.journal, state);
    }
    expect((await store.load("t4")).meta.turn).toBe(10);

    await store.restore("t4", snapId);
    expect((await store.load("t4")).meta.turn).toBe(0);
  });

  it("lists campaigns with their turn and clock", async () => {
    const store = await tempStore();
    const state = await loadCampaign(CAMPAIGN);
    await store.create("t5", state);

    const list = await store.listCampaigns();
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe("The Drowned Bell");
    expect(list[0]!.turn).toBe(0);
  });

  it("records rejected proposals without touching state", async () => {
    const store = await tempStore();
    const state = await loadCampaign(CAMPAIGN);
    await store.create("t6", state);

    await store.appendRejects("t6", [
      { turn: 1, reason: "effect not on narrator whitelist", proposal: { t: "damage" } },
    ]);

    const raw = await fs.readFile(path.join((store as never as { root: string }).root, "t6", "rejects.jsonl"), "utf8");
    expect(raw).toContain("not on narrator whitelist");
    expect(stable(await store.load("t6"))).toBe(stable(state));
  });
});
