import readline from "node:readline/promises";
import path from "node:path";
import { stdin, stdout } from "node:process";
import type { GameState } from "../schema/state.js";
import { takeLLMTurn } from "../engine/llmTurn.js";
import { rewind, timeline } from "../engine/rollback.js";
import { makeLLM } from "../llm/factory.js";
import { affordances } from "../rules/affordances.js";
import { actionKeyOf } from "../rules/suggest.js";
import { loadCampaign } from "../content/loadCampaign.js";
import { JsonFileStore } from "../state/jsonFileStore.js";
import { dispositionOf } from "../rules/social.js";
import {
  itemsAt, itemsOwnedBy, npcsPresent, pc, timeOfDayLabel, visibleExits,
} from "../state/selectors.js";

/**
 * Play in free text.
 *
 *   npm run play -- [save-id] [--mock]
 *
 * Slash commands are out-of-world: they cost no time, write nothing to the journal, and
 * never reach the model. Everything else is spoken to the Dungeon Master.
 */

const args = process.argv.slice(2);
const saveId = args.find((a) => !a.startsWith("--")) ?? "drowned_bell";
const forceMock = args.includes("--mock");
const showDebug = args.includes("--debug");

const store = new JsonFileStore("saves");
if (!(await store.exists(saveId))) {
  console.error(`No save "${saveId}". Create one with:  npm run seed`);
  process.exit(1);
}

const { llm, describe } = await makeLLM({ forceMock });
let state = await store.load(saveId);
const recent: string[] = [];
let triedThisScene: string[] = [];

const rl = readline.createInterface({ input: stdin, output: stdout });

console.log(`\n  ${state.meta.title}`);
console.log(`  ${"─".repeat(state.meta.title.length)}`);
console.log(`  Dungeon Master: ${describe}\n`);
look();
console.log(`\n  Say what you do. /help for commands.\n`);

// Iterating the interface rather than awaiting question() in a loop: with piped input,
// readline emits `close` as soon as stdin ends, which drops any lines still buffered. The
// async iterator drains them first, so `npm run play < script.txt` behaves the same as a
// person typing.
rl.setPrompt("> ");

// Once stdin ends, readline closes and prompting again throws. Guard it in one place
// rather than at each of the half-dozen call sites.
let closed = false;
rl.on("close", () => { closed = true; });
const prompt = () => { if (!closed) rl.prompt(); };

prompt();

for await (const raw of rl) {
  const line = raw.trim();
  if (line === "") { prompt(); continue; }

  if (line.startsWith("/")) {
    if (await command(line)) break;
    prompt();
    continue;
  }

  let out;
  try {
    out = await takeLLMTurn(llm, state, line, { recent: recent.slice(-6), triedThisScene });
  } catch (err) {
    console.log(`\n  The Dungeon Master is unreachable: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  Nothing was lost. Try again, or run with --mock to play offline.\n`);
    continue;
  }

  if (!out.ok) {
    if (out.kind === "meta") { inventory(); prompt(); continue; }
    if (out.kind === "answer") {
      // An answer is the DM leaning over the table, not the world moving. It reads
      // differently on purpose: no turn passed, and nothing was written down.
      console.log();
      for (const line of out.text.split("\n")) console.log(`  \x1b[36m|\x1b[0m ${line}`);
      console.log(`  \x1b[2m| asking costs nothing\x1b[0m\n`);
      prompt();
      continue;
    }
    console.log(`\n  ${out.text}\n`);
    continue;
  }

  state = out.state;

  if (showDebug) {
    console.log(`\n  \x1b[2m${out.debug.mechanics}\x1b[0m`);
    if (out.debug.fired.length) console.log(`  \x1b[2mfired: ${out.debug.fired.join(", ")}\x1b[0m`);
    console.log(`  \x1b[2mprompt: ${out.debug.promptTokens} tokens\x1b[0m`);
  }

  console.log(`\n${indent(out.text)}\n`);
  if (state.combat) combatHeader();

  if (out.rejects.length > 0) {
    // Surfaced rather than hidden. If the DM is regularly overreaching you want to know.
    console.log(`  \x1b[2m(${out.rejects.length} narrator proposal(s) refused — see rejects.jsonl)\x1b[0m\n`);
    await store.appendRejects(saveId, out.rejects);
  }

  if (out.suggestedActions.length) {
    console.log(`  \x1b[2mYou might: ${out.suggestedActions.join(" · ")}\x1b[0m\n`);
  }

  recent.push(`> ${line}\n${out.text}`);
  if (out.debug.action) {
    // Chips should turn over rather than repeat, so the scene remembers what was reached for.
    const k = actionKeyOf({ action: out.debug.action } as never);
    if (!triedThisScene.includes(k)) triedThisScene.push(k);
    if (triedThisScene.length > 12) triedThisScene = triedThisScene.slice(-12);
  }
  await store.commit(saveId, out.journal, state);
}

