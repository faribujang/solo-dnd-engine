import type { GameState } from "../schema/state.js";
import { conditionFlags } from "../rules/conditions.js";
import { dispositionOf } from "../rules/social.js";
import { adjacentZones, combatantOf, currentCombatant } from "./combat.js";
import {
  factsKnownToPc, hourOfDay, itemsAt, itemsOwnedBy, npcsPresent, pc,
  timeOfDayLabel, visibleExits,
} from "../state/selectors.js";

/**
 * CLARIFYING QUESTIONS — asking the DM is not taking a turn.
 *
 * This is the thing a real table has and most digital adaptations lose. Half of playing
 * D&D is "wait, what's in the room?", "how badly hurt is it?", "can I reach him from
 * here?" — and none of that is an action. A player who has to spend their turn to find out
 * what their options are is playing a worse game, and a DM who refuses to answer is a bad
 * DM.
 *
 * So questions:
 *   · cost no time, spend no action, and produce NO EVENT — nothing is journaled, the turn
 *     counter does not move, and a rewind cannot land in the middle of one;
 *   · are answered from STATE, instantly, without a model call, because "who is here"
 *     should not take four seconds;
 *   · are filtered by what the player could actually know. The knowledge model already
 *     decides what an NPC knows; it decides what the player is told too.
 *
 * The DM may voice the answer for atmosphere, but the facts come from here.
 */

export type QuestionKind =
  | "surroundings"     // what does this place look like
  | "who"              // who is here, and how do they seem
  | "reach"            // what can I get to from where I stand
  | "condition"        // how hurt is that / how hurt am I
  | "know"             // what do I know about X
  | "carrying"         // what is in my pack
  | "doing"            // what was I in the middle of
  | "time"             // how long have I got
  | "options";         // what can I do right now

export interface Answer {
  kind: QuestionKind;
  /** Short lines the client renders directly. Already filtered to what the player knows. */
  lines: string[];
  /** Anything the DM should colour, if it is voicing the answer. */
  brief: string;
}

/**
 * How hurt something looks, rather than how many hit points it has.
 *
 * A DM does not say "thirteen". They say it is bleeding badly, or barely marked. Exact
 * numbers for your own party — you can see your friends — and impressions for everything
 * else, which is both better fiction and better play, because it keeps a fight uncertain
 * without keeping it unfair.
 */
export function woundDescriptor(fraction: number): string {
  if (fraction >= 0.99) return "untouched";
  if (fraction > 0.75) return "barely marked";
  if (fraction > 0.5) return "hurt";
  if (fraction > 0.25) return "bloodied";
  if (fraction > 0) return "barely standing";
  return "down";
}

