import type { GameState } from "../schema/state.js";

/**
 * ENTITY LINKING — turning prose into tappable text, without giving the narrator any new
 * authority.
 *
 * The tempting design is to have the model emit `[Check|SleightOfHand|DC:15]`. That puts
 * DCs back in its hands, which is the one thing this architecture exists to prevent. So:
 *
 *   · MECHANICS tokens come from CODE. The resolver already produces every number with its
 *     provenance, and the roll card renders from that structured data. Nothing is parsed.
 *   · ENTITY links are resolved by CODE as a post-process, using the same alias table the
 *     validator already uses to turn "thorne about the bell" into `npc_thorne`.
 *   · The narrator MAY emit `[[npc_thorne]]` hints when it knows what it meant. Validated
 *     like everything else: unknown ids are stripped. A hint, never an authority.
 *
 * The result is the player experience the tooltip idea was after, with none of the leak.
 */

export interface TextSpan {
  text: string;
  /** Present when this span refers to something the client can open. */
  ref?: { kind: "entity" | "location" | "item" | "quest"; id: string };
}

interface Alias {
  pattern: string;
  kind: TextSpan["ref"] extends infer R ? R extends { kind: infer K } ? K : never : never;
  id: string;
}

/** Everything nameable in the world right now, longest name first so "Thorne Blackwater"
 *  wins over "Thorne". */
export function aliasTable(s: GameState): Array<{ pattern: string; kind: NonNullable<TextSpan["ref"]>["kind"]; id: string }> {
  const out: Array<{ pattern: string; kind: NonNullable<TextSpan["ref"]>["kind"]; id: string }> = [];

  for (const e of Object.values(s.entities)) {
    if (e.flags["is_template"] === true) continue;
    out.push({ pattern: e.name, kind: "entity", id: e.id });
    // Only alias fragments that are actually distinctive; "you" would match everywhere.
    for (const a of e.aliases) {
      if (a.length >= 4 && a !== "you") out.push({ pattern: a, kind: "entity", id: e.id });
    }
  }
  for (const l of Object.values(s.locations)) {
    if (l.discovered) out.push({ pattern: l.name, kind: "location", id: l.id });
  }
  for (const d of Object.values(s.item_defs)) {
    out.push({ pattern: d.name, kind: "item", id: d.id });
  }
  for (const q of Object.values(s.quests)) {
    if (q.visibility !== "hidden") out.push({ pattern: q.title, kind: "quest", id: q.id });
  }

  return out.sort((a, b) => b.pattern.length - a.pattern.length);
}

/**
 * Split narration into spans, linking the names it mentions.
 *
 * Case-insensitive but whole-word, and each id is linked at most once per paragraph —
 * a page where every instance of "Thorne" is a button is noise, not affordance.
 */
export function linkText(s: GameState, text: string): TextSpan[] {
  // Explicit hints first: [[npc_thorne]] becomes that entity's name, linked.
  const hinted = text.replace(/\[\[([a-z][a-z0-9_]*)\]\]/g, (whole, id: string) => {
    const named = s.entities[id]?.name ?? s.locations[id]?.name ?? s.item_defs[id]?.name;
    return named ?? whole.replace(/[[\]]/g, "");
  });

  const table = aliasTable(s);
  const spans: TextSpan[] = [];
  const linked = new Set<string>();

  let rest = hinted;
  let guard = 0;
  outer: while (rest.length > 0 && guard++ < 500) {
    let best: { at: number; len: number; kind: NonNullable<TextSpan["ref"]>["kind"]; id: string } | null = null;

    for (const a of table) {
      if (linked.has(a.id)) continue;
      const at = indexOfWord(rest, a.pattern);
      if (at < 0) continue;
      if (!best || at < best.at || (at === best.at && a.pattern.length > best.len)) {
        best = { at, len: a.pattern.length, kind: a.kind, id: a.id };
      }
      if (best.at === 0 && best.len === a.pattern.length) break;
    }

    if (!best) break outer;
    if (best.at > 0) spans.push({ text: rest.slice(0, best.at) });
    spans.push({ text: rest.slice(best.at, best.at + best.len), ref: { kind: best.kind, id: best.id } });
    linked.add(best.id);
    rest = rest.slice(best.at + best.len);
  }

  if (rest.length > 0) spans.push({ text: rest });
  return spans.length > 0 ? spans : [{ text }];
}

/** Whole-word, case-insensitive index of `needle` in `hay`, or -1. */
function indexOfWord(hay: string, needle: string): number {
  if (needle.length === 0) return -1;
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  let from = 0;
  for (;;) {
    const at = h.indexOf(n, from);
    if (at < 0) return -1;
    const before = at === 0 ? " " : h[at - 1]!;
    const after = at + n.length >= h.length ? " " : h[at + n.length]!;
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9']/.test(after)) return at;
    from = at + 1;
  }
}

/** Plain text back out, for logs and tests. */
export function flatten(spans: readonly TextSpan[]): string {
  return spans.map((x) => x.text).join("");
}
