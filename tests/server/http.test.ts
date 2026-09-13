import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { JsonFileStore } from "../../src/state/jsonFileStore.js";
import { MockLLM } from "../../src/llm/mock.js";
import { GameService } from "../../src/server/service.js";
import { createGameServer } from "../../src/server/http.js";

/**
 * The wire, over a real socket. Everything interesting lives in the service; what is
 * asserted here is the translation — status codes, the event stream, auth, and the static
 * fallback — because those are the parts a client actually collides with.
 */

const CONTENT = path.join(process.cwd(), "content", "campaign");

let root: string;
let server: Server;
let base: string;

async function start(opts: Parameters<typeof createGameServer>[1] = {}): Promise<void> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "dnd-http-"));
  const svc = new GameService(new JsonFileStore(root), new MockLLM({ seed: "http" }), { contentRoot: CONTENT });
  server = createGameServer(svc, opts);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => start());

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await fs.rm(root, { recursive: true, force: true });
});

const get = (p: string, init?: RequestInit) => fetch(`${base}${p}`, init);
/** `res.json()` is `unknown` under strict TS; tests want a shape. */
const readJson = async <T = Record<string, never>>(res: Response): Promise<T> => (await res.json()) as T;
const post = (p: string, body: unknown, init: RequestInit = {}) =>
  fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...(init.headers ?? {}) }, body: JSON.stringify(body), ...init });

/** Read an event stream to the end, returning the parsed frames in order. */
async function frames(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.includes("data:"))
    .map((b) => JSON.parse(b.split("\n").find((l) => l.startsWith("data:"))!.slice(5).trim()) as Record<string, unknown>);
}

async function makeSave(id = "save_http"): Promise<void> {
  const res = await post("/api/saves", { campaign: "drowned_bell", save_id: id });
  expect(res.status).toBe(201);
}

describe("the API surface", () => {
  it("answers health with the routes it serves", async () => {
    const res = await get("/api/health");
    expect(res.status).toBe(200);
    expect((await readJson<{ ok: boolean }>(res)).ok).toBe(true);
  });

  it("creates, lists and reads back a save", async () => {
    await makeSave();
    const list = await readJson<Array<{ id: string }>>(await get("/api/saves"));
    expect(list.map((s) => s.id)).toContain("save_http");

    // The id in the list is the id the other routes take. If those ever diverge, every
    // client is one dead link away from a 404 it cannot explain.
    const snap = await readJson<{ version: number; screen: { scene: { location: { name: string } } } }>(await get(`/api/saves/${list[0]!.id}`));
    expect(snap.version).toBe(0);
    expect(snap.screen.scene.location.name.length).toBeGreaterThan(0);
  });

  it("streams a turn as server-sent events, mechanics first", async () => {
    await makeSave();
    const res = await post("/api/saves/save_http/turn", { text: "look around", expect_version: 0 });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const got = await frames(res);
    const order = got.map((f) => f.t);
    expect(order[0]).toBe("intent");
    expect(order.indexOf("mechanics")).toBeLessThan(order.indexOf("prose"));
    expect(order[order.length - 1]).toBe("done");
  });

  it("refuses a stale turn with a 409 rather than an empty stream", async () => {
    await makeSave();
    await frames(await post("/api/saves/save_http/turn", { text: "look around", expect_version: 0 }));

    // A conflict a client can handle with its ordinary error path, not a stream that ends
    // after one frame and leaves it guessing.
    const res = await post("/api/saves/save_http/turn", { text: "search the bar", expect_version: 0 });
    expect(res.status).toBe(409);
    const body = await readJson<{ error: string; actual_version: number }>(res);
    expect(body.error).toBe("version_conflict");
    expect(body.actual_version).toBeGreaterThan(0);
  });

  it("answers a question without streaming and without a turn", async () => {
    await makeSave();
    const res = await post("/api/saves/save_http/ask", { text: "who is here?" });
    expect(res.status).toBe(200);
    const body = await readJson<{ understood: boolean }>(res);
    expect(body.understood).toBe(true);
    expect((await readJson<{ version: number }>(await get("/api/saves/save_http"))).version).toBe(0);
  });

  it("previews, and reports history, rejects and costs", async () => {
    await makeSave();
    await frames(await post("/api/saves/save_http/turn", { text: "look around", expect_version: 0 }));

    const p = await readJson<{ legal: boolean }>(await post("/api/saves/save_http/preview", { action: { type: "look" } }));
    expect(p.legal).toBe(true);
    expect((await readJson<{ rows: unknown[] }>(await get("/api/saves/save_http/history"))).rows.length).toBeGreaterThan(0);
    expect(Array.isArray(await readJson<unknown[]>(await get("/api/saves/save_http/rejects")))).toBe(true);
    expect((await readJson<{ total_tokens: number }>(await get("/api/saves/save_http/costs"))).total_tokens).toBeGreaterThan(0);
  });

  it("offers the catalogue a new-game screen needs", async () => {
    const cat = await readJson<{ classes: unknown[]; campaigns: Array<{ id: string }> }>(await get("/api/catalogue"));
    expect(cat.classes).toHaveLength(10);
    expect(cat.campaigns.some((c: { id: string }) => c.id === "drowned_bell")).toBe(true);
  });
});

