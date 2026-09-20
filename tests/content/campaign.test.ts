import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign, validateReferences } from "../../src/content/loadCampaign.js";
import { NARRATOR_ALLOWED_EFFECTS } from "../../src/schema/dsl.js";
import { validateNarration } from "../../src/llm/validate.js";

const CAMPAIGN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../content/campaign/drowned_bell",
);

describe("The Drowned Bell", () => {
  it("parses and passes referential integrity", async () => {
    const s = await loadCampaign(CAMPAIGN);
    expect(() => validateReferences(s)).not.toThrow();
  });

  it("has the shape phase 0 asked for", async () => {
    const s = await loadCampaign(CAMPAIGN);

    expect(Object.keys(s.locations)).toHaveLength(4);
    expect(Object.values(s.entities).filter((e) => e.kind === "npc")).toHaveLength(3);
    expect(Object.values(s.entities).filter((e) => e.kind === "companion")).toHaveLength(1);
    expect(Object.keys(s.quests).length).toBeGreaterThanOrEqual(2);
    // Faction COUNT is not a property worth pinning — a world gains powers as it is written.
    // What matters is that every one of them is real enough to be reacted to.
    expect(Object.keys(s.world.factions).length).toBeGreaterThanOrEqual(1);
    for (const f of Object.values(s.world.factions)) {
      expect(f.name.length, `${f.id} has no name`).toBeGreaterThan(0);
      expect(f.goals.length, `${f.id} wants nothing, so it can never act`).toBeGreaterThan(0);
    }
    expect(Object.keys(s.relationships).length).toBeGreaterThanOrEqual(3);
  });

  it("gives every settlement a politics, and at most one supplier", async () => {
    const s = await loadCampaign(CAMPAIGN);

    // The faction matrix. A settlement nobody contests or holds is a place where none of
    // the reputation systems have anything to say, which is a town in name only.
    for (const st of Object.values(s.settlements)) {
      expect(st.presence.length, `${st.id} has no faction presence`).toBeGreaterThan(0);
      for (const p of st.presence) {
        expect(s.world.factions[p.faction_id], `${st.id} names unknown faction ${p.faction_id}`).toBeDefined();
      }
    }

    // Exactly one faction may set the price of supply. Two would make the number ambiguous
    // and the setting illegible.
    const suppliers = Object.values(s.world.factions).filter((f) => f.controls_supply);
    expect(suppliers.length).toBeLessThanOrEqual(1);
  });

  it("carries at least five triggers across at least five distinct event types", async () => {
    const s = await loadCampaign(CAMPAIGN);

    const all = [
      ...s.world.triggers,
      ...Object.values(s.locations).flatMap((l) => l.on_enter_triggers),
      ...Object.values(s.entities).flatMap((e) => [...e.on_death, ...e.on_first_talk]),
      ...Object.values(s.quests).flatMap((q) => [
        ...q.failure_triggers,
        ...q.steps.flatMap((st) => st.completion_triggers),
      ]),
    ];

    expect(all.length).toBeGreaterThanOrEqual(5);
    expect(new Set(all.map((t) => t.on)).size).toBeGreaterThanOrEqual(5);
  });

  it("carries a seed every die will derive from", async () => {
    const s = await loadCampaign(CAMPAIGN);
    expect(s.meta.seed.length).toBeGreaterThan(0);
  });

  it("keeps secrets out of the player's hands at the start", async () => {
    const s = await loadCampaign(CAMPAIGN);
    const secrets = s.facts.filter((f) => f.secret);
    expect(secrets.length).toBeGreaterThan(0);
    for (const f of secrets) expect(f.known_by).not.toContain("pc_main");
  });

  it("gives every NPC a voice for the DM to use", async () => {
    const s = await loadCampaign(CAMPAIGN);
    for (const e of Object.values(s.entities).filter((x) => x.kind === "npc")) {
      expect(e.personality.voice, `${e.id} has no voice`).not.toBe("");
      expect(e.descriptor, `${e.id} has no descriptor`).not.toBe("");
    }
  });
});

describe("referential integrity catches real content bugs", () => {
  it("rejects an exit that leads nowhere", async () => {
    const s = await loadCampaign(CAMPAIGN);
    s.locations["loc_flagon"]!.exits.push({
      dir: "cellar", to: "loc_does_not_exist", desc: "", travel_minutes: 1,
      locked_by: null, hidden_until_flag: null, requires_check: null, revealed: true,
    });
    expect(() => validateReferences(s)).toThrow(/unknown location loc_does_not_exist/);
  });

  it("rejects an item whose owner disagrees with the room holding it", async () => {
    const s = await loadCampaign(CAMPAIGN);
    s.items["item_inst_key"]!.owner = { t: "location", id: "loc_flagon" };
    expect(() => validateReferences(s)).toThrow(/its owner says/);
  });

  it("rejects a quest reward naming an item nobody defined", async () => {
    const s = await loadCampaign(CAMPAIGN);
    s.quests["q_missing_bell"]!.rewards.item_def_ids.push("item_def_ghost");
    expect(() => validateReferences(s)).toThrow(/unknown item definition item_def_ghost/);
  });
});

describe("the narrator whitelist", () => {
  it("excludes every effect that could change mechanical outcomes", () => {
    const forbidden = [
      "damage", "heal", "remove_item", "set_quest_status",
      "advance_quest", "faction_rep", "spawn_entity", "start_combat",
    ];
    for (const f of forbidden) {
      expect(NARRATOR_ALLOWED_EFFECTS as readonly string[]).not.toContain(f);
    }
  });

  /**
   * `give_item` used to be on that list, and the instinct was right for the wrong reason.
   * A narrator that cannot hand the player anything describes Cotter filling their pack
   * and leaves it empty — the player looks, finds nothing, and stops believing the prose.
   * The line is not "no items", it is "nothing that moves a number": the gate lives in
   * validate.ts and refuses weapons, armour and shields by kind.
   */
  it("lets a character hand over a prop, but never gear", async () => {
    const s = await loadCampaign(CAMPAIGN);
    const here = s.entities[s.meta.pc_id]!.location_id;
    const present = Object.values(s.entities).filter((e) => e.location_id === here).map((e) => e.id);
    const ctx = { presentEntityIds: present, locationId: here };

    const prop = Object.values(s.item_defs).find((d) => d.kind === "consumable" || d.kind === "tool")!;
    const gear = Object.values(s.item_defs).find((d) => d.kind === "weapon" || d.kind === "armor")!;

    const shape = (defId: string) => ({
      narration: "He puts it into your hands without a word.",
      facts: [], attitude_deltas: [], opinion_updates: [],
      proposals: [{ t: "give_item", entity_id: s.meta.pc_id, item_def_id: defId, qty: 1 }],
      suggested_actions: [], scene_change: null, new_thread: null, settled_thread: null,
    }) as never;

    const good = validateNarration(s, shape(prop.id), ctx);
    expect(good.effects).toHaveLength(1);

    const bad = validateNarration(s, shape(gear.id), ctx);
    expect(bad.effects).toHaveLength(0);
    expect(bad.rejects[0]!.reason).toMatch(/engine hands out gear/);
  });

  it("includes the soft, narrative-only effects", () => {
    for (const a of ["set_flag", "add_lead", "add_fact", "teach_fact", "adjust_attitude"]) {
      expect(NARRATOR_ALLOWED_EFFECTS as readonly string[]).toContain(a);
    }
  });
});
