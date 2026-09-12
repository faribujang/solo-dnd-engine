import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { takeTurn } from "../../src/engine/session.js";
import { MAX_PARTY, RECRUIT_TRUST } from "../../src/engine/turn.js";
import { inspirationOf } from "../../src/rules/inspiration.js";
import { stockOf, buyPrice } from "../../src/rules/economy.js";
import { reactionsTo, signOf } from "../../src/rules/approval.js";
import type { GameState } from "../../src/schema/state.js";

const CAMPAIGN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../content/campaign/drowned_bell");
const load = async (): Promise<GameState> => {
  const s = structuredClone(await loadCampaign(CAMPAIGN));
  s.meta.session_zero.dice = "committed";
  return s;
};

describe("companions say so", () => {
  it("puts a vocal reaction in the journal, with no model involved", async () => {
    let s = await load();
    const sela = s.entities["cmp_sela"]!;
    sela.location_id = s.entities["pc_main"]!.location_id;
    if (!s.meta.party_ids.includes("cmp_sela")) s.meta.party_ids.push("cmp_sela");

    // Kill something that had surrendered. Sela has an authored opinion about that.
    const target = s.entities["mon_bonepicker"]!;
    target.location_id = s.entities["pc_main"]!.location_id;
    target.hp.current = 1;
    target.flags["surrendered"] = true;

    let spoke = false;
    for (let i = 0; i < 8 && !spoke; i++) {
      const out = takeTurn(s, { type: "attack", target_id: "mon_bonepicker" });
      if (!out.ok) break;
      s = out.state;
      spoke = out.journal.some(
        (e) => e.type === "dialogue" && e.actor_id === "cmp_sela" && typeof e.payload["said"] === "string",
      );
    }

    // The line is authored, so this works with the mock DM and works offline. Voice is
    // the narrator's job; the reaction happening at all is not.
    expect(spoke).toBe(true);
  });

  it("labels which way a reaction leans, so an approving line is never written as a rebuke", () => {
    expect(signOf({ affinity: 8, respect: 5 })).toBe("approve");
    expect(signOf({ affinity: -12, trust: -6 })).toBe("disapprove");
    expect(signOf({ affinity: 5, trust: -5 })).toBe("mixed");
  });

  it("only lets companions who were there form an opinion", async () => {
    const s = await load();
    const sela = s.entities["cmp_sela"]!;
    if (!s.meta.party_ids.includes("cmp_sela")) s.meta.party_ids.push("cmp_sela");
    sela.location_id = "loc_bell_gate";

    // An event somewhere she is not, with nobody naming her as a witness.
    const ev = {
      id: "evt_x", turn: 1, world_minute: 0, type: "attack" as const,
      actor_id: "pc_main", target_ids: [], location_id: "loc_flagon",
      payload: { killed_surrendered: true }, rolls: [], direct_effects: [],
      attitude_impact: [], witnesses: [], fact_ids: [], duration_minutes: 0,
      rng_nonce: "", derived_from: null, trigger_id: null,
    };
    expect(reactionsTo(s, ev)).toHaveLength(0);
  });
});

describe("inspiration is spent, not just earned", () => {
  it("buys advantage and costs the point", async () => {
    const s = await load();
    const pc = s.entities["pc_main"]!;
    pc.flags["inspiration"] = 1;

    const out = takeTurn(s, { type: "skill_check", skill: "perception", band: "hard", use_inspiration: true });
    expect(out.ok).toBe(true);
    expect(inspirationOf(out.state.entities["pc_main"]!)).toBe(0);

    // Advantage is two dice, and the card says where it came from.
    const roll = out.journal[0]!.rolls[0]!;
    expect(roll.advantage).toBe("advantage");
    expect(roll.raw_second).not.toBeNull();
    expect(out.journal[0]!.payload["inspiration_spent"]).toBe(true);
  });

  it("refuses when there is none to spend, rather than silently rolling flat", async () => {
    const s = await load();
    s.entities["pc_main"]!.flags["inspiration"] = 0;
    const out = takeTurn(s, { type: "skill_check", skill: "perception", band: "hard", use_inspiration: true });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/no Inspiration/i);
    // A refusal costs nothing at all.
    expect(out.journal).toHaveLength(0);
  });

  it("does not spend it unless asked", async () => {
    const s = await load();
    s.entities["pc_main"]!.flags["inspiration"] = 2;
    const out = takeTurn(s, { type: "skill_check", skill: "perception", band: "easy" });
    expect(inspirationOf(out.state.entities["pc_main"]!)).toBe(2);
  });
});

