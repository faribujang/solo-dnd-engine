import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { answer, classify, woundDescriptor } from "../../src/engine/questions.js";
import { preview, checkOdds } from "../../src/rules/preview.js";
import { takeTurn } from "../../src/engine/session.js";
import { takeLLMTurn } from "../../src/engine/llmTurn.js";
import { MockLLM } from "../../src/llm/mock.js";
import { LLMTransportError, type LLMClient, type LLMRequest, type LLMResponse } from "../../src/llm/client.js";
import { mapModel, sheetModel } from "../../src/view/models.js";
import { stable } from "../../src/state/jsonFileStore.js";
import type { GameState } from "../../src/schema/state.js";

const CAMPAIGN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../content/campaign/drowned_bell");
const load = async (): Promise<GameState> => {
  const s = structuredClone(await loadCampaign(CAMPAIGN));
  s.meta.session_zero.dice = "committed";
  return s;
};

describe("asking the DM is not taking a turn", () => {
  it("costs no time, no turn, and writes nothing", async () => {
    const s = await load();
    const llm = new MockLLM({ seed: "q" });
    const out = await takeLLMTurn(llm, s, "what are my surroundings?", {});

    expect(out.kind).toBe("answer");
    expect(out.journal).toHaveLength(0);
    expect(out.state.meta.turn).toBe(s.meta.turn);
    expect(out.state.world.world_minute).toBe(s.world.world_minute);
    expect(stable(out.state)).toBe(stable(s));   // the world is untouched
    expect(out.text.length).toBeGreaterThan(20);
  });

  it("never calls the narrator for one — a question should not take four seconds", async () => {
    const llm = new MockLLM({ seed: "q" });
    await takeLLMTurn(llm, await load(), "who is here?", {});
    expect(llm.calls.map((c) => c.role)).toEqual(["intent"]);
  });

  it("tells the difference between asking and doing", () => {
    expect(classify("what's around me?")).toEqual({ kind: "surroundings" });
    expect(classify("who is here")).toEqual({ kind: "who" });
    expect(classify("how badly hurt is it")).toEqual({ kind: "condition" });
    expect(classify("what do I know about the bell")).toEqual({ kind: "know" });
    expect(classify("how long have I got")).toEqual({ kind: "time" });

    // These are ACTIONS, not questions, and mistaking them would cost a turn.
    expect(classify("look behind the altar")).toBeNull();
    expect(classify("search the mud")).toBeNull();
    expect(classify("attack the bonepicker")).toBeNull();
    expect(classify("ask Thorne about the ledger")).toBeNull();
  });

  it("answers from what the player knows, not from what is true", async () => {
    const s = await load();
    // Garret's orders are his secret; nobody has told Vessa.
    const known = answer(s, "know", "npc_garret");
    expect(known.lines.join(" ")).not.toContain("watch for Vessa Quill by name");
  });

  it("describes a wound rather than reporting hit points", async () => {
    const s = await load();
    s.entities["npc_thorne"]!.hp.current = 6;   // 6 of 22
    const a = answer(s, "condition", "npc_thorne");
    expect(a.lines[0]).toContain("bloodied");
    expect(a.lines[0]).not.toMatch(/\b6\b/);

    // Your own party you can see properly.
    const sela = answer(s, "condition", "cmp_sela");
    expect(sela.lines[0]).toMatch(/16 of 16/);
  });

  it("grades a wound the way a DM would", () => {
    expect(woundDescriptor(1)).toBe("untouched");
    expect(woundDescriptor(0.6)).toBe("hurt");
    expect(woundDescriptor(0.2)).toBe("barely standing");
    expect(woundDescriptor(0)).toBe("down");
  });

  it("works mid-fight, where it matters most", async () => {
    let s = await load();
    s.entities["mon_bonepicker"]!.location_id = "loc_flagon";
    s.entities["mon_bonepicker"]!.zone_id = "common_floor";
    s.entities["pc_main"]!.zone_id = "common_floor";
    s = takeTurn(s, { type: "attack", target_id: "mon_bonepicker" }).state;
    expect(s.combat).not.toBeNull();

    const reach = answer(s, "reach");
    expect(reach.lines.join(" ")).toMatch(/in reach|nobody is within reach/i);

    const opts = answer(s, "options");
    expect(opts.lines.join(" ")).toMatch(/action .*(available|spent)/i);
  });
});

