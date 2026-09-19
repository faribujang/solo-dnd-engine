import type { GameState } from "../schema/state.js";
import { dispositionOf } from "./social.js";
import { inspirationOf } from "./inspiration.js";

/**
 * WHAT ACTUALLY CHANGED.
 *
 * A turn that moved nothing is the thing players call repetitive, and a turn that moved
 * something they could not see is the thing they call a grind. Both are the same defect:
 * the world keeps a ledger and never shows it. Every consequence this engine computes —
 * a fact learned, a trust threshold crossed, a clock filling, a faction losing its grip —
 * already exists in state and is then thrown away in favour of prose about the weather.
 *
 * So: DIFF TWO STATES. Not "interpret the effects that ran" — a diff catches everything
 * regardless of which effect or which cascade caused it, including the ones authored
 * content fired without anybody writing display code for them. It is a pure function of
 * (before, after), which makes it deterministic, replayable and testable, and it means a
 * new effect type shows up here for free.
 *
 * This is also the repetition INSTRUMENT: `changesBetween(a, b).length === 0` is the
 * engine saying, in its own voice, that nothing happened.
 */

export type Change =
  /** Something you now know that you did not. */
  | { t: "fact"; text: string; importance: number }
  /** Somebody's regard for you moved enough to matter. */
  | { t: "attitude"; who: string; note: string; sign: "up" | "down" }
  /** A sealed topic came unsealed — the rarest and most interesting of these. */
  | { t: "door"; who: string; note: string }
  | { t: "clock"; name: string; filled: number; segments: number; done: boolean }
  | { t: "quest"; title: string; note: string }
  | { t: "faction"; name: string; note: string }
  | { t: "place"; name: string; note: string }
  | { t: "person"; name: string; note: string }
  /** A promise picked up, or one settled. */
  | { t: "thread"; text: string; note: string }
  | { t: "self"; note: string };

/** Report an attitude move this size even when it crosses no boundary. */
const ATTITUDE_NOISE_FLOOR = 5;

