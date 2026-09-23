import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { DEMO_SCRIPT } from "../../src/content/demoScript.js";
import { runScript } from "../../src/engine/session.js";
import type { GameEvent } from "../../src/schema/event.js";

const CAMPAIGN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../content/campaign/drowned_bell",
);

/**
 * Every event needs its own id.
 *
 * Cascades name their parent by id (`derived_from`), so two root events sharing one makes
 * the causality of everything downstream ambiguous. It happened: a player action and the
 * fight ending in the same turn both came out `evt_r0107`, because both were minted from
 * `meta.turn + 1`. Replay survived it — replay is positional — which is why nothing
 * noticed for a hundred turns.
 *
 * The check runs against a SCRIPTED run rather than whatever is in `saves/`. The first
 * version of this test read the save directory and asserted it was not empty, which
 * passed on the machine that wrote it and failed in CI, where `saves/` is gitignored and
 * does not exist. A test that depends on local-only data is a test that only ever fails
 * somewhere you are not looking.
 */
function check(events: readonly GameEvent[], where: string): void {
  const seen = new Map<string, number>();
  for (const e of events) seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  expect(dupes, `${where} has duplicate event ids`).toEqual([]);

  const ids = new Set(events.map((e) => e.id));
  for (const e of events) {
    if (e.derived_from === null) continue;
    expect(ids.has(e.derived_from), `${where}: ${e.id} names a parent that is not here`).toBe(true);
  }
}

describe("event ids", () => {
  it("are unique across a full scripted campaign, cascades included", async () => {
    const s = structuredClone(await loadCampaign(CAMPAIGN));
    s.meta.session_zero.dice = "committed";
    const live = runScript(s, DEMO_SCRIPT);

    expect(live.journal.length).toBeGreaterThan(30);
    check(live.journal, "the demo script");
  });

  it("are unique in every save on this machine, where there are any", async () => {
    // Local-only, and that is fine: it is a second pair of eyes on real play, not the
    // thing CI depends on. No saves means nothing to say, not a failure.
    const root = path.join(process.cwd(), "saves");
    const saves = await readdir(root).catch(() => [] as string[]);

    for (const save of saves) {
      const text = await readFile(path.join(root, save, "journal.jsonl"), "utf8").catch(() => null);
      if (text === null) continue;
      const events: GameEvent[] = text.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

      // Journals written before the fix keep their history; we do not rewrite the past.
      // What must hold is that nothing minted TODAY collides.
      const seen = new Map<string, number>();
      for (const e of events) seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
      const freshDupes = [...seen.entries()]
        .filter(([id, n]) => n > 1 && id.startsWith("evt_e"))
        .map(([id]) => id);
      expect(freshDupes, `${save} has colliding engine-root ids`).toEqual([]);
    }
  });
});
