import { z } from "zod";
import type { Dims } from "../schema/common.js";
import type { Entity } from "../schema/entity.js";
import type { GameEvent } from "../schema/event.js";
import type { GameState } from "../schema/state.js";
import type { Effect } from "../schema/dsl.js";
import { dispositionOf } from "./social.js";

/**
 * COMPANION APPROVAL.
 *
 * The design decision that matters: reactions live in **data, per companion**, not in code.
 * A single shared policy makes every companion the same person with a different portrait.
 * A table each makes them different people — and the asymmetry is the feature. Giving coin
 * to a beggar is a virtue to one and a weakness to another, and *that disagreement* is what
 * makes a party feel like a party rather than an escort.
 *
 * Code's job is only to notice what happened. Which of the noticed things a given companion
 * cares about, and how much, is authored.
 */

/**
 * Situations a companion might have an opinion about. Deliberately finite: an author picks
 * from this list, so a typo is a validation error rather than a trigger that never fires.
 */
export const Situation = z.enum([
  "killed_surrendered",   // struck down something that had stopped fighting
  "killed_creature",      // an ordinary kill in a fight
  "spared_enemy",         // let something live that you could have killed
  "fled_combat",
  "protected_ally",       // took a hit or healed someone at your own cost
  "let_ally_fall",        // a party member went down and you did not help
  "stole",
  "lied",                 // a deception check against someone
  "intimidated",
  "persuaded",            // talked your way through instead of fighting
  "gave_charity",
  "took_reward",
  "helped_stranger",
  "broke_promise",
  "kept_promise",
  "desecrated",           // disrespected a shrine, a grave, the dead
  "destroyed_property",
  "rested_in_danger",
  "pressed_on_hurt",      // kept going while the party was badly hurt
  "investigated",         // took the time to find out rather than act
]);
export type Situation = z.infer<typeof Situation>;

export const ApprovalRule = z.object({
  on: Situation,
  dims: z.object({
    affinity: z.number().optional(),
    trust: z.number().optional(),
    fear: z.number().optional(),
    respect: z.number().optional(),
  }),
  /** Fallback quip when there is no model to voice them. One short line, in character. */
  line: z.string().default(""),
});
export type ApprovalRule = z.infer<typeof ApprovalRule>;

/** Above this much movement in a single beat, the companion says something about it. */
export const SPEAK_THRESHOLD = 4;

/**
 * What just happened, from a companion's point of view.
 *
 * Pure and code-only. It reads the event the engine already produced — it does not ask the
 * narrator what the player "meant", because a model asked whether an act was cruel will
 * find cruelty about as often as it is asked.
 */
export function situationsIn(s: GameState, ev: GameEvent): Situation[] {
  const out: Situation[] = [];
  const p = ev.payload as Record<string, unknown>;

  switch (ev.type) {
    case "death": {
      const victim = s.entities[String(p["entity_id"] ?? "")];
      if (!victim) break;
      // "Surrendered" is a flag the engine sets when something yields or flees; killing it
      // anyway is a different act from killing it in a fight.
      if (victim.flags["surrendered"] === true || victim.flags["fleeing"] === true) out.push("killed_surrendered");
      else out.push("killed_creature");
      break;
    }

    case "attack":
      if (p["flee_target"] === true) out.push("killed_surrendered");
      break;

    case "skill_check": {
      const skill = String(p["skill"] ?? "");
      const succeeded = p["outcome"] !== "failure";
      if (skill === "deception" && succeeded) out.push("lied");
      if (skill === "intimidation" && succeeded) out.push("intimidated");
      if (skill === "persuasion" && succeeded) out.push("persuaded");
      if ((skill === "investigation" || skill === "perception") && succeeded) out.push("investigated");
      if (skill === "sleight_of_hand" && succeeded && p["stealing"] === true) out.push("stole");
      break;
    }

    case "item_transfer":
      if (p["to"] && p["from"] === s.meta.pc_id) out.push("gave_charity");
      if (p["stolen"] === true) out.push("stole");
      break;

    case "rest": {
      const loc = ev.location_id ? s.locations[ev.location_id] : undefined;
      if ((loc?.danger_level ?? 0) >= 3) out.push("rested_in_danger");
      break;
    }

    case "effect":
      if (p["flee"] === true) out.push("fled_combat");
      break;

    case "downed": {
      // Someone in the party went down. Whether that becomes "let_ally_fall" depends on
      // what happens next, so it is recorded and judged when the fight ends.
      break;
    }
  }

  // Pressing on while the party is badly hurt is a judgement about the *state*, not the
  // event, so it is checked separately.
  if (ev.type === "move" || ev.type === "enter_location") {
    const hurt = s.meta.party_ids
      .map((id) => s.entities[id])
      .filter((e): e is Entity => !!e && e.alive);
    if (hurt.length > 1 && hurt.some((e) => e.hp.current > 0 && e.hp.current < e.hp.max * 0.3)) {
      out.push("pressed_on_hurt");
    }
  }

  return out;
}

