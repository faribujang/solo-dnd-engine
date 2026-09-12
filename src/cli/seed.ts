import path from "node:path";
import { loadCampaign } from "../content/loadCampaign.js";
import { JsonFileStore } from "../state/jsonFileStore.js";

/**
 * Create a fresh save from authored content.
 *   npm run seed -- [campaign-name] [save-id]
 */
const campaignName = process.argv[2] ?? "drowned_bell";
const saveId = process.argv[3] ?? campaignName;

const contentDir = path.join("content", "campaign", campaignName);
const store = new JsonFileStore("saves");

const state = await loadCampaign(contentDir);

if (await store.exists(saveId)) {
  console.error(`Save "${saveId}" already exists. Delete saves/${saveId} first, or pass another id.`);
  process.exit(1);
}

await store.create(saveId, state);

console.log(`Seeded save "${saveId}" from ${contentDir}`);
console.log(`  ${Object.keys(state.locations).length} locations, ${Object.keys(state.entities).length} entities, ${Object.keys(state.quests).length} quests, ${state.facts.length} seed facts`);
console.log(`  Play it with:  npm run play -- ${saveId}`);
