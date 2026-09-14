import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaign } from "../../src/content/loadCampaign.js";
import { reduce } from "../../src/engine/reduce.js";
import { rootEvent } from "../helpers/world.js";
import { buildContext } from "../../src/context/build.js";
import { arrivalStanding } from "../../src/rules/reputation.js";
import {
  holderOf, challengersOf, localStanding, presenceIn, supplyPricePct, settlementOf,
  PRICE_CONTESTED, PRICE_SCARCE,
} from "../../src/rules/factions.js";
import type { GameState } from "../../src/schema/state.js";
import type { Entity } from "../../src/schema/entity.js";

const CAMPAIGN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../content/campaign/drowned_bell");
const load = async (): Promise<GameState> => structuredClone(await loadCampaign(CAMPAIGN));

/** A stranger standing in the town, with no history with anyone. */
function stranger(s: GameState, locationId: string): Entity {
  const e = structuredClone(s.entities["npc_thorne"]!);
  e.id = "npc_stranger";
  e.faction_ids = [];
  e.location_id = locationId;
  delete e.flags["social_tags"];
  s.entities[e.id] = e;
  return e;
}

const townLocation = (s: GameState): string => Object.values(s.settlements)[0]!.location_ids[0]!;

describe("the matrix", () => {
  it("says who holds a place and who is pushing for it", async () => {
    const s = await load();
    const st = Object.values(s.settlements)[0]!;

    expect(holderOf(s, st.id)?.faction_id).toBe("fac_meridian");
    expect(presenceIn(s, st.id).map((p) => p.faction_id)).toEqual(
      // strongest first, so the DM reads the room in order of who matters
      ["fac_meridian", "fac_accord", "fac_arcanate"],
    );
    // Nobody is openly contesting this town. That is itself a fact about it.
    expect(challengersOf(s, st.id)).toHaveLength(0);
  });

  it("finds the settlement a place belongs to, and shrugs at wilderness", async () => {
    const s = await load();
    expect(settlementOf(s, townLocation(s))?.id).toBe("set_mudwallow");
    expect(settlementOf(s, "loc_bell_crypt")).toBeUndefined();
  });
});

describe("whose town it is changes how a stranger reads you", () => {
  it("warms a town its holder likes you in, and cools one they do not", async () => {
    const s = await load();
    const npc = stranger(s, townLocation(s));

    s.world.factions["fac_meridian"]!.rep_with_pc = 80;
    const liked = arrivalStanding(s, npc);

    s.world.factions["fac_meridian"]!.rep_with_pc = -80;
    const loathed = arrivalStanding(s, npc);

    expect(liked.affinity).toBeGreaterThan(loathed.affinity);
    expect(liked.reasons.join(" ")).toMatch(/runs things here/);
  });

  it("makes a good name with a HUNTED faction a liability, not a credential", async () => {
    const s = await load();
    const npc = stranger(s, townLocation(s));
    // The Accord is hunted in this town. Being known as their friend is dangerous to be
    // seen with — which is the whole reason carrying two loyalties across a border costs
    // something. A flat reputation number cannot express this.
    s.world.factions["fac_accord"]!.rep_with_pc = 80;
    const friendly = localStanding(s, npc);

    expect(friendly.trust).toBeLessThan(0);
    expect(friendly.fear).toBeGreaterThan(0);
    expect(friendly.reasons.join(" ")).toMatch(/not safe to be friendly with/);
  });

  it("counts a faction member's own banner once, not twice", async () => {
    const s = await load();
    const loyal = stranger(s, townLocation(s));
    loyal.faction_ids = ["fac_meridian"];
    s.world.factions["fac_meridian"]!.rep_with_pc = 80;

    // reputation.ts already applies their own faction's standing. The town layer must not
    // stack a second helping of the same number on top of it.
    expect(localStanding(s, loyal).affinity).toBe(0);
  });

  it("leaves a place with no politics exactly as it was", async () => {
    const s = await load();
    const outside = stranger(s, "loc_bell_crypt");
    s.world.factions["fac_meridian"]!.rep_with_pc = 90;
    expect(localStanding(s, outside)).toEqual({ affinity: 0, trust: 0, fear: 0, reasons: [] });
  });
});