export interface Reaction {
  companion_id: string;
  situation: Situation;
  dims: Dims;
  line: string;
  /** Big enough that they say something out loud. */
  vocal: boolean;
}

/**
 * How each present companion feels about what just happened.
 *
 * Only companions who were THERE react — the knowledge model exists precisely so nobody
 * forms an opinion about something they did not witness. A companion elsewhere may hear
 * about it later through gossip, and that is a different, quieter thing.
 */
export function reactionsTo(s: GameState, ev: GameEvent): Reaction[] {
  const situations = situationsIn(s, ev);
  if (situations.length === 0) return [];

  const out: Reaction[] = [];
  const witnesses = new Set([...ev.witnesses, ...(ev.actor_id ? [ev.actor_id] : [])]);

  for (const id of s.meta.party_ids) {
    const c = s.entities[id];
    if (!c || c.kind !== "companion" || !c.alive) continue;
    if (id === ev.actor_id) continue;                  // you do not approve of yourself
    if (!witnesses.has(id) && c.location_id !== ev.location_id) continue;

    for (const situation of situations) {
      const rule = c.approval.find((r) => r.on === situation);
      if (!rule) continue;
      const magnitude = Math.max(...Object.values(rule.dims).map((v) => Math.abs(v ?? 0)), 0);
      out.push({
        companion_id: c.id,
        situation,
        dims: rule.dims,
        line: rule.line,
        vocal: magnitude >= SPEAK_THRESHOLD,
      });
    }
  }
  return out;
}

/** Reactions as effects, for the reducer. Attitudes toward the PC, so the numbers move. */
export function reactionEffects(s: GameState, reactions: readonly Reaction[]): Effect[] {
  return reactions.map((r) => ({
    t: "adjust_attitude" as const,
    subject: r.companion_id,
    object: s.meta.pc_id,
    dims: r.dims,
    reason: readable(r.situation),
  }));
}

/**
 * Which way a reaction leans, as a word. The client colours the line with it and the
 * narrator is told it, so an approving remark never gets written as a rebuke.
 */
export function signOf(dims: Dims): "approve" | "disapprove" | "mixed" {
  const vals = Object.values(dims).filter((v): v is number => typeof v === "number" && v !== 0);
  if (vals.length === 0) return "mixed";
  if (vals.every((v) => v > 0)) return "approve";
  if (vals.every((v) => v < 0)) return "disapprove";
  return "mixed";
}

export function readable(sit: Situation): string {
  return sit.replace(/_/g, " ");
}

/**
 * How a companion currently regards the party, as a word rather than a number.
 *
 * Tiers in the game, numbers in the debug view. "Warming" tells a player what to expect;
 * "affinity 34" tells them there is a spreadsheet behind the curtain.
 */
export function tierOf(s: GameState, companionId: string): string {
  const rel = s.relationships[`${companionId}->${s.meta.pc_id}`];
  return dispositionOf(rel?.dims.affinity ?? 0);
}

/** Below this affinity a companion starts refusing, then threatens to go. */
export const REFUSE_BELOW = -25;
export const LEAVE_BELOW = -55;

export function willRefuse(s: GameState, companionId: string): boolean {
  const rel = s.relationships[`${companionId}->${s.meta.pc_id}`];
  return (rel?.dims.affinity ?? 0) <= REFUSE_BELOW;
}

export function wouldLeave(s: GameState, companionId: string): boolean {
  const rel = s.relationships[`${companionId}->${s.meta.pc_id}`];
  return (rel?.dims.affinity ?? 0) <= LEAVE_BELOW;
}
