# -*- coding: utf-8 -*-
import io

def load(p):
    raw = io.open(p, encoding="utf-8", newline="").read()
    return ("\r\n" in raw), raw.replace("\r\n", "\n")

def save(p, s, crlf):
    if crlf: s = s.replace("\n", "\r\n")
    io.open(p, "w", encoding="utf-8", newline="").write(s)

def rep(s, old, new, label):
    assert old in s, "anchor: " + label
    return s.replace(old, new, 1)

# ── terrain.ts returns roll PARTS, which is what the roll card already itemises.
p = "src/rules/terrain.ts"
crlf, s = load(p)
s = rep(s,
    'import type { Modifier } from "./modifiers.js";',
    '',
    "drop modifier import")
s = rep(s,
    """export function attackModifiers(
  s: GameState,
  attacker: Entity,
  defender: Entity,
): Modifier[] {
  const out: Modifier[] = [];""",
    """export function attackModifiers(
  s: GameState,
  attacker: Entity,
  defender: Entity,
): Array<{ label: string; value: number }> {
  const out: Array<{ label: string; value: number }> = [];""",
    "signature")
s = s.replace(
    '    out.push({ source: "terrain", reason: `${defender.name} is behind cover`, dc_delta: 0, mod: -2 });',
    '    out.push({ label: "their cover", value: -2 });', 1)
s = s.replace(
    '    out.push({ source: "terrain", reason: `${defender.name} is hard to pick out`, dc_delta: 0, mod: -2 });',
    '    out.push({ label: "smoke and shadow", value: -2 });', 1)
s = s.replace(
    '    out.push({ source: "terrain", reason: "attacking from above", dc_delta: 0, mod: 2 });',
    '    out.push({ label: "high ground", value: 2 });', 1)
save(p, s, crlf)

# ── zones carry terrain
p = "src/schema/location.ts"
crlf, s = load(p)
s = rep(s,
    """export const Zone = z.object({
  id: z.string(),
  name: z.string(),
  adjacent: z.array(z.string()).default([]),
});""",
    """export const Zone = z.object({
  id: z.string(),
  name: z.string(),
  adjacent: z.array(z.string()).default([]),
  /**
   * What the ground does. See rules/terrain.ts.
   *
   * Empty means flat and featureless, which is what every zone used to be — and is why
   * every fight played the same. Terrain is the cheapest variety available, because it
   * changes decisions rather than numbers.
   */
  terrain: z.array(TerrainTrait).default([]),
});""",
    "zone")
s = rep(s, 'import { z } from "zod";',
        'import { z } from "zod";\nimport { TerrainTrait } from "../rules/terrain.js";',
        "import")
save(p, s, crlf)

# ── the attack roll knows about the ground
p = "src/engine/combatActions.ts"
crlf, s = load(p)
s = rep(s,
    """  const atk = rollD20(rng, {
    purpose: "attack", mods: toHit, target: target.ac, isAttack: true, advantage, lean,
    parts: [{ label: ability, value: abilityBonus }, { label: "proficiency", value: attacker.proficiency_bonus }],
  });""",
    """  // The ground, itemised so it reaches the roll card with its reason. A player only
  // learns that crossing to the rubble was worth a turn if the card says so.
  const ground = attackModifiers(s, attacker, target);
  const groundTotal = ground.reduce((n, g) => n + g.value, 0);

  const atk = rollD20(rng, {
    purpose: "attack", mods: toHit + groundTotal, target: target.ac, isAttack: true, advantage, lean,
    parts: [
      { label: ability, value: abilityBonus },
      { label: "proficiency", value: attacker.proficiency_bonus },
      ...ground,
    ],
  });""",
    "roll")
s = rep(s, 'import { conditionFlags } from "../rules/conditions.js";',
        'import { conditionFlags } from "../rules/conditions.js";\nimport { attackModifiers } from "../rules/terrain.js";',
        "import")
save(p, s, crlf)
print("ok")
