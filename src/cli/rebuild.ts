import path from "node:path";
import { loadCampaign } from "../content/loadCampaign.js";
import { reduceAll } from "../engine/reduce.js";
import { JsonFileStore, stable } from "../state/jsonFileStore.js";

/**
 * Rebuild a save's world by replaying its journal from authored content.
 *   npm run rebuild -- [save-id] [campaign-name] [--write]
 *
 * This is the claim the whole architecture rests on: journal.jsonl is the source of truth
 * and every other file is a cache. Run it after any engine change — if the rebuilt world
 * differs from the live one, the reducer stopped being deterministic and you want to know
 * now rather than at turn 300.
 */
const saveId = process.argv[2] ?? "drowned_bell";
const campaignName = process.argv[3]?.startsWith("--") ? "drowned_bell" : process.argv[3] ?? "drowned_bell";
const write = process.argv.includes("--write");

const store = new JsonFileStore("saves");

if (!(await store.exists(saveId))) {
  console.error(`No save "${saveId}".`);
  process.exit(1);
}

const initial = await loadCampaign(path.join("content", "campaign", campaignName));
const live = await store.load(saveId);

// Session zero is chosen per SAVE, not authored into the campaign — difficulty, dice mode,
// lines and veils are the table's agreement for this run. Replay has to start from the same
// agreement or it is rebuilding a different game.
initial.meta.session_zero = live.meta.session_zero;
const journal = await store.readJournal(saveId);
const roots = journal.filter((e) => e.derived_from === null);

console.log(`Replaying ${roots.length} root events (${journal.length} total with cascades)...`);

const replayed = reduceAll(initial, roots);

const a = stable(replayed.state);
const b = stable(live);

if (a === b) {
  console.log(`✓ Rebuilt world is byte-identical to the live save.`);
  if (replayed.truncated) console.warn(`  (warning: a cascade hit the depth limit during replay)`);
  process.exit(0);
}

console.error(`✗ Rebuilt world DIFFERS from the live save.`);

// Point at the first differing line rather than dumping two whole worlds at the reader.
const al = a.split("\n");
const bl = b.split("\n");
for (let i = 0; i < Math.max(al.length, bl.length); i++) {
  if (al[i] !== bl[i]) {
    console.error(`\n  First difference at line ${i + 1}:`);
    console.error(`    replayed: ${al[i] ?? "<end of file>"}`);
    console.error(`    live:     ${bl[i] ?? "<end of file>"}`);
    break;
  }
}

if (write) {
  await store.commit(saveId, [], replayed.state);
  console.error(`\n  --write given: the save has been overwritten with the replayed world.`);
}

process.exit(1);
