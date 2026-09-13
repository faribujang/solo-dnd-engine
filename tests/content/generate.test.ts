import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { z } from "zod";
import { generateCampaign } from "../../src/content/generateRun.js";
import { loadCampaign, validateReferences } from "../../src/content/loadCampaign.js";
import { estimateTokens, type LLMClient, type LLMRequest, type LLMResponse } from "../../src/llm/client.js";
import { takeTurn } from "../../src/engine/session.js";
import { affordances } from "../../src/rules/affordances.js";
import { screen } from "../../src/view/models.js";

/**
 * The generator loop, driven by a scripted author.
 *
 * A real model is not the thing under test here — what matters is that the stages run in
 * order, that each one sees the frozen output of the last, that a world which does not
 * validate is NEVER written, and that one which does is genuinely playable. A canned author
 * lets all four be asserted in milliseconds and without a key.
 */

let out: string;
beforeEach(async () => { out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "dnd-gen-")), "salt_road"); });
afterEach(async () => { await fs.rm(path.dirname(out), { recursive: true, force: true }); });

/** An author that returns a small but complete and legal campaign, stage by stage. */
class ScriptedAuthor implements LLMClient {
  readonly name = "scripted";
  readonly seen: Array<{ stage: string; user: string }> = [];
  constructor(private readonly broken = false) {}

  async complete<T>(req: LLMRequest<T>): Promise<LLMResponse<T>> {
    this.seen.push({ stage: req.schemaName, user: req.user });
    const value = this.stage(req.schemaName);
    const parsed = req.schema.parse(value);
    return {
      value: parsed, raw: JSON.stringify(value), provider: "scripted", model: "script-1",
      usage: { input_tokens: estimateTokens(req.user), output_tokens: 1 }, ms: 0,
    };
  }

  private stage(name: string): unknown {
    switch (name) {
      case "premise":
        return { title: "The Salt Road", premise: "A caravan road has stopped paying its tolls, and the people who collected them have stopped being seen." };
      case "world":
        return {
          factions: [{ id: "fac_tollmen", name: "The Tollmen", rep_with_pc: 0, member_ids: ["npc_wren"], goals: ["collect what is owed"] }],
          settlements: [{ id: "set_karth", name: "Karth", location_ids: ["loc_karth_gate"], population: 400 }],
        };
      case "arcs":
        return {
          arcs: [{
            id: "arc_salt", title: "Salt", status: "active", summary: "The road, and what stopped moving on it.",
            quest_ids: ["q_the_toll"], climax_quest_id: "q_the_toll",
            seeds: [{ id: "seed_wrens_debt", text: "Wren never said who paid her last.", kind: "npc", subject_ids: ["npc_wren"] }],
          }],
        };
      case "quests":
        return {
          quests: [{
            id: "q_the_toll", title: "The Toll", status: "active", visibility: "known",
            summary: "Find out why the road stopped paying.", dm_notes: "Wren has been paying it herself.",
            giver_entity_id: "npc_wren", current_step_id: "step_ask",
            leads: [
              { text: "Wren keeps the ledger at the gate.", learned_turn: 0, source_entity_id: "npc_wren", points_to_location_id: "loc_karth_gate" },
              { text: "The road house has been empty a month.", learned_turn: 0, source_entity_id: null, points_to_location_id: "loc_road_house" },
            ],
            steps: [{
              id: "step_ask", desc: "Ask Wren what happened.", status: "active",
              // Three independent routes, which is the lint's whole point: ask her, find
              // the ledger, or simply walk into the empty road house.
              completion_triggers: [
                { id: "t_asked", on: "dialogue", when: { t: "flag", key: "asked_wren", eq: true }, then: [], once: true },
                { id: "t_found", on: "skill_check", when: { t: "flag", key: "found_ledger", eq: true }, then: [], once: true },
                { id: "t_seen", on: "enter_location", when: { t: "flag", key: "saw_road_house", eq: true }, then: [], once: true },
              ],
              on_complete: [],
            }],
          }],
        };
      case "locations":
        return {
          locations: [
            {
              id: "loc_karth_gate", name: "The Karth Gate", short_desc: "A toll gate with nobody taking tolls.",
              long_desc: "Two posts, a chain, and a ledger left open to the weather.",
              coords: { x: 4, y: 9 }, map_visibility: "landmark", settlement_id: "set_karth", discovered: true,
              exits: [{ dir: "north", to: "loc_road_house", travel_minutes: 40 }],
              zones: [{ id: "z_gate", name: "the gate", adjacent: [] }],
              ambient: { light: "bright", sound: "wind", smell: "dust" },
            },
            {
              id: "loc_road_house", name: "The Road House", short_desc: "A shuttered inn a day out of Karth.",
              long_desc: "Somebody left in a hurry and did not lock the back.",
              coords: { x: 11, y: 21 }, map_visibility: "discoverable",
              exits: [{ dir: "south", to: "loc_karth_gate", travel_minutes: 40 }],
              zones: [{ id: "z_common", name: "the common room", adjacent: [] }],
              ambient: { light: "dim", sound: "", smell: "cold ash" },
            },
          ],
        };
      case "cast":
        return {
          entities: [
            {
              id: "pc_main", kind: "pc", name: "Ilse Marrow", pronouns: "she/her", controller: "human",
              descriptor: "a road-worn courier", location_id: "loc_karth_gate", zone_id: "z_gate",
              abilities: { str: 10, dex: 14, con: 12, int: 13, wis: 12, cha: 11 },
              level: 1, class_id: "cls_rogue", race_id: "race_human",
              hp: { current: 9, max: 9, temp: 0 }, ac: 12, proficiency_bonus: 2,
              resources: { spell_slots: {}, hit_dice: { max: 1, used: 0 } },
              personality: { voice: "flat, unhurried", traits: [], ideal: "", bond: "", flaw: "" },
            },
            {
              id: "npc_wren", kind: "npc", name: "Wren Aldis", pronouns: "she/her", controller: "cpu",
              descriptor: "the tollkeeper, who has not been paid either", location_id: "loc_karth_gate", zone_id: "z_gate",
              abilities: { str: 10, dex: 10, con: 10, int: 12, wis: 13, cha: 12 },
              level: 1, hp: { current: 7, max: 7, temp: 0 }, ac: 10, proficiency_bonus: 2,
              faction_ids: ["fac_tollmen"],
              personality: { voice: "careful, and tired of being careful", traits: [], ideal: "", bond: "", flaw: "" },
              resources: { spell_slots: {}, hit_dice: { max: 1, used: 0 } },
            },
          ],
        };
      case "wiring": case "validate":
        return { ok: true };
      default:
        throw new Error(`unscripted stage ${name}`);
    }
  }
}

