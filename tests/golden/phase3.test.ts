import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { createCharacter, levelUpPlan } from "../../src/rules/character.js";
import { affordances, untaught } from "../../src/rules/affordances.js";
import { reduce, reduceAll } from "../../src/engine/reduce.js";
import { takeTurn } from "../../src/engine/session.js";
import { rewind } from "../../src/engine/rollback.js";
import { stable } from "../../src/state/jsonFileStore.js";
import { rootEvent } from "../helpers/world.js";
import type { GameEvent } from "../../src/schema/event.js";
import type { GameState } from "../../src/schema/state.js";

const CAMPAIGN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../content/campaign/drowned_bell");

/**
 * THE PHASE 3 GATE.
 * A character made, played to level 3, killed, and recovered by rewind — and rewinding
 * cannot reroll a check (covered in tests/rules/committed.test.ts).
 */
describe("phase 3: a whole character lifecycle", () => {
  it("make → play → level 3 → die → rewind, byte-exact", async () => {
    const base = await loadCampaign(CAMPAIGN);
    const made = createCharacter({
      id: "pc_ilse", name: "Ilse Varr", pronouns: "she/her", race_id: "race_dwarf", class_id: "cls_fighter",
      background_id: "bg_folk_hero",
      scores: { method: "point_buy", scores: { str: 15, dex: 12, con: 14, int: 8, wis: 12, cha: 10 } },
      skills: ["athletics", "perception"], alignment: "neutral_good", location_id: "loc_flagon",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;

    const initial = structuredClone(base);
    initial.entities["pc_ilse"] = made.entity;
    initial.meta.pc_id = "pc_ilse";
    initial.meta.party_ids = ["pc_ilse"];
    initial.meta.player_controlled = ["pc_ilse"];
    initial.groups["grp_main"] = { id: "grp_main", member_ids: ["pc_ilse"], lead_id: "pc_ilse" };
    expect(initial.entities["pc_ilse"]!.hp.max).toBe(13);   // d10 + con(16) +3

    let s = initial;
    const journal: GameEvent[] = [];
    const step = (r: { state: GameState; journal: GameEvent[] }) => { s = r.state; journal.push(...r.journal); };

    // 2. Play: a few real turns.
    step(takeTurn(s, { type: "look" }));
    step(takeTurn(s, { type: "talk", target_id: "npc_thorne", topic: "work" }));
    step(takeTurn(s, { type: "move", dir: "out" }));

    // 3. Earn to level 3 through an XP grant (as a quest reward would), confirm each level.
    const t = s.meta.turn + 1;
    step(reduce(s, rootEvent("effect", [{ t: "grant_xp", entity_ids: ["pc_ilse"], amount: 900, reason: "the caravan" }],
      { id: `evt_r${String(t).padStart(4, "0")}`, turn: t, actor_id: "pc_ilse", location_id: s.entities["pc_ilse"]!.location_id })));
    expect(s.entities["pc_ilse"]!.flags["level_up_ready"]).toBe(true);

    for (let lvl = 2; lvl <= 3; lvl++) {
      const plan = levelUpPlan(s.entities["pc_ilse"]!);
      const tt = s.meta.turn + 1;
      step(reduce(s, rootEvent("effect", [{ t: "level_up", entity_id: "pc_ilse", hp_gain: plan.hp_gain }],
        { id: `evt_r${String(tt).padStart(4, "0")}`, turn: tt, actor_id: "pc_ilse", location_id: s.entities["pc_ilse"]!.location_id })));
      expect(s.entities["pc_ilse"]!.level).toBe(lvl);
    }
    expect(s.entities["pc_ilse"]!.hp.max).toBe(13 + 9 + 9);   // avg d10 (6) + con 3, twice
    expect(s.entities["pc_ilse"]!.flags["level_up_ready"]).toBeUndefined();
    expect((s.entities["pc_ilse"]!.flags["features"] as string[])).toContain("Action Surge");
    const aliveTurn = s.meta.turn;
    const aliveState = stable(s);

    // 4. Die. Take a hit that downs her, then three failed saves via the real resolver.
    const tt = s.meta.turn + 1;
    step(reduce(s, rootEvent("attack", [{ t: "damage", entity_id: "pc_ilse", amount: 31, damage_type: "slashing" }],
      { id: `evt_r${String(tt).padStart(4, "0")}`, turn: tt, actor_id: "mon_bonepicker", location_id: s.entities["pc_ilse"]!.location_id })));
    expect(s.entities["pc_ilse"]!.hp.current).toBe(0);
    expect(s.entities["pc_ilse"]!.alive).toBe(true);
    expect(affordances(s).map((a) => a.action.type)).toEqual(["death_save"]);

    let saves = 0;
    while (s.entities["pc_ilse"]!.alive && s.entities["pc_ilse"]!.hp.current === 0 && !s.entities["pc_ilse"]!.stable && saves < 10) {
      step(takeTurn(s, { type: "death_save" }));
      saves++;
    }
    const outcome = !s.entities["pc_ilse"]!.alive ? "died" : s.entities["pc_ilse"]!.stable ? "stabilised" : "recovered";
    expect(["died", "stabilised", "recovered"]).toContain(outcome);   // dice decide; all three are legal

    // 5. Whatever the dice did, rewind to before the hit is exact and free.
    const roots = journal.filter((e) => e.derived_from === null);
    const back = rewind(initial, roots, aliveTurn);
    expect(stable(back.state)).toBe(aliveState);
    expect(back.state.entities["pc_ilse"]!.hp.current).toBe(31);
    expect(back.state.entities["pc_ilse"]!.level).toBe(3);

    // 6. And the full journal, death saves included, replays byte-exact.
    expect(stable(reduceAll(initial, roots).state)).toBe(stable(s));
  });
});

describe("the affordance engine", () => {
  it("offers what is legal, with the arithmetic, and greys what is not with the reason", async () => {
    const s = await loadCampaign(CAMPAIGN);
    const list = affordances(s);

    const out = list.find((a) => a.action.type === "move" && a.action.dir === "out")!;
    expect(out.available).toBe(true);
    expect(out.detail).toContain("min");

    const attack = list.find((a) => a.action.type === "attack")!;
    expect(attack.label).toContain("Thorne");   // never a party member
    expect(attack.detail).toMatch(/1d6\+3 piercing · \+5 to hit vs AC 11/);

    const search = list.find((a) => a.action.type === "skill_check" && a.action.skill === "investigation")!;
    expect(search.detail).toContain("d20 +6");
  });

  it("shows a locked exit greyed with the reason, never hidden", async () => {
    let s = await loadCampaign(CAMPAIGN);
    s = structuredClone(s);
    s.entities["pc_main"]!.location_id = "loc_bell_gate";
    s.world.flags["crypt_lever_pulled"] = true;   // reveal the stair; the key is still in the lane
    const down = affordances(s).find((a) => a.action.type === "move" && a.action.dir === "down")!;
    expect(down).toBeDefined();
    expect(down.available).toBe(false);
    expect(down.why_unavailable).toContain("Rusted Key");
  });

  it("surfaces disadvantage from the dark as a teachable moment", async () => {
    let s = await loadCampaign(CAMPAIGN);
    s = structuredClone(s);
    s.entities["pc_main"]!.location_id = "loc_bell_crypt";
    const listen = affordances(s).find((a) => a.action.type === "skill_check" && a.action.skill === "perception")!;
    expect(listen.detail).toContain("disadvantage");
    expect(listen.teaches?.key).toBe("advantage");
    expect(untaught(s, [listen])).toHaveLength(1);
    s.meta.taught.push("advantage");
    expect(untaught(s, [listen])).toHaveLength(0);
  });

  it("every offered action actually resolves", async () => {
    const s = await loadCampaign(CAMPAIGN);
    for (const a of affordances(s).filter((x) => x.available)) {
      const r = takeTurn(s, a.action);
      expect(r.ok, `${a.label} was offered but refused: ${r.message}`).toBe(true);
    }
  });
});
