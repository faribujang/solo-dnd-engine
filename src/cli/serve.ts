import { existsSync } from "node:fs";
import path from "node:path";
import { makeLLM } from "../llm/factory.js";
import { JsonFileStore } from "../state/jsonFileStore.js";
import { GameService } from "../server/service.js";
import { createGameServer } from "../server/http.js";

/**
 * Serve the game.
 *
 *   npm run serve -- [--mock] [--port 8787]
 *
 * With a built client in web/dist this is the whole deployment: one process, one port. In
 * development the client runs on its own dev server and talks to this over CORS.
 *
 * Environment:
 *   PORT           default 8787
 *   GAME_SECRET    when set, every API call needs `Authorization: Bearer <secret>`
 *   CORS_ORIGIN    default "*" in development; set it to the client's origin in production
 *   MAX_TOKENS_PER_SAVE   narration budget ceiling per save; 0 (default) means none
 */
const args = process.argv.slice(2);
const forceMock = args.includes("--mock");
const portArg = args.indexOf("--port");
const port = Number(portArg >= 0 ? args[portArg + 1] : process.env["PORT"] ?? 8787);

const store = new JsonFileStore("saves");
const { llm, describe } = await makeLLM({ forceMock });

const service = new GameService(store, llm, {
  contentRoot: path.join("content", "campaign"),
  budget: {
    max_tokens_per_save: Number(process.env["MAX_TOKENS_PER_SAVE"] ?? 0),
  },
});

const staticDir = existsSync(path.join("web", "dist", "index.html")) ? path.join("web", "dist") : undefined;

const server = createGameServer(service, {
  ...(staticDir ? { staticDir } : {}),
  ...(process.env["GAME_SECRET"] ? { secret: process.env["GAME_SECRET"] } : {}),
  allowOrigin: process.env["CORS_ORIGIN"] ?? "*",
});

server.listen(port, () => {
  console.log(`\n  Solo D&D engine — serving on http://localhost:${port}`);
  console.log(`  Dungeon Master: ${describe}`);
  console.log(staticDir ? `  Client: ${staticDir}` : `  Client: not built (run \`npm run build\` in web/, or use its dev server)`);
  console.log(`  API:    http://localhost:${port}/api/health\n`);
});
