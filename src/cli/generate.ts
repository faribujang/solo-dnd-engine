import { existsSync } from "node:fs";
import path from "node:path";
import { makeLLM } from "../llm/factory.js";
import { generateCampaign } from "../content/generateRun.js";
import type { Stage } from "../content/generate.js";

/**
 * Generate a campaign.
 *
 *   npm run generate -- "The Salt Road" [--premise "..."] [--out content/campaign/salt_road]
 *                       [--until quests] [--mock]
 *
 * Offline authoring, not runtime. The output is validated and written as ordinary content;
 * read it, edit it, then play it. Nothing here reaches the game.
 */
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const title = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true);
if (!title) {
  console.error(`\n  Usage: npm run generate -- "Campaign Title" [--premise "..."] [--out DIR] [--until STAGE] [--mock]\n`);
  process.exit(1);
}

const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const outDir = flag("out") ?? path.join("content", "campaign", slug);

if (existsSync(outDir)) {
  console.error(`\n  ${outDir} already exists. Move it aside or pass --out.\n`);
  process.exit(1);
}

const { llm, describe } = await makeLLM({ forceMock: args.includes("--mock") });
if (llm.name === "mock") {
  console.error(`\n  The generator needs a real model — the mock cannot author a world.`);
  console.error(`  Set a key in .env and fill in config/models.json. (${describe})\n`);
  process.exit(1);
}

console.log(`\n  Generating "${title}"`);
console.log(`  Model: ${describe}`);
console.log(`  Out:   ${outDir}\n`);

const result = await generateCampaign(llm, {
  title,
  ...(flag("premise") ? { premise: flag("premise")! } : {}),
  outDir,
  ...(flag("until") ? { until: flag("until") as Stage } : {}),
  onStage: (stage, note) => console.log(`  ${stage.padEnd(10)} ${note}`),
});

console.log();
for (const i of result.issues) {
  console.log(`  ${i.severity === "error" ? "✗" : "!"} ${i.where}: ${i.message}`);
}

if (!result.ok) {
  console.error(`\n  Not written. Fix the errors above, or run again — a generator is allowed to fail.\n`);
  process.exit(1);
}

console.log(`\n  ✓ Written to ${outDir}`);
console.log(`    Read it before you play it. Then:  npm run seed -- ${path.basename(outDir)}\n`);