export function answer(s: GameState, kind: QuestionKind, subject?: string): Answer {
  const player = pc(s);
  const loc = s.locations[player.location_id]!;
  const lines: string[] = [];

  switch (kind) {
    case "surroundings": {
      lines.push(loc.long_desc || loc.short_desc);
      if (loc.ambient.sound) lines.push(`You can hear ${loc.ambient.sound}.`);
      if (loc.ambient.light !== "bright") lines.push(`The light is ${loc.ambient.light}.`);
      for (const f of loc.features) lines.push(`${f.name} — ${f.desc}`);
      const loose = itemsAt(s, loc.id);
      if (loose.length) lines.push(`Lying here: ${loose.map((i) => s.item_defs[i.def_id]?.name ?? i.def_id).join(", ")}.`);
      lines.push(`Ways out: ${visibleExits(s, loc).map((x) => x.dir).join(", ") || "none you can see"}.`);
      return { kind, lines, brief: `Describe ${loc.name} again, in a sentence or two. Do not add anything new.` };
    }

    case "who": {
      const here = npcsPresent(s, loc.id);
      if (here.length === 0) return { kind, lines: ["You are alone."], brief: "Nobody is here." };
      for (const e of here) {
        const rel = s.relationships[`${e.id}->${player.id}`];
        const how = rel ? dispositionOf(rel.dims.affinity) : "hard to read";
        const hurt = e.hp.current < e.hp.max ? `, ${woundDescriptor(e.hp.current / e.hp.max)}` : "";
        lines.push(`${e.name} — ${e.descriptor}. Seems ${how}${hurt}.`);
      }
      return { kind, lines, brief: "Say who is here and how they are carrying themselves." };
    }

    case "reach": {
      if (!s.combat) {
        lines.push(...visibleExits(s, loc).map((x) => {
          const dest = s.locations[x.to];
          const named = dest?.discovered ? dest.name : "somewhere you have not been";
          return `${x.dir} — ${named}, ${x.travel_minutes} min${x.locked_by ? " (locked)" : ""}`;
        }));
        return { kind, lines: lines.length ? lines : ["Nowhere from here."], brief: "" };
      }
      const zone = loc.zones.find((z) => z.id === player.zone_id);
      lines.push(`You are ${zone ? `at ${zone.name}` : "in the open"}.`);
      for (const zid of adjacentZones(s, loc.id, player.zone_id)) {
        const z = loc.zones.find((x) => x.id === zid);
        const who = Object.values(s.entities).filter((e) => e.alive && e.location_id === loc.id && e.zone_id === zid);
        lines.push(`${z?.name ?? zid} — one move${who.length ? `, ${who.map((e) => e.name).join(" and ")} there` : ", empty"}`);
      }
      const inReach = Object.values(s.entities).filter(
        (e) => e.alive && e.location_id === loc.id && e.zone_id === player.zone_id && e.id !== player.id,
      );
      lines.push(inReach.length ? `In reach right now: ${inReach.map((e) => e.name).join(", ")}.` : "Nobody is within reach of you.");
      return { kind, lines, brief: "" };
    }

    case "condition": {
      const target = subject ? s.entities[subject] : undefined;
      if (!target) {
        const flags = conditionFlags(player);
        lines.push(`You are ${woundDescriptor(player.hp.current / player.hp.max)} — ${player.hp.current} of ${player.hp.max}.`);
        if (player.conditions.length) lines.push(`Afflicted: ${player.conditions.map((c) => c.id).join(", ")}.`);
        if (flags.own_attacks_disadv) lines.push("Your attacks are at disadvantage.");
        const insp = player.flags["inspiration"];
        if (typeof insp === "number" && insp > 0) lines.push(`You have ${insp} inspiration to spend.`);
        return { kind, lines, brief: "" };
      }
      // Your own party you can see properly. Everyone else you can only read.
      const own = s.meta.party_ids.includes(target.id);
      lines.push(own
        ? `${target.name}: ${target.hp.current} of ${target.hp.max}.`
        : `${target.name} looks ${woundDescriptor(target.hp.current / target.hp.max)}.`);
      if (target.conditions.length) lines.push(`${target.name} is ${target.conditions.map((c) => c.id).join(", ")}.`);
      return { kind, lines, brief: `Describe how ${target.name} looks. Do not give a number.` };
    }

    case "know": {
      const about = subject ?? "";
      const facts = factsKnownToPc(s).filter(
        (f) => f.subjects.includes(about) ||
               f.text.toLowerCase().includes((s.entities[about]?.name ?? about).toLowerCase()),
      );
      if (facts.length === 0) {
        return { kind, lines: ["Nothing you can call to mind."], brief: "They know nothing about this. Say so; do not invent." };
      }
      lines.push(...facts.map((f) => f.text));
      return { kind, lines, brief: "Recall these, in their own words. Add nothing." };
    }

    case "carrying": {
      const held = itemsOwnedBy(s, player.id);
      if (held.length === 0) return { kind, lines: ["Nothing but what you stand up in."], brief: "" };
      for (const i of held) {
        const def = s.item_defs[i.def_id];
        const eq = Object.values(player.equipped).includes(i.id) ? " (in hand)" : "";
        const q = def?.tags.includes("quest") ? " — this matters" : "";
        lines.push(`${def?.name ?? i.def_id}${i.qty > 1 ? ` ×${i.qty}` : ""}${eq}${q}`);
      }
      return { kind, lines, brief: "" };
    }

    case "doing": {
      const active = Object.values(s.quests).filter((q) => q.status === "active");
      if (active.length === 0) return { kind, lines: ["Nothing anyone has asked of you."], brief: "" };
      for (const q of active) {
        const step = q.steps.find((st) => st.id === q.current_step_id);
        lines.push(`${q.title}: ${step?.desc ?? q.summary}`);
        for (const l of q.leads.slice(-2)) lines.push(`  · ${l.text}`);
      }
      return { kind, lines, brief: "" };
    }

    case "time": {
      lines.push(`It is ${timeOfDayLabel(s)}, around ${String(hourOfDay(s)).padStart(2, "0")}:00 on day ${Math.floor(s.world.world_minute / 1440) + 1}. ${s.world.weather.current}.`);
      for (const c of Object.values(s.clocks)) {
        if (!c.visible || c.done) continue;
        lines.push(`${c.name}: ${c.filled} of ${c.segments}.`);
      }
      for (const q of Object.values(s.quests)) {
        if (q.status !== "active" || q.deadline_world_minute === null) continue;
        const left = q.deadline_world_minute - s.world.world_minute;
        lines.push(left > 0
          ? `${q.title} — about ${Math.max(1, Math.round(left / 1440))} day(s) left.`
          : `${q.title} — the time for that has run out.`);
      }
      return { kind, lines, brief: "" };
    }

    case "options": {
      if (s.combat) {
        const me = combatantOf(s.combat, player.id);
        const whose = currentCombatant(s.combat).entity_id;
        lines.push(whose === player.id ? "It is your turn." : `It is ${s.entities[whose]?.name}'s turn.`);
        if (me) {
          lines.push(`Action ${me.economy.action ? "available" : "spent"} · bonus ${me.economy.bonus ? "available" : "spent"} · ${me.economy.moves} move(s) · reaction ${me.economy.reaction ? "held" : "used"}.`);
        }
      }
      lines.push("Anything you can describe. The bar shows what is definitely legal; the box will take the rest.");
      return { kind, lines, brief: "" };
    }
  }
}