describe("the price of supply", () => {
  it("is worst under a monopoly and worst again where there is none", async () => {
    const s = await load();
    const here = townLocation(s);
    const st = Object.values(s.settlements)[0]!;

    // Uncontested and strong: a monopoly prices like a monopoly.
    const monopoly = supplyPricePct(s, here);
    expect(monopoly.pct).toBeGreaterThan(100);
    expect(monopoly.why).toMatch(/nobody argues/);

    // Out in the country, nothing is supplied at all, and scarcity is its own tax.
    expect(supplyPricePct(s, "loc_bell_crypt").pct).toBe(PRICE_SCARCE);

    // Somebody pushes back, and the price falls. Competition is the only thing that has
    // ever lowered one — which gives a player a reason to want the dangerous towns.
    st.presence.push({ faction_id: "fac_arcanate", allegiance: "contests", strength: 40, openness: "open" });
    expect(supplyPricePct(s, here).pct).toBe(PRICE_CONTESTED);
  });

  it("does nothing at all in a world with no supplier", async () => {
    const s = await load();
    for (const f of Object.values(s.world.factions)) f.controls_supply = false;
    expect(supplyPricePct(s, townLocation(s))).toEqual({ pct: 100, why: "" });
  });
});

describe("the front moves", () => {
  it("changes hands through an event, so the timeline shows the day it happened", async () => {
    const s = await load();
    const st = Object.values(s.settlements)[0]!;

    const out = reduce(s, rootEvent("effect", [
      { t: "set_presence", settlement_id: st.id, faction_id: "fac_accord", allegiance: "holds", strength: 60, openness: "open" },
    ]));

    const after = out.state.settlements[st.id]!;
    expect(after.presence.find((p) => p.faction_id === "fac_accord")!.allegiance).toBe("holds");
    // A town changing hands is news. It is an event, so a rewind puts the flag back.
    const news = out.journal.find((e) => e.type === "faction");
    expect(news).toBeDefined();
    expect(news!.payload["from"]).toBe("hunted");
    expect(news!.payload["to"]).toBe("holds");
  });

  it("adjusts strength without announcing a change that did not happen", async () => {
    const s = await load();
    const st = Object.values(s.settlements)[0]!;
    const out = reduce(s, rootEvent("effect", [
      { t: "set_presence", settlement_id: st.id, faction_id: "fac_meridian", strength: 40 },
    ]));
    expect(out.state.settlements[st.id]!.presence.find((p) => p.faction_id === "fac_meridian")!.strength).toBe(40);
    expect(out.journal.some((e) => e.type === "faction")).toBe(false);
  });
});

describe("what the DM is told", () => {
  it("gets the politics of the room, and is told not to read the numbers out", async () => {
    const s = await load();
    s.entities["pc_main"]!.location_id = townLocation(s);
    const ctx = buildContext(s);

    expect(ctx.user).toContain("WHO HOLDS THIS PLACE");
    expect(ctx.user).toMatch(/Meridian Syndicate runs it, openly/);
    expect(ctx.user).toMatch(/Radiant Accord is hunted here/);
    expect(ctx.user).toMatch(/Never state these numbers/);
  });

  it("names which wing of a faction someone belongs to, so it plays the person", async () => {
    const s = await load();
    const here = townLocation(s);
    s.entities["pc_main"]!.location_id = here;
    const factor = stranger(s, here);
    factor.faction_ids = ["fac_meridian"];
    factor.flags["faction_wing"] = "charter";

    const ctx = buildContext(s);
    // Two people under the same banner can want opposite things. A DM told only the banner
    // plays the banner.
    expect(ctx.user).toMatch(/Charter wing/);
    expect(ctx.user).toMatch(/legitimacy/);
  });
});
