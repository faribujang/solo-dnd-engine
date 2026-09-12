import type { Advantage, Skill } from "../schema/common.js";
import type { Entity } from "../schema/entity.js";
import type { Location } from "../schema/location.js";
import type { Relationship } from "../schema/relationship.js";
import { dispositionDcShift } from "./social.js";

/**
 * Situational modifiers, derived from STATE — never from vibes, and never from the LLM.
 * One exported function per source so the reasoning stays auditable and testable, and so
 * the UI can show the player exactly why a DC moved.
 */

export interface Modifier {
  source: string;      // machine-readable source tag
  reason: string;      // one line, shown to the player
  dc_delta: number;    // positive makes the check harder
  advantage: Advantage;
}

const NONE: Advantage = "none";

/** Dim light gives disadvantage on sight-based Perception and helps Stealth. */
export function lightModifier(skill: Skill, loc: Location): Modifier | null {
  const light = loc.ambient.light;
  if (light === "bright") return null;
  if (skill === "stealth") {
    return {
      source: "light",
      reason: light === "dark" ? "Darkness hides you" : "Dim light hides you",
      dc_delta: light === "dark" ? -5 : -2,
      advantage: NONE,
    };
  }
  if (skill === "perception" || skill === "investigation") {
    return {
      source: "light",
      reason: light === "dark" ? "You can barely see" : "The light is poor",
      dc_delta: light === "dark" ? 5 : 2,
      advantage: light === "dark" ? "disadvantage" : NONE,
    };
  }
  return null;
}

/** How the target already feels about you shifts social DCs, capped at ±3. */
export function affinityModifier(rel: Relationship | undefined): Modifier | null {
  if (!rel) return null;
  const shift = dispositionDcShift(rel.dims.affinity);
  if (shift === 0) return null;
  return {
    source: "affinity",
    reason: shift < 0 ? "They are inclined to hear you out" : "They have little patience for you",
    dc_delta: shift,
    advantage: NONE,
  };
}

/** 5e exhaustion level 1+ gives disadvantage on ability checks. */
export function exhaustionModifier(e: Entity): Modifier | null {
  const ex = e.conditions.find((c) => c.id.startsWith("exhaustion"));
  if (!ex) return null;
  return {
    source: "exhaustion",
    reason: "You are exhausted",
    dc_delta: 0,
    advantage: "disadvantage",
  };
}

/** Poisoned, frightened and restrained all give disadvantage on ability checks. */
export function conditionModifier(e: Entity): Modifier | null {
  const bad = ["poisoned", "frightened", "restrained"];
  const hit = e.conditions.find((c) => bad.includes(c.id));
  if (!hit) return null;
  return {
    source: "condition",
    reason: `You are ${hit.id}`,
    dc_delta: 0,
    advantage: "disadvantage",
  };
}

/** Being at or below a quarter of your HP makes fine work harder. */
export function woundedModifier(e: Entity): Modifier | null {
  if (e.hp.current > Math.floor(e.hp.max / 4)) return null;
  return {
    source: "wounded",
    reason: "You are badly hurt",
    dc_delta: 2,
    advantage: NONE,
  };
}

/** Collapse a modifier list into a net DC delta and a single advantage state. */
export function combineModifiers(mods: readonly Modifier[]): { dc_delta: number; advantage: Advantage } {
  let dc = 0;
  let adv = 0;
  let dis = 0;
  for (const m of mods) {
    dc += m.dc_delta;
    if (m.advantage === "advantage") adv++;
    if (m.advantage === "disadvantage") dis++;
  }
  // 5e: any number of sources of each cancel to a single state.
  const advantage: Advantage = adv > 0 && dis === 0 ? "advantage"
    : dis > 0 && adv === 0 ? "disadvantage"
    : NONE;
  return { dc_delta: dc, advantage };
}

/** Everything that applies to one skill check, in one call. */
export function collectSkillModifiers(args: {
  actor: Entity;
  skill: Skill;
  location: Location;
  relationship?: Relationship | undefined;
}): Modifier[] {
  const out: (Modifier | null)[] = [
    lightModifier(args.skill, args.location),
    exhaustionModifier(args.actor),
    conditionModifier(args.actor),
    woundedModifier(args.actor),
  ];
  const social: Skill[] = ["persuasion", "deception", "intimidation"];
  if (social.includes(args.skill)) out.push(affinityModifier(args.relationship));
  return out.filter((m): m is Modifier => m !== null);
}