await rl.close();
console.log(`\n  Saved to saves/${saveId}. Turn ${state.meta.turn}.\n`);

// --------------------------------------------------------------- commands

async function command(line: string): Promise<boolean> {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);

  switch (cmd) {
    case "quit": case "q": case "exit":
      return true;

    case "help":
      help();
      return false;

    case "sheet": sheet(); return false;
    case "inv": case "i": inventory(); return false;
    case "quests": quests(); return false;
    case "who": who(); return false;
    case "look": look(); return false;

    case "actions": case "a": {
      // The affordance bar, as text. The buttons teach the rules; the text box lets you
      // exceed them. Greyed rows say why, so "no" is never a mystery.
      console.log();
      let group = "";
      for (const a of affordances(state)) {
        if (a.group !== group) { group = a.group; console.log(`  ${group.toUpperCase()}`); }
        const mark = a.available ? " " : "[2m·";
        const why = a.available ? "" : `  [2m— ${a.why_unavailable ?? ""}[0m`;
        const pct = a.hit_chance !== undefined ? `[33m${String(a.hit_chance).padStart(3)}%[0m ` : "     ";
        console.log(`   ${mark} ${pct}${a.label.padEnd(30)} [2m${a.cost.padEnd(9)}${a.detail}[0m${why}`);
        if (a.teaches && !state.meta.taught.includes(a.teaches.key)) {
          console.log(`       [36m${a.teaches.text}[0m`);
          state.meta.taught.push(a.teaches.key);
        }
      }
      console.log();
      return false;
    }

    case "timeline": {
      const journal = await store.readJournal(saveId);
      const rows = timeline(journal);
      console.log();
      for (const r of rows.slice(-25)) {
        console.log(`  ${String(r.turn).padStart(3)}  ${r.type.padEnd(14)} ${r.summary}${r.cascades ? `  (+${r.cascades})` : ""}`);
      }
      console.log(`\n  /rewind <turn>  to return to any of these.\n`);
      return false;
    }

    case "rewind": {
      const target = Number(rest[0]);
      if (!Number.isInteger(target) || target < 0) {
        console.log(`\n  Usage: /rewind <turn>. You are on turn ${state.meta.turn}. /timeline lists them.\n`);
        return false;
      }
      if (target >= state.meta.turn) {
        console.log(`\n  You are already at or before turn ${target}.\n`);
        return false;
      }

      const initial = await loadCampaign(path.join("content", "campaign", "drowned_bell"));
      const journal = await store.readJournal(saveId);
      const back = rewind(initial, journal, target);

      // Nothing is destroyed: the dropped events are parked in a branch first, so the
      // rewind itself can be undone.
      const branch = await store.archiveBranch(saveId, back.removed, `from-turn-${state.meta.turn}`);
      await store.writeJournal(saveId, back.kept);
      await store.commit(saveId, [], back.state);

      state = back.state;
      recent.length = 0;

      console.log(`\n  Rewound to turn ${target}. ${back.removed.length} event(s) archived as ${branch}.`);
      console.log(`  Nothing was deleted — /branches lists what was set aside.\n`);
      look();
      console.log();
      return false;
    }

    case "branches": {
      const list = await store.listBranches(saveId);
      console.log();
      if (!list.length) console.log("  No branches. You have never rewound this save.");
      for (const b of list) console.log(`  ${b}`);
      console.log();
      return false;
    }

    case "save":
      await store.commit(saveId, [], state);
      console.log(`\n  Saved.\n`);
      return false;

    default:
      console.log(`\n  Unknown command. /help for the list.\n`);
      return false;
  }
}

// ---------------------------------------------------------------- display

function indent(text: string): string {
  return text.split("\n").map((l) => (l ? `  ${l}` : "")).join("\n");
}