describe("when the request is wrong", () => {
  it("404s an unknown save and an unknown route", async () => {
    expect((await get("/api/saves/save_ghost")).status).toBe(404);
    expect((await get("/api/nope")).status).toBe(404);
  });

  it("409s a duplicate save id", async () => {
    await makeSave();
    expect((await post("/api/saves", { campaign: "drowned_bell", save_id: "save_http" })).status).toBe(409);
  });

  it("400s a body that is not JSON, and says so", async () => {
    const res = await fetch(`${base}/api/saves`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oh no" });
    expect(res.status).toBe(400);
    expect((await readJson<{ error: string }>(res)).error).toMatch(/JSON/);
  });

  it("400s a save id that is not an id, with a message that says what to type", async () => {
    const res = await post("/api/saves", { campaign: "drowned_bell", save_id: "Not An Id" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await readJson(res))).toMatch(/prefix_name/);
  });
});

describe("the door", () => {
  it("needs the secret when one is set, on every API route", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await fs.rm(root, { recursive: true, force: true });
    await start({ secret: "hunter2" });

    expect((await get("/api/saves")).status).toBe(401);
    const ok = await get("/api/saves", { headers: { authorization: "Bearer hunter2" } });
    expect(ok.status).toBe(200);
  });

  it("serves a built client and falls back to its shell for client routes", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    const dist = await fs.mkdtemp(path.join(os.tmpdir(), "dnd-dist-"));
    await fs.writeFile(path.join(dist, "index.html"), "<!doctype html><title>shell</title>", "utf8");
    await fs.writeFile(path.join(dist, "app.js"), "export default 1;", "utf8");
    await start({ staticDir: dist });

    expect(await (await get("/")).text()).toContain("shell");
    expect((await get("/app.js")).headers.get("content-type")).toContain("javascript");
    // An unknown path with no extension is a client route, and the client decides.
    expect(await (await get("/play/save_http")).text()).toContain("shell");
    // A missing asset is a missing asset, not the shell wearing a .css name.
    expect((await get("/missing.css")).status).toBe(404);

    await fs.rm(dist, { recursive: true, force: true });
  });

  it("refuses to serve outside the static root", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    const dist = await fs.mkdtemp(path.join(os.tmpdir(), "dnd-dist2-"));
    await fs.writeFile(path.join(dist, "index.html"), "<!doctype html>ok", "utf8");
    await start({ staticDir: dist });

    // `fetch` normalises a literal `../` out of the path before sending, so the guard is
    // only reachable percent-encoded — which is exactly how an attacker would send it.
    const res = await get("/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd");
    expect([403, 404]).toContain(res.status);
    expect(await res.text()).not.toContain("root:");
    await fs.rm(dist, { recursive: true, force: true });
  });
});
