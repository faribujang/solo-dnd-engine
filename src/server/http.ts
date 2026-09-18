import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { GameService, ServiceError, type Frame } from "./service.js";
import { ENDPOINTS } from "./contract.js";

/**
 * THE WIRE.
 *
 * Plain `node:http`, no framework. The contract is nine routes and one of them streams;
 * that does not need a dependency, and a dependency here would be the first thing to rot.
 * Everything interesting is in `GameService`; this file turns requests into calls and
 * frames into server-sent events.
 *
 * Two decisions made here rather than in the service:
 *
 *   A VERSION CONFLICT IS A 409 BEFORE THE STREAM OPENS. Checking the version in JSON
 *   means a client gets a normal error response it already knows how to handle, instead of
 *   a stream that ends after one frame. The service checks again under its lock, so the
 *   race between the two checks resolves safely — it just arrives as a frame instead.
 *
 *   STATIC FILES ARE SERVED HERE, WITH AN SPA FALLBACK. One process, one port, one thing
 *   to deploy. A path that is not an API route and not a file is the client's problem.
 */

export interface HttpOptions {
  /** Built client to serve at `/`. Omit to serve only the API. */
  staticDir?: string;
  /** Shared secret. When set, every /api request must carry `authorization: Bearer <secret>`. */
  secret?: string;
  /** CORS origin for a client served from elsewhere (a dev server, say). */
  allowOrigin?: string;
}

export function createGameServer(service: GameService, opts: HttpOptions = {}): http.Server {
  return http.createServer((req, res) => {
    handle(service, opts, req, res).catch((err: unknown) => {
      if (!res.headersSent) sendError(res, err);
      else res.end();
    });
  });
}

// ──────────────────────────────────────────────────────────── routing

const ROUTES: Array<{ method: string; pattern: RegExp; name: string }> = [
  { method: "GET", pattern: /^\/api\/health$/, name: "health" },
  { method: "GET", pattern: /^\/api\/catalogue$/, name: "catalogue" },
  { method: "GET", pattern: /^\/api\/saves$/, name: "saves" },
  { method: "POST", pattern: /^\/api\/saves$/, name: "create" },
  { method: "GET", pattern: /^\/api\/saves\/([^/]+)$/, name: "snapshot" },
  { method: "POST", pattern: /^\/api\/saves\/([^/]+)\/turn$/, name: "turn" },
  { method: "POST", pattern: /^\/api\/saves\/([^/]+)\/ask$/, name: "ask" },
  { method: "POST", pattern: /^\/api\/saves\/([^/]+)\/preview$/, name: "preview" },
  { method: "GET", pattern: /^\/api\/saves\/([^/]+)\/history$/, name: "history" },
  { method: "POST", pattern: /^\/api\/saves\/([^/]+)\/rewind$/, name: "rewind" },
  { method: "POST", pattern: /^\/api\/saves\/([^/]+)\/rewind\/plan$/, name: "rewind_plan" },
  { method: "GET", pattern: /^\/api\/saves\/([^/]+)\/rejects$/, name: "rejects" },
  { method: "GET", pattern: /^\/api\/saves\/([^/]+)\/costs$/, name: "costs" },
];