/** Map loose player phrasing onto a question, or nothing if it is not one. */
export function classify(text: string): { kind: QuestionKind; subject?: string } | null {
  const t = text.toLowerCase().trim().replace(/[?.!]+$/, "");

  // Only treat it as a question if it reads like one. "Look behind the altar" is an action
  // and mistaking it for a question would silently drop the player's turn.
  if (!/^(what|who|where|when|how|which|can i|do i|am i|is there|are there|tell me|remind me)\b/.test(t)) {
    return null;
  }

  if (/surroundings?|around me|the room|this place|look like|see here/.test(t)) return { kind: "surroundings" };
  if (/\bwho\b|\banyone\b/.test(t)) return { kind: "who" };
  if (/reach|adjacent|next to me|how far|get to|move to|exits?|ways? out/.test(t)) return { kind: "reach" };
  if (/hurt|health|\bhp\b|wounded|bloodied|how badly|holding up/.test(t)) return { kind: "condition" };
  if (/know about|remember about|heard about|what do i know/.test(t)) return { kind: "know" };
  if (/carrying|inventory|in my (pack|bag)|do i have/.test(t)) return { kind: "carrying" };
  if (/doing|quest|supposed to|task|objective|was i/.test(t)) return { kind: "doing" };
  if (/\btime\b|how long|what day|deadline|late/.test(t)) return { kind: "time" };
  if (/can i do|my options|what now|choices/.test(t)) return { kind: "options" };

  return null;
}
