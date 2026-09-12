import type { GameState } from "../schema/state.js";
import type { Action } from "../engine/turn.js";
import { resolve } from "../engine/turn.js";
import { combatantOf, hitChance } from "../engine/combat.js";
import { dcForBand, skillModifier, skillParts } from "./checks.js";
import { collectSkillModifiers, combineModifiers } from "./modifiers.js";
import { leversOf } from "./difficulty.js";
import { SPELLS } from "../content/srd/spells.js";
import { mustLocation, pc, relationship } from "../state/selectors.js";
import type { Cost } from "./affordances.js";

/**
 * THE EVALUATOR — what would this cost me, and what are my odds?
 *
 * The player types something. Before they commit, they should see what it would spend and
 * how likely it is to work. That is the difference between "why did I miss" and "I took a
 * 45% shot and it didn't land" — the second is a story, the first is a bug report.
 *
 * A preview is a DRY RUN: it resolves nothing, journals nothing, and rolls nothing. It
 * asks the same code that would refuse the action whether it would refuse it, and reads
 * the odds off the same modifiers the roll would use. There is no second rules engine
 * here, which is the only way the preview and the outcome can be guaranteed to agree.
 */

export interface Preview {
  legal: boolean;
  /** Why not, in the same words the resolver would use. */
  reason: string | null;
  cost: Cost;
  /** In-world minutes this would spend. */
  minutes: number;
  /** Percentage chance of success, where there is a roll. Null when it is certain. */
  odds: number | null;
  /** The arithmetic: "+3 dex, +2 proficiency, −2 dim light". */
  parts: Array<{ label: string; value: number }>;
  /** What it would cost you beyond the action itself. */
  consequences: string[];
  detail: string;
}

/** Chance a d20 + mod meets a DC, as a percentage, honouring advantage. */
export function checkOdds(mod: number, dc: number, advantage: "none" | "advantage" | "disadvantage"): number {
  const need = Math.max(1, Math.min(21, dc - mod));      // natural roll needed
  const p = Math.max(0, Math.min(1, (21 - need) / 20));
  if (advantage === "advantage") return Math.round((1 - (1 - p) ** 2) * 100);
  if (advantage === "disadvantage") return Math.round(p * p * 100);
  return Math.round(p * 100);
}

/**
 * What would happen if you did this.
 *
 * Legality comes from `resolve()` itself — the real one, run and discarded — so a preview
 * can never disagree with the outcome about whether something is allowed.
 */
export function preview(s: GameState, action: Action): Preview {
  const actor = pc(s);
  const loc = mustLocation(s, actor.location_id);
  const levers = leversOf(s);
  const me = s.combat ? combatantOf(s.combat, actor.id) : undefined;

  // Ask the resolver. It rolls dice, but we throw the result away and keep only its verdict.
  const attempt = resolve(s, action, { nonce: "preview" });
  const legal = attempt.ok;
  const reason = attempt.ok ? null : attempt.reason;

  const base: Preview = {
    legal, reason, cost: "free", minutes: 0, odds: null, parts: [], consequences: [], detail: "",
  };

  switch (action.type) {
    case "skill_check": {
      const rel = action.target_id ? relationship(s, action.target_id, actor.id) : undefined;
      const mods = collectSkillModifiers({ actor, skill: action.skill, location: loc, relationship: rel });
      const { dc_delta, advantage } = combineModifiers(mods);
      const dc = dcForBand(action.band, levers.dc_shift) + dc_delta;
      const mod = skillModifier(actor, action.skill);
      return {
        ...base,
        // In a fight, improvising costs your action like anything else.
        cost: s.combat ? "action" : "time",
        minutes: s.combat ? 0 : 1,
        odds: checkOdds(mod, dc, advantage),
        parts: [...skillParts(actor, action.skill), ...mods.map((m) => ({ label: m.reason.toLowerCase(), value: -m.dc_delta }))],
        consequences: mods.filter((m) => m.dc_delta > 0 || m.advantage === "disadvantage").map((m) => m.reason),
        detail: `${action.skill} vs DC ${dc}${advantage !== "none" ? ` · ${advantage}` : ""}`,
      };
    }

    case "attack": {
      const target = s.entities[action.target_id];
      if (!target) return { ...base, cost: "action" };
      const weaponInst = actor.equipped.main_hand ? s.items[actor.equipped.main_hand] : undefined;
      const weapon = weaponInst ? s.item_defs[weaponInst.def_id] : undefined;
      const finesse = weapon?.properties.includes("finesse") ?? false;
      const abil = finesse ? "dex" : "str";
      const mod = Math.floor((actor.abilities[abil] - 10) / 2) + actor.proficiency_bonus;
      const consequences: string[] = [];
      if (!s.combat) consequences.push("this starts a fight");
      return {
        ...base,
        cost: "action",
        odds: hitChance(mod, target.ac, "none"),
        parts: [{ label: abil, value: mod - actor.proficiency_bonus }, { label: "proficiency", value: actor.proficiency_bonus }],
        consequences,
        detail: `${weapon?.damage?.dice ?? "1d4"} ${weapon?.damage?.type ?? "bludgeoning"} vs AC ${target.ac}`,
      };
    }

    case "cast": {
      const sp = SPELLS[action.spell_id];
      if (!sp) return { ...base, legal: false, reason: "That spell is not in this game yet." };
      const consequences: string[] = [];
      if (sp.level > 0) consequences.push(`spends a level-${sp.level} slot`);
      if (sp.concentration) consequences.push("needs concentration — damage can break it");
      if (sp.area) consequences.push("hits everyone in the zone, friends included");
      return {
        ...base,
        cost: sp.cost === "bonus" ? "bonus" : "action",
        consequences,
        detail: sp.resolution.kind === "attack" ? `${sp.resolution.damage} ${sp.resolution.type}`
          : sp.resolution.kind === "save" ? `${sp.resolution.ability.toUpperCase()} save`
          : "no roll",
      };
    }

    case "move_zone": {
      const threatened = !!s.combat && !!me && !me.economy.disengaged && s.combat.order.some(
        (c) => c.side !== me.side && !c.fled && c.economy.reaction &&
               s.entities[c.entity_id]?.zone_id === actor.zone_id &&
               (s.entities[c.entity_id]?.hp.current ?? 0) > 0,
      );
      return {
        ...base, cost: "movement",
        consequences: threatened ? ["provokes an opportunity attack — Disengage first to avoid it"] : [],
        detail: "one zone",
      };
    }

    case "shove": {
      const target = s.entities[action.target_id];
      const mine = skillModifier(actor, "athletics");
      const theirs = target ? Math.max(skillModifier(target, "athletics"), skillModifier(target, "acrobatics")) : 0;
      return {
        ...base, cost: "action",
        // Two d20s against each other: roughly even, shifted by the modifier gap.
        odds: Math.max(5, Math.min(95, 50 + (mine - theirs) * 5)),
        parts: [{ label: "athletics", value: mine }, { label: "their best", value: -theirs }],
        consequences: ["replaces an attack — this is your whole action"],
        detail: action.mode === "prone" ? "knock them down" : "push them a zone",
      };
    }

    case "move": case "travel":
      return { ...base, cost: "time", minutes: action.type === "travel" ? 0 : 1, detail: "" };

    case "dash": case "disengage": case "dodge": case "flee":
      return { ...base, cost: "action", detail: "" };

    case "end_turn":
      return { ...base, cost: "free", detail: "" };

    case "rest":
      return { ...base, cost: "time", minutes: action.kind === "long" ? 480 : 60, detail: "" };

    default:
      return base;
  }
}
