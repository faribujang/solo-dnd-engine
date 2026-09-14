import { promises as fs } from "node:fs";
import path from "node:path";
import type { LLMClient } from "./client.js";
import { MockLLM } from "./mock.js";
import { ModelConfig, Router } from "./router.js";
import { providersFromEnv } from "./openaiCompat.js";

/**
 * Build the client the game should use, from config plus whatever keys are in the
 * environment.
 *
 * With no keys, this returns MockLLM — deterministic, offline and free. That is not a
 * degraded mode bolted on for tests; it is how the whole engine is developed, and it means
 * a contributor can play the game and run the suite without an account anywhere.
 */
export async function makeLLM(opts: { configPath?: string; forceMock?: boolean } = {}): Promise<{
  llm: LLMClient;
  describe: string;
}> {
  if (opts.forceMock) {
    return { llm: new MockLLM({ seed: "cli" }), describe: "mock (forced)" };
  }

  const configPath = opts.configPath ?? path.join("config", "models.json");

  let config: ModelConfig;
  try {
    config = ModelConfig.parse(JSON.parse(await fs.readFile(configPath, "utf8")));
  } catch {
    return { llm: new MockLLM({ seed: "cli" }), describe: "mock (no readable config/models.json)" };
  }

  const providers = providersFromEnv(config.roles, process.env, config.providers);

  if (providers.size === 0) {
    return { llm: new MockLLM({ seed: "cli" }), describe: "mock (no API keys set)" };
  }

  const unset = Object.values(config.roles).filter((r) => r.model === "REPLACE_ME");
  if (unset.length > 0) {
    return {
      llm: new MockLLM({ seed: "cli" }),
      describe: "mock (config/models.json still says REPLACE_ME — see config/README.md)",
    };
  }

  return {
    llm: new Router(config, providers),
    describe: `router over ${[...providers.keys()].join(", ")}`,
  };
}