function combatHeader(): void {
  const c = state.combat;
  if (!c) return;
  const cur = c.order[c.current]!;
  console.log(`\n  \x1b[1mROUND ${c.round}\x1b[0m  ${c.order.map((x, i) => {
    const e = state.entities[x.entity_id]!;
    const tag = i === c.current ? "\x1b[7m" : x.fled ? "\x1b[2m" : "";
    return `${tag} ${e.name} ${e.hp.current}/${e.hp.max}${x.fled ? " fled" : e.hp.current === 0 ? " down" : ""} \x1b[0m`;
  }).join("  ")}`);
  const me = state.entities[cur.entity_id]!;
  if (me.controller === "human") {
    const pip = (on: boolean, label: string) => (on ? `\x1b[32m●\x1b[0m ${label}` : `\x1b[2m○ ${label}\x1b[0m`);
    console.log(`  ${me.name}'s turn:  ${pip(cur.economy.action, "Action")}  ${pip(cur.economy.bonus, "Bonus")}  ${pip(cur.economy.moves > 0, `Move ×${cur.economy.moves}`)}  ${pip(cur.economy.reaction, "Reaction")}`);
    const con = c.concentration[me.id];
    if (con) console.log(`  \x1b[2mconcentrating on ${con.spell_id.replace("spell_", "").replace(/_/g, " ")}\x1b[0m`);
  }
}

function look(): void {
  const p = pc(state);
  const loc = state.locations[p.location_id]!;
  combatHeader();
  console.log(`\n  ${loc.name} — ${timeOfDayLabel(state)}, ${state.world.weather.current}`);
  console.log(`  ${loc.visited_count <= 1 && loc.long_desc ? loc.long_desc : loc.short_desc}`);

  const people = npcsPresent(state, loc.id);
  if (people.length) console.log(`  Here: ${people.map((e) => e.name).join(", ")}`);
  const loose = itemsAt(state, loc.id);
  if (loose.length) console.log(`  Lying here: ${loose.map((i) => state.item_defs[i.def_id]?.name).join(", ")}`);
  console.log(`  Exits: ${visibleExits(state, loc).map((x) => x.dir).join(", ") || "none"}`);
}

function sheet(): void {
  const p = pc(state);
  console.log(`\n  ${p.name} — level ${p.level}`);
  console.log(`  HP ${p.hp.current}/${p.hp.max}   AC ${p.ac}   Prof +${p.proficiency_bonus}`);
  console.log(`  STR ${p.abilities.str}  DEX ${p.abilities.dex}  CON ${p.abilities.con}  INT ${p.abilities.int}  WIS ${p.abilities.wis}  CHA ${p.abilities.cha}`);
  console.log(`  Hit dice ${p.resources.hit_dice.max - p.resources.hit_dice.used}/${p.resources.hit_dice.max}`);
  if (p.conditions.length) console.log(`  Conditions: ${p.conditions.map((c) => c.id).join(", ")}`);
  console.log();
}

function inventory(): void {
  const held = itemsOwnedBy(state, state.meta.pc_id);
  console.log();
  if (!held.length) console.log("  You are carrying nothing.");
  for (const i of held) {
    const def = state.item_defs[i.def_id];
    const eq = Object.values(pc(state).equipped).includes(i.id) ? " [equipped]" : "";
    console.log(`  ${def?.name ?? i.def_id}${i.qty > 1 ? ` x${i.qty}` : ""}${eq}${i.nickname ? ` — ${i.nickname}` : ""}`);
  }
  console.log();
}

function quests(): void {
  console.log();
  const qs = Object.values(state.quests).filter((q) => q.visibility !== "hidden");
  if (!qs.length) console.log("  No quests.");
  for (const q of qs) {
    console.log(`  [${q.status}] ${q.title}`);
    console.log(`     ${q.summary}`);
    const step = q.steps.find((st) => st.id === q.current_step_id);
    if (step && q.status === "active") console.log(`     Now: ${step.desc}`);
    for (const l of q.leads) console.log(`     · ${l.text}`);
  }
  console.log();
}

function who(): void {
  console.log();
  const here = npcsPresent(state, pc(state).location_id);
  if (!here.length) console.log("  You are alone.");
  for (const e of here) {
    const rel = state.relationships[`${e.id}->${state.meta.pc_id}`];
    console.log(`  ${e.name} — ${rel ? `${dispositionOf(rel.dims.affinity)} (aff ${rel.dims.affinity}, trust ${rel.dims.trust}, fear ${rel.dims.fear})` : "no opinion of you"}`);
    if (rel?.opinion) console.log(`     "${rel.opinion}"`);
  }
  console.log();
}

function help(): void {
  console.log(`
  Say what you do, in your own words:
      "talk to thorne about the bell"      "sneak past the guard"
      "search behind the altar"            "head down to the shrine"

  /actions                           what you can do right now, with the math
  Ask the DM anything. It costs no turn and no time:
      "what's around me?"     "who is here?"     "how hurt is it?"
      "what do I know about the bell?"           "how long have I got?"

  /look /sheet /inv /quests /who     information, costs no time
  /timeline                          every turn so far
  /rewind <turn>                     return to any earlier turn
  /branches                          timelines set aside by a rewind
  /save /quit
`);
}