export function changesBetween(before: GameState, after: GameState): Change[] {
  const out: Change[] = [];
  const me = after.meta.pc_id;
  const nameOf = (id: string) => after.entities[id]?.name ?? before.entities[id]?.name ?? id;

  // ── facts. Only what the PLAYER learned: the ledger grows with things NPCs know and the
  // player does not, and reporting those would hand over the whole secret layer.
  const knewBefore = new Set(
    before.facts.filter((f) => f.known_by.includes(me)).map((f) => f.id),
  );
  for (const f of after.facts) {
    if (!f.known_by.includes(me) || knewBefore.has(f.id)) continue;
    out.push({ t: "fact", text: f.text, importance: f.importance });
  }

  // ── seals lifting. A door that was closed and is now open is a bigger event than any
  // number it moved, because no roll could have bought it.
  const sealedBefore = new Map(before.facts.filter((f) => f.seal).map((f) => [f.id, f]));
  for (const f of after.facts) {
    const was = sealedBefore.get(f.id);
    if (was && !f.seal) {
      const who = f.subjects.map(nameOf)[0] ?? "somebody";
      out.push({ t: "door", who, note: was.seal?.why ?? "will talk about it now" });
    }
  }

  // ── how people regard you. Reported when it crosses a disposition boundary — which is
  // where behaviour actually changes — or when it moves far enough to feel in one turn.
  for (const [key, rel] of Object.entries(after.relationships)) {
    if (rel.object !== me) continue;
    const old = before.relationships[key];
    if (!old) continue;

    const dA = rel.dims.affinity - old.dims.affinity;
    const dT = rel.dims.trust - old.dims.trust;
    const dF = rel.dims.fear - old.dims.fear;
    const crossed = dispositionOf(rel.dims.affinity) !== dispositionOf(old.dims.affinity);
    const biggest = [dA, dT, dF].reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
    if (!crossed && Math.abs(biggest) < ATTITUDE_NOISE_FLOOR) continue;

    const who = nameOf(rel.subject);
    const note = crossed
      ? `now ${dispositionOf(rel.dims.affinity)} toward you`
      : dF === biggest
        ? (dF > 0 ? "more afraid of you" : "less afraid of you")
        : dT === biggest
          ? (dT > 0 ? "trusts you further" : "trusts you less")
          : (dA > 0 ? "warmer toward you" : "colder toward you");
    out.push({ t: "attitude", who, note, sign: biggest >= 0 ? "up" : "down" });
  }

  // ── threads: what you just took on, and what you just settled.
  for (const [id, th] of Object.entries(after.threads)) {
    const old = before.threads[id];
    if (!old) { out.push({ t: "thread", text: th.text, note: "you said you would" }); continue; }
    if (old.status === "open" && th.status !== "open") {
      out.push({ t: "thread", text: th.text, note: th.outcome || th.status });
    }
  }

  // ── clocks. The world moving on its own, which is the one kind of pressure a player
  // cannot see coming any other way.
  for (const [id, c] of Object.entries(after.clocks)) {
    const old = before.clocks[id];
    if (!old || !c.visible || c.filled === old.filled) continue;
    out.push({ t: "clock", name: c.name, filled: c.filled, segments: c.segments, done: c.done });
  }

  // ── quests: new ones, finished ones, and new leads under the ones you have.
  for (const [id, q] of Object.entries(after.quests)) {
    const old = before.quests[id];
    if (!old) {
      if (q.status === "active") out.push({ t: "quest", title: q.title, note: "taken up" });
      continue;
    }
    if (q.status !== old.status) out.push({ t: "quest", title: q.title, note: q.status });
    else if (q.current_step_id !== old.current_step_id) out.push({ t: "quest", title: q.title, note: "moved on" });
    const fresh = q.leads.length - old.leads.length;
    if (fresh > 0) {
      const last = q.leads[q.leads.length - 1];
      if (last) out.push({ t: "quest", title: q.title, note: `lead: ${last.text}` });
    }
  }

  // ── who holds a town. The faction matrix is most of this world's politics and it moves
  // silently; a shift here changes prices, greetings and who is hunting whom.
  for (const [id, st] of Object.entries(after.settlements)) {
    const old = before.settlements[id];
    if (!old) continue;
    for (const p of st.presence) {
      const was = old.presence.find((x) => x.faction_id === p.faction_id);
      const faction = after.world.factions[p.faction_id]?.name ?? p.faction_id;
      if (!was) { out.push({ t: "faction", name: faction, note: `now present in ${st.name}` }); continue; }
      if (was.allegiance !== p.allegiance) {
        out.push({ t: "faction", name: faction, note: `now ${p.allegiance} ${st.name}` });
      }
    }
  }

  // ── places you can now go.
  for (const [id, l] of Object.entries(after.locations)) {
    const old = before.locations[id];
    if (l.discovered && !old?.discovered) out.push({ t: "place", name: l.name, note: "found" });
  }

  // ── people arriving, leaving, and dying.
  const partyBefore = new Set(before.meta.party_ids);
  for (const id of after.meta.party_ids) {
    if (!partyBefore.has(id)) out.push({ t: "person", name: nameOf(id), note: "travels with you" });
  }
  for (const id of before.meta.party_ids) {
    if (!after.meta.party_ids.includes(id)) out.push({ t: "person", name: nameOf(id), note: "no longer with you" });
  }
  for (const [id, e] of Object.entries(after.entities)) {
    const old = before.entities[id];
    if (old?.alive && !e.alive) out.push({ t: "person", name: e.name, note: "is dead" });
    if (!old) out.push({ t: "person", name: e.name, note: "enters the story" });
  }

  // ── you.
  const meBefore = before.entities[me];
  const meAfter = after.entities[me];
  if (meBefore && meAfter) {
    if (meAfter.level > meBefore.level) out.push({ t: "self", note: `level ${meAfter.level}` });
    if (inspirationOf(meAfter) > inspirationOf(meBefore)) out.push({ t: "self", note: "inspiration" });
  }

  return out;
}

/**
 * One line a player can read at a glance, or "" when the turn moved nothing.
 *
 * The empty string is not a failure to summarise — it is the finding. A run of turns that
 * return "" is a game going in circles, and it is worth being able to see that.
 */
export function renderChanges(changes: readonly Change[]): string {
  return changes.map(oneLine).join(" · ");
}

function oneLine(c: Change): string {
  switch (c.t) {
    case "fact": return `learned: ${c.text}`;
    case "attitude": return `${c.who} ${c.note}`;
    case "door": return `${c.who} will talk about it now`;
    case "clock": return c.done ? `${c.name} — it lands` : `${c.name} ${c.filled}/${c.segments}`;
    case "quest": return `${c.title}: ${c.note}`;
    case "faction": return `${c.name} ${c.note}`;
    case "place": return `found ${c.name}`;
    case "person": return `${c.name} ${c.note}`;
    case "thread": return `${c.text} — ${c.note}`;
    case "self": return c.note;
  }
}

/** Everything the player is owed, for a scene that should not have felt like nothing. */
export function isFillerTurn(changes: readonly Change[]): boolean {
  return changes.length === 0;
}

