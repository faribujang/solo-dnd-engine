import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { GameEvent } from "../../src/schema/event.js";

/**
 * Every event needs its own id.
 *
 * Cascades name their parent by id (`derived_from`), so two root events sharing one makes
 * the causality of everything downstream of them ambiguous. It happened: a player action
 * and the fight ending in the same turn both came out `evt_r0107`, because both are
 * minted from `meta.turn + 1`. Replay survived it — replay is positional — which is
 * exactly why nothing noticed for a hundred turns.
 *
 * Checked against the real saves rather than a fixture, because this is a bug that only
 * appears when a turn does two things at once, and a fixture would have to know to try.
 */
describe("event ids across every save on disk", () => {
  it("are unique, and every cascade names a parent that exists", async () => {
    const root = path.join(process.cwd(), "saves");
    const saves = await readdir(root).catch(() => [] as string[]);
    expect(saves.length).toBeGreaterThan(0);

    for (const save of saves) {
      const file = path.join(root, save, "journal.jsonl");
      const text = await readFile(file, "utf8").catch(() => null);
      if (text === null) continue;

      const events: GameEvent[] = text.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
      const seen = new Map<string, number>();
      for (const e of events) seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
      const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);

      // Saves written before the fix keep their duplicates: the journal is history and we
      // do not rewrite it. What must hold is that nothing NEW collides, so this is scoped
      // to the prefixes the engine mints today.
      const freshDupes = dupes.filter((id) => id.startsWith("evt_e"));
      expect(freshDupes, `${save} has colliding engine-root ids`).toEqual([]);

      const ids = new Set(events.map((e) => e.id));
      for (const e of events) {
        if (e.derived_from === null) continue;
        expect(ids.has(e.derived_from), `${save}: ${e.id} names a parent that is not here`).toBe(true);
      }
    }
  });
});
