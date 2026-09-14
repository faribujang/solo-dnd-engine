import type { GameState } from "../schema/state.js";
import type { Entity } from "../schema/entity.js";
import type { Allegiance, FactionPresence, Settlement } from "../schema/campaign.js";
import type { Faction } from "../schema/world.js";

/**
 * THE FACTION MATRIX.
 *
 * Factions across the top, settlements down the side, and in each cell one question: who is
 * in power here, and who is trying to change that?
 *
 * The engine had both halves and no join. Faction reputation was global — you were equally
 * hated in every town by people who had never heard of you — and settlement reputation was
 * local but unattached to anyone's politics. Neither could express the thing that makes a
 * contested world feel contested: that walking through the gate means something *different*
 * depending on whose gate it is this month.
 *
 * Three things read this file, and each of them was already waiting for it:
 *
 *   ARRIVAL     How a stranger reads you, now coloured by who runs their town.
 *   PRICE       What supply costs here, which is how a player feels a grip without
 *               being told about one.
 *   THE PROMPT  What the DM knows about the room it is describing.
 */

// ─────────────────────────────────────────────────────────── lookups

/** The settlement a place belongs to, if any. Wilderness belongs to nobody. */
export function settlementOf(s: GameState, locationId: string): Settlement | undefined {
  const direct = s.locations[locationId]?.settlement_id;
  if (direct && s.settlements[direct]) return s.settlements[direct];
  return Object.values(s.settlements).find((st) => st.location_ids.includes(locationId));
}

/** Who is here, strongest first. */
export function presenceIn(s: GameState, settlementId: string): Array<FactionPresence & { faction: Faction }> {
  const st = s.settlements[settlementId];
  if (!st) return [];
  return st.presence
    .flatMap((p) => {
      const faction = s.world.factions[p.faction_id];
      return faction ? [{ ...p, faction }] : [];
    })
    .sort((a, b) => b.strength - a.strength || a.faction_id.localeCompare(b.faction_id));
}

/** Whoever this place answers to, if anyone does. */
export function holderOf(s: GameState, settlementId: string): (FactionPresence & { faction: Faction }) | null {
  return presenceIn(s, settlementId).find((p) => p.allegiance === "holds") ?? null;
}

/** Who is pushing for it. An empty list is a settled town, which is its own kind of news. */
export function challengersOf(s: GameState, settlementId: string): Array<FactionPresence & { faction: Faction }> {
  return presenceIn(s, settlementId).filter((p) => p.allegiance === "contests");
}

// ────────────────────────────────────────────────── how the town reads you

/**
 * What the local politics add to a stranger's first impression.
 *
 * The rule that earns its keep is `hunted`. Where a faction is hunted, being known as their
 * friend is a liability **in public** — so a good reputation with them reads as a reason to
 * be careful around you, not a reason to like you. That single inversion is what makes
 * carrying two loyalties across a border feel like carrying something.
 *
 * Scaled by strength, so a faction with a toehold colours a room faintly and one that owns
 * the place colours it completely.
 */