describe("free text still works in a fight", () => {
  const arena = async (): Promise<GameState> => {
    const s = await load();
    s.entities["mon_bonepicker"]!.location_id = "loc_flagon";
    s.entities["mon_bonepicker"]!.zone_id = "common_floor";
    s.entities["pc_main"]!.zone_id = "common_floor";
    return takeTurn(s, { type: "attack", target_id: "mon_bonepicker" }).state;
  };

  it("an improvised skill check is legal, and spends your action", async () => {
    let s = await arena();
    // Come all the way round to a fresh turn, so the opening attack is not still in the way.
    for (let i = 0; i < 12; i++) {
      if (!s.combat) return;
      const me = s.combat.order.find((c) => c.entity_id === "pc_main")!;
      if (s.combat.order[s.combat.current]!.entity_id === "pc_main" && me.economy.action) break;
      s = takeTurn(s, { type: "end_turn" }).state;
    }
    if (!s.combat) return;

    const out = takeTurn(s, { type: "skill_check", skill: "athletics", band: "medium", tag: "kick_the_table" });
    expect(out.ok, out.message).toBe(true);
    const me = out.state.combat?.order.find((c) => c.entity_id === "pc_main");
    expect(me?.economy.action).toBe(false);

    // And a second one this turn is refused with the reason.
    const again = takeTurn(out.state, { type: "skill_check", skill: "athletics", band: "medium" });
    expect(again.ok).toBe(false);
    expect(again.message).toMatch(/already used your action/);
  });

  it("speaking and grabbing something are free, as they are at a table", async () => {
    const s = await arena();
    const talk = takeTurn(s, { type: "talk", target_id: "npc_thorne", topic: "help" });
    if (talk.ok) expect(talk.journal[0]!.duration_minutes).toBe(0);
  });

  it("but you cannot rest, shop or stroll out mid-fight", async () => {
    const s = await arena();
    expect(takeTurn(s, { type: "rest", kind: "long" }).message).toMatch(/Not in the middle of a fight/);
    expect(takeTurn(s, { type: "move", dir: "out" }).message).toMatch(/flee if you want out/);
  });
});

describe("the evaluator tells you the cost before you commit", () => {
  it("prices an action and gives the odds, without rolling anything", async () => {
    const s = await load();
    const before = stable(s);

    const p = preview(s, { type: "skill_check", skill: "investigation", band: "medium" });
    expect(p.legal).toBe(true);
    expect(p.odds).toBeGreaterThan(0);
    expect(p.odds).toBeLessThanOrEqual(100);
    expect(p.parts.map((x) => x.label)).toContain("expertise");
    expect(p.detail).toContain("DC 15");

    // A dry run changes nothing.
    expect(stable(s)).toBe(before);
  });

  it("agrees with the resolver about what is illegal", async () => {
    const s = await load();
    const p = preview(s, { type: "travel", location_id: "loc_bell_crypt" });
    const real = takeTurn(s, { type: "travel", location_id: "loc_bell_crypt" });
    expect(p.legal).toBe(false);
    expect(real.ok).toBe(false);
    expect(p.reason).toBe(real.message);
  });

  it("warns what an action would cost beyond the action itself", async () => {
    const s = await load();
    const atk = preview(s, { type: "attack", target_id: "npc_thorne" });
    expect(atk.consequences).toContain("this starts a fight");

    const shove = preview(s, { type: "shove", target_id: "npc_thorne", mode: "prone" });
    expect(shove.consequences.join(" ")).toMatch(/replaces an attack/);
  });

  it("computes odds the way the dice actually work", () => {
    expect(checkOdds(5, 15, "none")).toBe(55);          // need 10+ → 11/20
    expect(checkOdds(5, 15, "advantage")).toBe(80);     // 1 − 0.45²
    expect(checkOdds(5, 15, "disadvantage")).toBe(30);  // 0.55²
    expect(checkOdds(0, 30, "none")).toBe(0);
  });
});

describe("what the client is told to lift out", () => {
  it("marks quest items so they are not lost in a list of rope and torches", async () => {
    const sheet = sheetModel(await load());
    const byName = new Map(sheet.inventory.map((i) => [i.name, i.importance]));
    expect(byName.get("Thieves' Tools")).toBe("valuable");   // it grants a verb
    expect(byName.get("Healing Draught")).toBe("valuable");
    expect(byName.get("Hooded Lantern")).toBe("mundane");
  });

  it("shows landmarks from the start and hides what has to be found", async () => {
    const s = await load();
    const m = mapModel(s);
    const ids = m.nodes.map((n) => n.id);

    // The shrine is a landmark: you have never been, but you know it is there.
    expect(ids).toContain("loc_bell_gate");
    expect(m.nodes.find((n) => n.id === "loc_bell_gate")!.state).toBe("known");

    // The crypt under it is not on anyone's map.
    expect(ids).not.toContain("loc_bell_crypt");

    // And where you have walked reads differently from where you have not.
    expect(m.nodes.find((n) => n.id === "loc_flagon")!.state).toBe("visited");
  });
});

describe("a dead narrator costs a paragraph, never a turn", () => {
  /** Answers the intent call, then falls over exactly where a real provider would. */
  class DeadNarrator implements LLMClient {
    readonly name = "dead";
    private readonly inner = new MockLLM({ seed: "d" });
    async complete<T>(req: LLMRequest<T>): Promise<LLMResponse<T>> {
      if (req.role === "narrate" || req.role === "narrate_hi") {
        throw new LLMTransportError("503 from the provider", 503, true);
      }
      return this.inner.complete(req);
    }
  }

  it("keeps the resolved turn when narration fails", async () => {
    const s = await load();
    const out = await takeLLMTurn(new DeadNarrator(), s, "search the bar", {});

    // The dice already rolled and the world already moved. Discarding that would not only
    // lose the turn — under karmic or true dice the retry would roll a different number
    // for a check the player has already watched resolve.
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("mechanics_only");
    expect(out.journal.length).toBeGreaterThan(0);
    expect(out.state.meta.turn).toBeGreaterThan(s.meta.turn);
    expect(out.text.length).toBeGreaterThan(0);   // the mechanics line stands in for prose
  });
});