async function handle(service: GameService, opts: HttpOptions, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = (req.method ?? "GET").toUpperCase();

  if (opts.allowOrigin) {
    res.setHeader("access-control-allow-origin", opts.allowOrigin);
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  }

  if (!url.pathname.startsWith("/api/")) {
    if (opts.staticDir && (method === "GET" || method === "HEAD")) return serveStatic(opts.staticDir, url.pathname, res);
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }

  if (opts.secret) {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${opts.secret}`) throw new ServiceError(401, "This game needs its secret.");
  }

  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(url.pathname);
    if (!m) continue;
    const id = m[1] ? decodeURIComponent(m[1]) : "";

    switch (r.name) {
      case "health":
        return json(res, 200, { ok: true, endpoints: ENDPOINTS });
      case "catalogue":
        return json(res, 200, await service.catalogue());
      case "saves":
        return json(res, 200, await service.listSaves());
      case "create":
        return json(res, 201, await service.createSave(await body(req)));
      case "snapshot":
        return json(res, 200, await service.snapshot(id));
      case "turn":
        return turn(service, id, await body(req), res);
      case "ask": {
        const b = (await body(req)) as { text?: unknown };
        if (typeof b.text !== "string" || !b.text.trim()) throw new ServiceError(400, "Ask something.");
        return json(res, 200, await service.ask(id, b.text));
      }
      case "preview": {
        const b = (await body(req)) as { action?: unknown };
        return json(res, 200, await service.preview(id, b.action));
      }
      case "history":
        return json(res, 200, await service.history(id));
      case "rewind_plan": {
        const b = (await body(req)) as { text?: unknown };
        if (typeof b.text !== "string" || !b.text.trim()) throw new ServiceError(400, "Describe where to go back to.");
        return json(res, 200, await service.planRewind(id, b.text));
      }
      case "rewind": {
        const out = await service.rewind(id, await body(req));
        if ("error" in out) return json(res, 409, out);
        return json(res, 200, out);
      }
      case "rejects":
        return json(res, 200, await service.rejects(id));
      case "costs":
        return json(res, 200, await service.costs(id));
    }
  }

  json(res, 404, { error: "no such route" });
}

// ──────────────────────────────────────────────────────── the stream

async function turn(service: GameService, id: string, raw: unknown, res: http.ServerResponse): Promise<void> {
  // The cheap check first, as a normal response. The service repeats it under the lock.
  const b = raw as { expect_version?: unknown };
  const snap = await service.snapshot(id);
  if (typeof b.expect_version === "number" && b.expect_version !== snap.version) {
    return json(res, 409, {
      error: "version_conflict",
      actual_version: snap.version,
      message: `The world moved since you last looked (you had ${b.expect_version}, it is at ${snap.version}).`,
    });
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",     // nginx: do not hold the stream
  });
  res.flushHeaders?.();

  const emit = (f: Frame) => {
    if (res.destroyed) return;
    res.write(`event: ${f.t}\ndata: ${JSON.stringify(f)}\n\n`);
  };

  try {
    await service.turn(id, raw, emit);
  } catch (err) {
    emit({ t: "error", message: err instanceof Error ? err.message : String(err), retryable: false });
  }
  res.end();
}

// ─────────────────────────────────────────────────────────── helpers

async function body(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 1_000_000) throw new ServiceError(413, "That is too much to say at once.");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ServiceError(400, "The body was not JSON.");
  }
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof ServiceError) return json(res, err.status, { error: err.message });
  if (err instanceof ZodError) {
    return json(res, 400, { error: "bad request", issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  }
  const message = err instanceof Error ? err.message : String(err);
  json(res, 500, { error: message });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".webmanifest": "application/manifest+json", ".txt": "text/plain",
};

async function serveStatic(dir: string, pathname: string, res: http.ServerResponse): Promise<void> {
  const root = path.resolve(dir);
  let target = path.resolve(root, `.${decodeURIComponent(pathname)}`);
  if (!target.startsWith(root)) { res.writeHead(403); res.end(); return; }

  const tryFile = async (p: string): Promise<boolean> => {
    try {
      const st = await fs.stat(p);
      if (!st.isFile()) return false;
      const ext = path.extname(p).toLowerCase();
      const data = await fs.readFile(p);
      res.writeHead(200, {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "content-length": data.length,
        // Hashed assets are immutable; the shell is not.
        "cache-control": /\.[a-f0-9]{8,}\./i.test(path.basename(p)) ? "public, max-age=31536000, immutable" : "no-cache",
      });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  };

  if (pathname.endsWith("/")) target = path.join(target, "index.html");
  if (await tryFile(target)) return;
  // SPA fallback: an unknown path is a client route, and the client decides.
  if (!path.extname(pathname) && (await tryFile(path.join(root, "index.html")))) return;
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}