describe("recruitment", () => {
  const ready = (s: GameState) => {
    const g = s.entities["npc_garret"]!;
    g.location_id = s.entities["pc_main"]!.location_id;
    g.recruitable = true;
    g.recruit_condition = "";
    s.relationships["npc_garret->pc_main"] = {
      subject: "npc_garret", object: "pc_main",
      dims: { affinity: 40, trust: RECRUIT_TRUST, fear: 0, respect: 20 },
      opinion: "", tags: [], history: [],
    };
    return s;
  };

  it("joins them to the party, as a companion", async () => {
    const s = ready(await load());
    const out = takeTurn(s, { type: "recruit", target_id: "npc_garret" });
    expect(out.ok).toBe(true);
    expect(out.state.meta.party_ids).toContain("npc_garret");
    // Not merely a name in a list: approval, morale and the party panel all key off kind.
    expect(out.state.entities["npc_garret"]!.kind).toBe("companion");
  });

  it("will not travel with someone who barely knows you", async () => {
    const s = ready(await load());
    s.relationships["npc_garret->pc_main"]!.dims.trust = RECRUIT_TRUST - 1;
    const out = takeTurn(s, { type: "recruit", target_id: "npc_garret" });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/well enough/);
  });

  it("respects the authored condition, so the author decides what earning someone means", async () => {
    const s = ready(await load());
    s.entities["npc_garret"]!.recruit_condition = "garret_owes_you";
    const before = takeTurn(s, { type: "recruit", target_id: "npc_garret" });
    expect(before.ok).toBe(false);

    s.world.flags["garret_owes_you"] = true;
    expect(takeTurn(s, { type: "recruit", target_id: "npc_garret" }).ok).toBe(true);
  });

  it("caps the party", async () => {
    const s = ready(await load());
    s.meta.party_ids = ["pc_main", "a", "b", "c"].slice(0, MAX_PARTY);
    const out = takeTurn(s, { type: "recruit", target_id: "npc_garret" });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/stay behind/);
  });
});

describe("shops have stock", () => {
  it("sells what is actually on the shelf, and runs out", async () => {
    let s = await load();
    s.entities["npc_thorne"]!.location_id = s.entities["pc_main"]!.location_id;

    const shelf = stockOf(s, "cont_npc_thorne");
    expect(shelf.length).toBeGreaterThan(0);

    const rope = shelf.find((i) => i.def_id === "item_def_rope")!;
    expect(rope).toBeDefined();
    s.entities["pc_main"]!.flags["purse_cp"] = 100_000;

    const first = takeTurn(s, { type: "buy", merchant_id: "npc_thorne", item_def_id: "item_def_rope" });
    expect(first.ok).toBe(true);
    s = first.state;

    // There was one rope. Now there is none — stock is real, not a menu.
    const second = takeTurn(s, { type: "buy", merchant_id: "npc_thorne", item_def_id: "item_def_rope" });
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/has no .* left/i);
  });

  it("prices by how the merchant feels about you", async () => {
    const s = await load();
    s.entities["npc_thorne"]!.location_id = s.entities["pc_main"]!.location_id;
    const def = s.item_defs["item_def_rope"]!;

    s.relationships["npc_thorne->pc_main"]!.dims.affinity = 70;
    const friendly = buyPrice(s, "npc_thorne", def, 1);
    s.relationships["npc_thorne->pc_main"]!.dims.affinity = -70;
    const hostile = buyPrice(s, "npc_thorne", def, 1);

    expect(friendly).toBeLessThan(hostile);
  });
});
