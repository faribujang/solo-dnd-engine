import path from "node:path";
import { promises as fs } from "node:fs";
import { loadCampaign } from "../content/loadCampaign.js";
import { DEMO_SCRIPT } from "../content/demoScript.js";
import { describe as describeAction, takeTurn } from "../engine/session.js";
import { JsonFileStore } from "../state/jsonFileStore.js";

/**
 * Run the phase-0 acceptance script through the real persistence path and leave a save
 * behind, so `npm run rebuild -- demo` can verify the journal reproduces it.
 *
 *   npm run demo
 */
const saveId = "demo";
const store = new JsonFileStore("saves");

await fs.rm(path.join("saves", saveId), { recursive: true, force: true });

let state = await loadCampaign(path.join("content", "campaign", "drowned_bell"));
// The acceptance run pins committed dice so it is reproducible. Play defaults to karmic —
// real dice with a streak-breaker — which is deliberately NOT reproducible, and that is the
// point of it. See SPEC.md §32.1.
state.meta.session_zero.dice = "committed";
await store.create(saveId, state);

console.log(`\n  ${state.meta.title} — ${DEMO_SCRIPT.length} scripted actions\n`);

let refusals = 0;
for (const [i, action] of DEMO_SCRIPT.entries()) {
  const out = takeTurn(state, action);
  const n = String(i + 1).padStart(2, "0");

  if (!out.ok) {
    refusals++;
    console.log(`  ${n}. ${describeAction(action)}\n      ✗ ${out.message}`);
    continue;
  }

  state = out.state;
  console.log(`  ${n}. ${describeAction(action)}\n      ${out.message}`);
  for (const ev of out.journal.filter((e) => e.derived_from !== null)) {
    console.log(`      ↳ ${ev.type}${ev.trigger_id ? `  [${ev.trigger_id}]` : ""}`);
  }

  await store.commit(saveId, out.journal, state);
}

const journal = await store.readJournal(saveId);

console.log(`\n  ── Result ──`);
console.log(`  turn ${state.meta.turn} · day ${Math.floor(state.world.world_minute / 1440) + 1} · ${refusals} refusal(s)`);
console.log(`  journal: ${journal.length} events (${journal.filter((e) => e.derived_from === null).length} root, ${journal.filter((e) => e.derived_from !== null).length} cascade)`);
console.log(`  facts:   ${state.facts.length}`);
console.log(`  triggers fired: ${state.world.fired_trigger_ids.length}`);
for (const q of Object.values(state.quests)) console.log(`  quest ${q.id}: ${q.status}`);
console.log(`\n  Verify the journal reproduces this world:  npm run rebuild -- demo\n`);