/** The same author, but the cast names a location nobody built. */
class BrokenAuthor extends ScriptedAuthor {
  override async complete<T>(req: LLMRequest<T>): Promise<LLMResponse<T>> {
    const res = await super.complete(req);
    if (req.schemaName === "cast") {
      const v = res.value as { entities: Array<{ location_id: string }> };
      v.entities[0]!.location_id = "loc_nowhere_at_all";
    }
    return res;
  }
}

describe("the generator loop", () => {
  it("runs the stages in order, each seeing the last one frozen", async () => {
    const author = new ScriptedAuthor();
    const res = await generateCampaign(author, { title: "The Salt Road", outDir: out });
    expect(res.ok).toBe(true);

    expect(author.seen.map((s) => s.stage)).toEqual(["premise", "world", "arcs", "quests", "locations", "cast"]);
    // The whole point of staging: by the time the cast is written, the rooms exist and are
    // in front of the author as settled text it cannot edit.
    const castPrompt = author.seen.find((s) => s.stage === "cast")!.user;
    expect(castPrompt).toContain("LOCATIONS — settled, do not contradict");
    expect(castPrompt).toContain("loc_road_house");
    expect(author.seen.find((s) => s.stage === "premise")!.user).not.toContain("settled");
  });

  it("writes a world that loads, validates and is actually playable", async () => {
    await generateCampaign(new ScriptedAuthor(), { title: "The Salt Road", outDir: out });

    // It loads through the ordinary path — generated content and hand-written content are
    // the same thing on disk.
    const s = await loadCampaign(out);
    expect(() => validateReferences(s)).not.toThrow();
    expect(s.meta.title).toBe("The Salt Road");
    expect(s.campaigns[s.meta.campaign_id!]!.status).toBe("active");
    expect(Object.values(s.arcs)[0]!.status).toBe("active");

    // And it plays: the bar offers real actions, and a turn resolves against real rooms.
    expect(affordances(s).some((a) => a.available)).toBe(true);
    const moved = takeTurn(s, { type: "move", dir: "north" });
    expect(moved.ok).toBe(true);
    expect(moved.state.entities["pc_main"]!.location_id).toBe("loc_road_house");
    expect(screen(moved.state).scene.location.name).toBe("The Road House");
  });

  it("writes NOTHING when a reference does not resolve", async () => {
    const res = await generateCampaign(new BrokenAuthor(), { title: "The Salt Road", outDir: out });
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.severity === "error")).toBe(true);

    // A half-written campaign directory is worse than none, because it looks loadable.
    await expect(fs.access(out)).rejects.toThrow();
  });

  it("stops where it is told, for inspecting a run", async () => {
    const author = new ScriptedAuthor();
    const res = await generateCampaign(author, { title: "The Salt Road", outDir: out, until: "arcs" });
    expect(res.ok).toBe(false);
    expect(author.seen.map((s) => s.stage)).toEqual(["premise", "world", "arcs"]);
    expect(res.stages).toHaveProperty("arcs");
    await expect(fs.access(out)).rejects.toThrow();
  });

  it("takes a premise from the table rather than inventing one", async () => {
    const author = new ScriptedAuthor();
    await generateCampaign(author, { title: "The Salt Road", premise: "A road that eats the people who maintain it, and the town that keeps sending more.", outDir: out });
    expect(author.seen.some((s) => s.stage === "premise")).toBe(false);
    expect(author.seen[0]!.user).toContain("eats the people");
  });

  it("retries a stage that will not parse, then gives up honestly", async () => {
    let calls = 0;
    const flaky: LLMClient = {
      name: "flaky",
      async complete<T>(req: LLMRequest<T>): Promise<LLMResponse<T>> {
        calls++;
        throw new Error("malformed");
      },
    };
    await expect(generateCampaign(flaky, { title: "X", outDir: out, attempts: 3 })).rejects.toThrow(/after 3 attempts/);
    expect(calls).toBe(3);
  });
});
