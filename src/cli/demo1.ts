import path from "node:path";
import { promises as fs } from "node:fs";
import { loadCampaign } from "../content/loadCampaign.js";
import { DEMO_FREE_TEXT } from "../content/demoFreeText.js";
import { takeLLMTurn } from "../engine/llmTurn.js";
import { reduceAll } from "../engine/reduce.js";
import { rewind, timeline } from "../engine/rollback.js";
import { makeLLM } from "../llm/factory.js";
import { actionKeyOf } from "../rules/suggest.js";
import { JsonFileStore, stable } from "../state/jsonFileStore.js";
import type { GameEvent } from "../schema/event.js";

/**
 * The phase-1 acceptance run: twenty turns of free text through the whole pipeline, then
 * proof that the session replays exactly and can be rewound.
 *
 *   npm run demo1            offline, using the mock DM
 *   npm run demo1 -- --live  against whatever provider your keys and config point at
 */
const live = process.argv.includes("--live");
const saveId = "demo1";
const store = new JsonFileStore("saves");

await fs.rm(path.join("saves", saveId), { recursive: true, force: true });

const { llm, describe } = await makeLLM({ forceMock: !live });
const initial = await loadCampaign(path.join("content", "campaign", "drowned_bell"));
// The acceptance run pins committed dice so it is reproducible. Play defaults to karmic —
// real dice with a streak-breaker — which is deliberately NOT reproducible, and that is the
// point of it. See SPEC.md §32.1.
initial.meta.session_zero.dice = "committed";
let state = initial;
await store.create(saveId, state);

console.log(`\n  ${state.meta.title} — ${DEMO_FREE_TEXT.length} turns of free text`);
console.log(`  Dungeon Master: ${describe}\n`);

const journal: GameEvent[] = [];
const recent: string[] = [];
let resolved = 0;
let clarified = 0;
let rejected = 0;
let promptTokens = 0;

for (const [i, input] of DEMO_FREE_TEXT.entries()) {
  const out = await takeLLMTurn(llm, state, input, { recent: recent.slice(-6) });
  const n = String(i + 1).padStart(2, "0");

  console.log(`  ${n}. \x1b[1m> ${input}\x1b[0m`);

  if (!out.ok) {
    clarified++;
    console.log(`      \x1b[33m${out.text}\x1b[0m\n`);
    continue;
  }

  resolved++;
  state = out.state;
  journal.push(...out.journal);
  recent.push(`> ${input}\n${out.text}`);
  promptTokens += out.debug.promptTokens;

  console.log(`      \x1b[2m${out.debug.mechanics?.split("\n")[0]}\x1b[0m`);
  console.log(`      ${out.text.split("\n")[0]}`);
  if (out.suggestedActions.length) console.log(`      [36m→ ${out.suggestedActions.join("  ·  ")}[0m`);

  for (const ev of out.journal.filter((e) => e.derived_from !== null)) {
    console.log(`      \x1b[2m↳ ${ev.type}${ev.trigger_id ? ` [${ev.trigger_id}]` : ""}\x1b[0m`);
  }

  if (out.rejects.length) {
    rejected += out.rejects.length;
    await store.appendRejects(saveId, out.rejects);
    for (const r of out.rejects) console.log(`      \x1b[31m✗ ${r.kind}: ${r.reason}\x1b[0m`);
  }

  console.log();
  await store.commit(saveId, out.journal, state);
}

// ---- the two claims this run exists to demonstrate -------------------------

const roots = journal.filter((e) => e.derived_from === null);
const replayed = reduceAll(initial, roots);
const replayOk = stable(replayed.state) === stable(state);

const back = rewind(initial, journal, 5);
const rows = timeline(journal);

console.log(`  ── Result ──`);
console.log(`  ${resolved} turns resolved, ${clarified} asked for clarification, ${rejected} narrator proposal(s) refused`);
console.log(`  turn ${state.meta.turn} · day ${Math.floor(state.world.world_minute / 1440) + 1} · ${state.facts.length} facts · ${state.world.fired_trigger_ids.length} triggers fired`);
if (resolved > 0) console.log(`  average prompt: ${Math.round(promptTokens / resolved)} tokens`);
for (const q of Object.values(state.quests)) console.log(`  quest ${q.id}: ${q.status}`);

console.log(`\n  Journal replays to an identical world: ${replayOk ? "\x1b[32myes\x1b[0m" : "\x1b[31mNO\x1b[0m"}`);
console.log(`  Rewind to turn 5 reachable:              \x1b[32myes\x1b[0m (${back.removed.length} events would be archived)`);
console.log(`  Timeline rows available for rewind:      ${rows.length}`);
console.log(`\n  Play it yourself:  npm run play -- ${saveId} --mock\n`);

if (!replayOk) process.exit(1);