export function localStanding(
  s: GameState,
  npc: Entity,
): { affinity: number; trust: number; fear: number; reasons: string[] } {
  const st = settlementOf(s, npc.location_id);
  const out = { affinity: 0, trust: 0, fear: 0, reasons: [] as string[] };
  if (!st) return out;

  for (const p of presenceIn(s, st.id)) {
    // Their own faction's standing is already applied by rules/reputation.ts. This is about
    // what the TOWN thinks, so a member reading their own banner is not counted twice.
    if (npc.faction_ids.includes(p.faction_id)) continue;

    const rep = p.faction.rep_with_pc;
    if (rep === 0) continue;
    const weight = p.strength / 100;

    if (p.allegiance === "hunted") {
      // Being their friend is dangerous to be seen with. Being their enemy is a comfort.
      if (rep > 0) {
        out.trust -= Math.round(rep * 0.3 * weight);
        out.fear += Math.round(rep * 0.2 * weight);
        out.reasons.push(`${p.faction.name} is not safe to be friendly with here`);
      } else {
        out.trust += Math.round(Math.abs(rep) * 0.15 * weight);
      }
      continue;
    }

    const scale = p.allegiance === "holds" ? 0.5 : p.allegiance === "contests" ? 0.3 : 0.2;
    out.affinity += Math.round(rep * scale * weight);
    out.trust += Math.round(rep * scale * 0.7 * weight);
    if (Math.abs(rep) >= 40) {
      out.reasons.push(
        rep > 0
          ? `${p.faction.name} runs things here, and they like you`
          : `${p.faction.name} runs things here, and they do not`,
      );
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────── the one number

/**
 * WHAT SUPPLY COSTS HERE, as a percentage of the base price.
 *
 * The whole economy of a supply-controlled setting in one function, and the shape of it is
 * the interesting part: price is high where the supplier is **dominant** (a monopoly prices
 * like a monopoly) AND high where they are **absent** (scarcity), and cheapest where they
 * are **contested** — because competition is the only thing that has ever lowered a price.
 *
 * That gives a player a real reason to seek out contested towns, which are also the
 * dangerous ones. The map develops a texture nobody had to author.
 */
export const PRICE_MONOPOLY = 160;
export const PRICE_SCARCE = 190;
export const PRICE_CONTESTED = 80;

export function supplyPricePct(s: GameState, locationId: string): { pct: number; why: string } {
  const supplier = Object.values(s.world.factions).find((f) => f.controls_supply);
  if (!supplier) return { pct: 100, why: "" };

  const st = settlementOf(s, locationId);
  if (!st) return { pct: PRICE_SCARCE, why: "nothing is supplied out here" };

  const here = st.presence.find((p) => p.faction_id === supplier.id);
  if (!here || here.strength === 0) {
    return { pct: PRICE_SCARCE, why: `${supplier.name} does not supply ${st.name}` };
  }

  const contested = st.presence.some((p) => p.faction_id !== supplier.id && (p.allegiance === "contests" || p.allegiance === "holds"));
  if (contested) {
    return { pct: PRICE_CONTESTED, why: `${supplier.name}'s grip on ${st.name} is contested, and prices show it` };
  }

  // Uncontested: the tighter the grip, the worse the price.
  const pct = Math.round(100 + ((PRICE_MONOPOLY - 100) * here.strength) / 100);
  return { pct, why: pct > 115 ? `${supplier.name} sets the price in ${st.name} and nobody argues` : "" };
}

// ───────────────────────────────────────────────────────── for the prompt

/** One or two lines telling the DM whose room it is describing. */
export function renderPolitics(s: GameState, locationId: string): string {
  const st = settlementOf(s, locationId);
  if (!st) return "";
  const rows = presenceIn(s, st.id);
  if (rows.length === 0) return "";

  const lines: string[] = [];
  for (const p of rows) {
    const how =
      p.allegiance === "holds" ? "runs it"
      : p.allegiance === "contests" ? "is pushing for it"
      : p.allegiance === "hunted" ? "is hunted here"
      : "operates here";
    const seen = p.openness === "open" ? "openly" : p.openness === "quiet" ? "quietly" : "and almost nobody knows";
    lines.push(`  ${p.faction.name} ${how}, ${seen} (${p.strength}/100).`);
  }
  const price = supplyPricePct(s, locationId);
  if (price.why) lines.push(`  ${price.why}.`);
  lines.push("  Let this show in what people are willing to say out loud. Never state these numbers.");
  return lines.join("\n");
}

/** Which wing of their faction an NPC belongs to, so the DM plays the person not the banner. */
export function wingOf(s: GameState, e: Entity): { faction: string; name: string; wants: string } | null {
  const wingId = e.flags["faction_wing"];
  if (typeof wingId !== "string") return null;
  for (const fid of e.faction_ids) {
    const f = s.world.factions[fid];
    const w = f?.wings.find((x) => x.id === wingId);
    if (f && w) return { faction: f.name, name: w.name, wants: w.wants };
  }
  return null;
}

/** Shift a faction's grip on a town. The front moves; this is how. */
export function shiftPresence(
  st: Settlement,
  factionId: string,
  patch: { allegiance?: Allegiance; strength?: number; openness?: FactionPresence["openness"] },
): void {
  const row = st.presence.find((p) => p.faction_id === factionId);
  if (!row) {
    st.presence.push({
      faction_id: factionId,
      allegiance: patch.allegiance ?? "present",
      strength: Math.max(0, Math.min(100, patch.strength ?? 50)),
      openness: patch.openness ?? "open",
    });
    return;
  }
  if (patch.allegiance) row.allegiance = patch.allegiance;
  if (patch.openness) row.openness = patch.openness;
  if (patch.strength !== undefined) row.strength = Math.max(0, Math.min(100, patch.strength));
}
