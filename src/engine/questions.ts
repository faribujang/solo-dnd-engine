import type { GameState } from "../schema/state.js";
import { conditionFlags } from "../rules/conditions.js";
import { dispositionOf } from "../rules/social.js";
import { adjacentZones, combatantOf, currentCombatant } from "./combat.js";
import { suggest } from "../rules/suggest.js";
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

/**
 * `asked` is the player's own sentence. Without it an answer can only be a dump of
 * everything on the subject, which is how "did we get any gear from Cotter" came back
 * as a biography.
 */
export function answer(s: GameState, kind: QuestionKind, subject?: string, asked?: string): Answer {
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
      // Named, not pointed at: "north, out, down" tells a player nothing about a village
      // they are standing in, and it is what they have to type back.
      lines.push(`Ways out: ${visibleExits(s, loc).map((x) => {
        const dest = s.locations[x.to];
        return dest?.discovered ? `${dest.name} (${x.dir})` : x.dir;
      }).join(", ") || "none you can see"}.`);
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

    /**
     * Asking about somebody returned EVERY fact naming them, newest last, in a wall.
     * "Did we get any gear from Cotter" came back as a biography — technically all true
     * and not an answer to anything. So: rank by what the question was about, keep the
     * handful that match, and tell the narrator to ANSWER rather than recite.
     */
    case "know": {
      const about = subject ?? "";
      const name = (s.entities[about]?.name ?? about).toLowerCase();
      const facts = factsKnownToPc(s).filter(
        (f) => f.subjects.includes(about) || f.text.toLowerCase().includes(name),
      );
      if (facts.length === 0) {
        return { kind, lines: ["Nothing you can call to mind."], brief: "They know nothing about this. Say so; do not invent." };
      }

      // Words from the question itself, minus the person it is about.
      const words = (asked ?? "")
        .toLowerCase()
        .split(/[^a-z0-9']+/)
        .filter((w: string) => w.length > 3 && !name.includes(w));

      const scored = facts
        .map((f) => {
          const hay = f.text.toLowerCase();
          const hits = words.filter((w: string) => hay.includes(w)).length;
          return { f, score: hits * 10 + f.importance };
        })
        .sort((a, b) => b.score - a.score || b.f.turn - a.f.turn);

      /**
       * Anything that actually matched the wording wins. When nothing does, RECENCY beats
       * importance: somebody asking "did we get any gear from Cotter" means the last ten
       * minutes, and leading with the most historically significant thing you know about
       * him is how the answer became a biography.
       */
      const relevant = scored.filter((x) => x.score >= 10);
      const keep = (relevant.length
        ? relevant
        : scored.slice().sort((a, b) => b.f.turn - a.f.turn)
      ).slice(0, 3);

      lines.push(...keep.map((x) => x.f.text));
      return {
        kind, lines,
        brief: "ANSWER the question in a sentence or two using only these. Do not list them, "
          + "and do not recite everything you know about the subject. If they do not answer it, say so plainly.",
      };
    }

    /**
     * "What am I carrying" and "does Cotter have anything for us" are the same question
     * asked about different people, and the second was being answered with the first
     * person's pack — the player asked about the smith and was shown their own sword.
     */
    case "carrying": {
      const who = subject && s.entities[subject] ? s.entities[subject]! : player;
      const mine = who.id === player.id;
      const held = itemsOwnedBy(s, who.id);

      if (!mine) {
        // Somebody else's pack is not an open book. You can see what they are holding or
        // wearing; the rest is theirs, and guessing at it would be the map bug again.
        const visible = held.filter((i) => Object.values(who.equipped).includes(i.id));
        if (visible.length === 0) {
          return {
            kind,
            lines: [`Nothing ${who.name} is showing you.`],
            brief: `Answer what ${who.name} has on them that can be SEEN, and no more. If they are keeping something back, that is theirs to offer.`,
          };
        }
        for (const i of visible) {
          lines.push(`${s.item_defs[i.def_id]?.name ?? i.def_id} — ${who.name} has it on them`);
        }
        return { kind, lines, brief: `Only what is visible on ${who.name}.` };
      }

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

    /**
     * "What can I do?" is the question a new player asks, and it used to be answered with
     * a statement of philosophy — "anything you can describe" — which is true, useless,
     * and indistinguishable from the game not understanding the question. Someone who has
     * never played a tabletop game is not asking what is permitted. They are asking what
     * is WORTH doing, which is exactly what `suggest` already ranks and what a real DM
     * answers by recapping the situation and its threads.
     */
    case "options": {
      if (s.combat) {
        const me = combatantOf(s.combat, player.id);
        const whose = currentCombatant(s.combat).entity_id;
        lines.push(whose === player.id ? "It is your turn." : `It is ${s.entities[whose]?.name}'s turn.`);
        if (me) {
          lines.push(`Action ${me.economy.action ? "available" : "spent"} · bonus ${me.economy.bonus ? "available" : "spent"} · ${me.economy.moves} move(s) · reaction ${me.economy.reaction ? "held" : "used"}.`);
        }
      }

      const here = npcsPresent(s, loc.id);
      if (here.length) lines.push(`Here with you: ${here.map((e) => e.name).join(", ")}. You can talk to any of them.`);

      const ways = visibleExits(s, loc)
        .map((x) => s.locations[x.to]?.name)
        .filter((n): n is string => !!n);
      if (ways.length) lines.push(`You can go to: ${ways.join(", ")}.`);

      // The ranked shortlist, in the same words the chips use. Four is a menu; ten is a
      // wall, and a wall is what made this question worth asking in the first place.
      const worth = suggest(s).slice(0, 4).map((x) => x.fallback);
      if (worth.length) {
        lines.push("Worth doing right now:");
        for (const w of worth) lines.push(`  · ${w}`);
      }

      // Leads are the game telling you what it is about. A player who is lost is usually
      // a player who has not been shown these.
      const leads = Object.values(s.quests)
        .filter((q) => q.status === "active")
        .flatMap((q) => q.leads.map((l) => l.text))
        .slice(0, 3);
      if (leads.length) {
        lines.push("On your mind:");
        for (const l of leads) lines.push(`  · ${l}`);
      }

      lines.push("None of that is a menu — describe anything and the game will try it.");
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
