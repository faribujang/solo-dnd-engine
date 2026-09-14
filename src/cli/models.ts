import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Find out what your key can actually run, and wire it up.
 *
 *   npm run models                 # list what each key you have can reach
 *   npm run models -- --write      # fill config/models.json with sensible picks
 *
 * Model ids are deliberately not hardcoded anywhere in this repo — free tiers and model
 * names both move faster than code, and a hardcoded id is a bug with a delay on it. This
 * asks the provider instead, which is the only source that is never out of date.
 */

const write = process.argv.includes("--write");
const CONFIG = path.join("config", "models.json");

interface Provider { name: string; baseUrl: string; key: string }

const providers: Provider[] = [];
if (process.env["GEMINI_API_KEY"]) {
  providers.push({
    name: "gemini",
    baseUrl: process.env["GEMINI_BASE_URL"] ?? "https://generativelanguage.googleapis.com/v1beta/openai",
    key: process.env["GEMINI_API_KEY"],
  });
}
if (process.env["OPENROUTER_API_KEY"]) {
  providers.push({
    name: "openrouter",
    baseUrl: process.env["OPENROUTER_BASE_URL"] ?? "https://openrouter.ai/api/v1",
    key: process.env["OPENROUTER_API_KEY"],
  });
}

if (providers.length === 0) {
  console.error(`
  No keys found.

  Put one in .env (copy .env.example) and run this again:

      GEMINI_API_KEY=...          free tier, and plenty for a Dungeon Master
      OPENROUTER_API_KEY=...      one key, most models, pay as you go

  Without a key the game runs on the mock DM, which is offline, free, deterministic —
  and deliberately a dull writer. It is there to prove the machinery, not to narrate.
`);
  process.exit(1);
}

/** Ask a provider what it has. Both of ours speak the OpenAI /models shape. */
async function listModels(p: Provider): Promise<string[]> {
  const res = await fetch(`${p.baseUrl}/models`, { headers: { authorization: `Bearer ${p.key}` } });
  if (!res.ok) throw new Error(`${p.name} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  return (json.data ?? []).map((m) => m.id ?? "").filter(Boolean).sort();
}

/**
 * Pick a model for a role.
 *
 * The heuristic is deliberately crude and stated rather than hidden: prefer something that
 * looks small and fast for parsing, something that looks capable for prose. It is a
 * starting point you are expected to override once you have heard the difference.
 */
function pick(ids: string[], want: "cheap" | "good"): string | null {
  const norm = ids.map((id) => ({ id, s: id.toLowerCase() }));
  const cheapHints = ["flash-lite", "mini", "haiku", "8b", "small", "flash"];
  const goodHints = ["pro", "opus", "sonnet", "70b", "large", "thinking"];
  const avoid = ["embed", "vision", "tts", "audio", "image", "whisper", "rerank", "moderation"];
  const usable = norm.filter((m) => !avoid.some((a) => m.s.includes(a)));
  const hints = want === "cheap" ? cheapHints : goodHints;
  for (const h of hints) {
    const hit = usable.find((m) => m.s.includes(h));
    if (hit) return hit.id;
  }
  return usable[0]?.id ?? null;
}

const found = new Map<string, string[]>();
for (const p of providers) {
  process.stdout.write(`  ${p.name.padEnd(12)}`);
  try {
    const ids = await listModels(p);
    found.set(p.name, ids);
    console.log(`${ids.length} models`);
    for (const id of ids.slice(0, 14)) console.log(`      ${id}`);
    if (ids.length > 14) console.log(`      … and ${ids.length - 14} more`);
  } catch (err) {
    console.log(`unreachable — ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (!write) {
  console.log(`\n  Run again with --write to fill in config/models.json from these.\n`);
  process.exit(0);
}

const primary = [...found.entries()].find(([, ids]) => ids.length > 0);
if (!primary) {
  console.error(`\n  Nothing reachable. Nothing written.\n`);
  process.exit(1);
}
const [provider, ids] = primary;
const cheap = pick(ids, "cheap");
const good = pick(ids, "good");
if (!cheap || !good) {
  console.error(`\n  ${provider} returned models but none looked usable for chat. Nothing written.\n`);
  process.exit(1);
}

const config = JSON.parse(await fs.readFile(CONFIG, "utf8")) as {
  roles: Record<string, { provider: string; model: string; max_tokens: number; temperature: number }>;
  fallback_chain: string[];
};

// Parsing and bookkeeping go to the cheap model; anything a player reads goes to the good one.
const cheapRoles = ["intent", "digest", "ambient", "companion"];
for (const [role, cfg] of Object.entries(config.roles)) {
  cfg.provider = provider;
  cfg.model = cheapRoles.includes(role) ? cheap : good;
}
config.fallback_chain = [...found.keys()];

await fs.writeFile(CONFIG, JSON.stringify(config, null, 2) + "\n", "utf8");

console.log(`\n  Wrote ${CONFIG}`);
console.log(`    parsing and bookkeeping → ${cheap}`);
console.log(`    everything you read     → ${good}`);
console.log(`\n  These are a guess from the model names. Change them once you have heard the difference.`);
console.log(`  Then:  npm run play -- wick\n`);
