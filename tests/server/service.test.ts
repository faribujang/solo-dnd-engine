import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonFileStore } from "../../src/state/jsonFileStore.js";
import { MockLLM } from "../../src/llm/mock.js";
import { LLMTransportError, type LLMClient, type LLMRequest, type LLMResponse } from "../../src/llm/client.js";
import { GameService, ServiceError, type Frame } from "../../src/server/service.js";
import { initialStateFor } from "../../src/content/createSave.js";
import { reduceAll } from "../../src/engine/reduce.js";
import { stable } from "../../src/state/jsonFileStore.js";

/**
 * The serving layer, driven directly. No sockets: `GameService` is deliberately free of
 * HTTP so the interesting behaviour — ordering, versions, the lock, the budget — can be
 * asserted without a server in the way.
 */

const CONTENT = path.join(process.cwd(), "content", "campaign");

let root: string;
let store: JsonFileStore;
let svc: GameService;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "dnd-svc-"));
  store = new JsonFileStore(root);
  svc = new GameService(store, new MockLLM({ seed: "svc" }), { contentRoot: CONTENT });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Run a turn and collect every frame it emitted, in order. */
async function turn(saveId: string, text: string, version: number): Promise<Frame[]> {
  const frames: Frame[] = [];
  await svc.turn(saveId, { text, expect_version: version }, (f) => frames.push(f));
  return frames;
}

const kinds = (frames: Frame[]): string[] => frames.map((f) => f.t);
const last = (frames: Frame[]): Frame => frames[frames.length - 1]!;

async function newSave(id = "save_one"): Promise<{ save_id: string; version: number }> {
  return svc.createSave({ campaign: "drowned_bell", save_id: id });
}

// ────────────────────────────────────────────────────────────── creating

describe("creating a save", () => {
  it("starts at version zero and loads back as a playable world", async () => {
    const made = await newSave();
    expect(made.version).toBe(0);

    const snap = await svc.snapshot("save_one");
    expect(snap.turn).toBe(0);
    expect(snap.version).toBe(0);
    expect(snap.screen.scene.location.name.length).toBeGreaterThan(0);
    // The client is handed view models and never GameState — the whole screen in one call.
    expect(snap.screen.palette.groups.length).toBeGreaterThan(0);
    expect(snap.screen.sheet.ac.parts.length).toBeGreaterThan(0);
  });

  it("refuses a duplicate id rather than overwriting somebody's campaign", async () => {
    await newSave();
    await expect(newSave()).rejects.toThrow(ServiceError);
  });

  it("refuses a campaign that does not exist", async () => {
    await expect(svc.createSave({ campaign: "no_such_place" })).rejects.toThrow(/No campaign/);
  });

  it("builds the character the table asked for, and records how", async () => {
    await svc.createSave({
      campaign: "drowned_bell", save_id: "save_made",
      session_zero: { difficulty: "hard", dice: "committed" },
      character: {
        name: "Bramble Ashgrove", pronouns: "she/her",
        race_id: "race_dwarf", class_id: "cls_barbarian", background_id: "bg_outlander",
        skills: ["athletics", "survival"],
        scores: { method: "standard", assignment: { str: 15, con: 14, dex: 13, wis: 12, cha: 10, int: 8 } },
      },
    });

    const snap = await svc.snapshot("save_made");
    expect(snap.player.name).toBe("Bramble Ashgrove");
    expect(snap.session_zero.difficulty).toBe("hard");
    // A barbarian's d12 and their starting kit, not the authored rogue's.
    expect(snap.screen.sheet.hp.max).toBeGreaterThan(10);
    expect(snap.screen.sheet.inventory.some((i) => i.equipped)).toBe(true);

    // And the recipe is on disk, so a rebuild starts from the same world.
    const creation = (await store.readCreation("save_made")) as { character?: { name: string } };
    expect(creation?.character?.name).toBe("Bramble Ashgrove");
  });

  it("rejects a character the rules do not allow", async () => {
    await expect(svc.createSave({
      campaign: "drowned_bell", save_id: "save_bad",
      character: {
        name: "Nobody", pronouns: "they/them",
        race_id: "race_human", class_id: "cls_wizard", background_id: "bg_sage",
        skills: ["athletics", "stealth"],   // a wizard takes neither
        scores: { method: "standard", assignment: { str: 15, con: 14, dex: 13, wis: 12, cha: 10, int: 8 } },
      },
    })).rejects.toThrow(/cannot take/);
  });
});

// ──────────────────────────────────────────────────────────── the turn

describe("a turn over the wire", () => {
  it("sends the roll card BEFORE a word of prose", async () => {
    await newSave();
    const frames = await turn("save_one", "search the bar", 0);
    const order = kinds(frames);

    // The decision the serving contract exists to protect. Reversing these two means the
    // player waits on the narrator to learn whether they hit.
    const mech = order.indexOf("mechanics");
    const prose = order.indexOf("prose");
    expect(mech).toBeGreaterThanOrEqual(0);
    expect(prose).toBeGreaterThan(mech);
    expect(order[0]).toBe("intent");
    expect(last(frames).t).toBe("done");
  });

  it("keeps the turn when the narrator dies mid-sentence", async () => {
    // The property the ordering exists for, proved the only way that cannot race: kill the
    // narrator outright and check the world moved anyway. Mechanics were committed before
    // it was ever asked, so a dead provider costs a paragraph and never a turn.
    const dead = new GameService(store, new DeadNarrator(), { contentRoot: CONTENT });
    await dead.createSave({ campaign: "drowned_bell", save_id: "save_dead" });

    const frames: Frame[] = [];
    await dead.turn("save_dead", { text: "search the bar", expect_version: 0 }, (f) => frames.push(f));

    const done = last(frames) as { t: "done"; mode: string; note: string | null; version: number };
    expect(done.t).toBe("done");
    expect(done.mode).toBe("mechanics_only");
    expect(done.note).toMatch(/could not be reached/i);

    // The dice landed, the journal has them, and the version the frame reported is real.
    expect(frames.some((f) => f.t === "mechanics")).toBe(true);
    expect(frames.some((f) => f.t === "prose")).toBe(false);
    const onDisk = await store.load("save_dead");
    expect(onDisk.meta.turn).toBeGreaterThan(0);
    expect(await journalLength("save_dead")).toBe(done.version);
  });

  it("streams the prose in pieces that add up to the narration", async () => {
    await newSave();
    const frames = await turn("save_one", "look around", 0);
    const streamed = frames.filter((f) => f.t === "prose").map((f) => (f as { delta: string }).delta).join("");
    expect(streamed.length).toBeGreaterThan(0);

    const feed = await store.readFeed("save_one");
    const narration = feed.find((r) => r.kind === "narration");
    expect(narration?.text).toBe(streamed);
  });

  it("moves the version by exactly the events it wrote", async () => {
    await newSave();
    const frames = await turn("save_one", "look around", 0);
    const done = last(frames) as { t: "done"; version: number };
    expect(done.t).toBe("done");
    expect(await journalLength("save_one")).toBe(done.version);
    expect(done.version).toBeGreaterThan(0);
  });

  it("keeps the transcript, so a refresh does not lose the thread", async () => {
    await newSave();
    const v = (last(await turn("save_one", "look around", 0)) as { version: number }).version;
    await turn("save_one", "search the bar", v);

    const snap = await svc.snapshot("save_one");
    const said = snap.recent.filter((r) => r.kind === "player").map((r) => r.text);
    expect(said).toEqual(["look around", "search the bar"]);
    // The feed carries rendered roll cards, because the client has no engine to make one.
    expect(snap.recent.some((r) => r.rolls.length > 0)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────── concurrency

describe("two tabs", () => {
  it("refuses the stale one rather than interleaving two turns", async () => {
    await newSave();
    const first = await turn("save_one", "look around", 0);
    const version = (last(first) as { version: number }).version;
    expect(version).toBeGreaterThan(0);

    // The second tab still believes the world is at zero.
    const stale = await turn("save_one", "search the bar", 0);
    expect(last(stale).t).toBe("conflict");
    expect((last(stale) as { actual_version: number }).actual_version).toBe(version);
    // Refused means refused: nothing was written.
    expect(await journalLength("save_one")).toBe(version);
  });

  it("serialises simultaneous turns instead of racing them", async () => {
    await newSave();
    // Both submitted against version 0, at the same moment. One must win outright.
    const [a, b] = await Promise.all([turn("save_one", "look around", 0), turn("save_one", "search the bar", 0)]);
    const outcomes = [last(a).t, last(b).t].sort();
    expect(outcomes).toEqual(["conflict", "done"]);
  });

  it("lets different saves proceed at once", async () => {
    await newSave("save_a");
    await newSave("save_b");
    const [x, y] = await Promise.all([turn("save_a", "look around", 0), turn("save_b", "look around", 0)]);
    expect(last(x).t).toBe("done");
    expect(last(y).t).toBe("done");
  });
});

// ─────────────────────────────────────────────────── questions & previews

describe("things that cost nothing", () => {
  it("answers a question without touching the world", async () => {
    await newSave();
    const before = await store.load("save_one");
    const a = await svc.ask("save_one", "who is here?");
    expect(a.understood).toBe(true);
    expect(a.lines.length).toBeGreaterThan(0);

    const after = await store.load("save_one");
    expect(stable(after)).toBe(stable(before));
    expect(await journalLength("save_one")).toBe(0);
  });

  it("routes a question typed as a turn to the answer frame, still costing nothing", async () => {
    await newSave();
    const frames = await turn("save_one", "what's around me?", 0);
    expect(last(frames).t).toBe("answer");
    expect(await journalLength("save_one")).toBe(0);
    // It is still part of the conversation, so the transcript keeps it.
    const feed = await store.readFeed("save_one");
    expect(feed.some((r) => r.kind === "answer")).toBe(true);
  });

  it("previews an action without rolling it", async () => {
    await newSave();
    const p = await svc.preview("save_one", { type: "skill_check", skill: "perception", band: "medium" });
    expect(p.legal).toBe(true);
    expect(p.odds).toBeGreaterThan(0);
    expect(await journalLength("save_one")).toBe(0);
  });

  it("says why an illegal action is illegal, in the resolver's own words", async () => {
    await newSave();
    const p = await svc.preview("save_one", { type: "attack", target_id: "npc_nobody" });
    expect(p.legal).toBe(false);
    expect(p.reason).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────── rewind

describe("rewind", () => {
  it("returns the world and the transcript to an earlier turn, archiving what it drops", async () => {
    await newSave();
    let v = (last(await turn("save_one", "look around", 0)) as { version: number }).version;
    const turnOne = (await store.load("save_one")).meta.turn;
    v = (last(await turn("save_one", "search the bar", v)) as { version: number }).version;

    const out = await svc.rewind("save_one", { to_turn: turnOne, expect_version: v });
    expect("error" in out).toBe(false);
    const snap = out as Awaited<ReturnType<GameService["snapshot"]>>;
    expect(snap.turn).toBe(turnOne);

    // The second turn is gone from the transcript too, and parked rather than deleted.
    expect(snap.recent.filter((r) => r.kind === "player").map((r) => r.text)).toEqual(["look around"]);
    expect((await store.listBranches("save_one")).length).toBe(1);
  });

  it("refuses a rewind aimed at a stale version", async () => {
    await newSave();
    const v = (last(await turn("save_one", "look around", 0)) as { version: number }).version;
    const out = await svc.rewind("save_one", { to_turn: 0, expect_version: v + 5 });
    expect("error" in out).toBe(true);
  });

  it("leaves a world that still replays byte-identically", async () => {
    await svc.createSave({
      campaign: "drowned_bell", save_id: "save_rw",
      session_zero: { dice: "committed" },
      character: {
        name: "Odd Character", pronouns: "they/them",
        race_id: "race_elf", class_id: "cls_bard", background_id: "bg_urchin",
        skills: ["performance", "stealth", "persuasion"],
        scores: { method: "standard", assignment: { cha: 15, dex: 14, con: 13, int: 12, wis: 10, str: 8 } },
      },
    });
    let v = 0;
    for (const line of ["look around", "search the bar", "listen"]) {
      v = (last(await turn("save_rw", line, v)) as { version: number }).version;
    }
    const mid = (await store.load("save_rw")).meta.turn;
    v = (last(await turn("save_rw", "search the bar", v)) as { version: number }).version;
    await svc.rewind("save_rw", { to_turn: mid, expect_version: v });

    // The gate, through the server's own path: content plus creation, replayed.
    const initial = await initialStateFor(store, CONTENT, "save_rw", "drowned_bell");
    const journal = await store.readJournal("save_rw");
    const replayed = reduceAll(initial, journal.filter((e) => e.derived_from === null));
    expect(stable(replayed.state)).toBe(stable(await store.load("save_rw")));
  });
});

// ─────────────────────────────────────────────────────── money and loops

describe("the ledgers", () => {
  it("records what every model call cost", async () => {
    await newSave();
    await turn("save_one", "look around", 0);
    const c = await svc.costs("save_one");
    expect(c.rows.length).toBeGreaterThan(0);
    expect(c.total_tokens).toBeGreaterThan(0);
  });

  it("stops calling the narrator past the ceiling, and keeps playing", async () => {
    const tiny = new GameService(store, new MockLLM({ seed: "b" }), { contentRoot: CONTENT, budget: { max_tokens_per_save: 1 } });
    await tiny.createSave({ campaign: "drowned_bell", save_id: "save_cap" });

    const frames: Frame[] = [];
    await tiny.turn("save_cap", { text: "look around", expect_version: 0 }, (f) => frames.push(f));
    const done = last(frames) as { t: "done"; mode: string; note: string | null; version: number };
    // First turn is free — nothing has been spent yet.
    expect(done.t).toBe("done");

    const second: Frame[] = [];
    await tiny.turn("save_cap", { text: "search the bar", expect_version: done.version }, (f) => second.push(f));
    const d2 = last(second) as { t: "done"; mode: string; note: string | null };
    // Over the ceiling: the dice still roll, the prose stops, and the player is told why.
    expect(d2.mode).toBe("mechanics_only");
    expect(d2.note).toMatch(/budget/i);
    expect(second.some((f) => f.t === "mechanics")).toBe(true);
    expect(await journalLength("save_cap")).toBeGreaterThan(0);
  });

  it("refuses a client stuck in a loop", async () => {
    const fast = new GameService(store, new MockLLM({ seed: "c" }), { contentRoot: CONTENT, budget: { max_turns_per_minute: 2 } });
    await fast.createSave({ campaign: "drowned_bell", save_id: "save_loop" });

    let v = 0;
    let sawError = false;
    for (let i = 0; i < 4; i++) {
      const frames: Frame[] = [];
      await fast.turn("save_loop", { text: "look around", expect_version: v }, (f) => frames.push(f));
      const l = last(frames);
      if (l.t === "error") { sawError = true; break; }
      if (l.t === "done") v = (l as { version: number }).version;
    }
    expect(sawError).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────── the rest

describe("reads for the client", () => {
  it("offers a catalogue a new-game screen can render", async () => {
    const cat = await svc.catalogue();
    expect(cat.campaigns.some((c) => c.id === "drowned_bell")).toBe(true);
    expect(cat.classes).toHaveLength(10);
    expect(cat.backgrounds.every((b) => b.blurb.length > 0)).toBe(true);
    expect(cat.races.length).toBeGreaterThan(0);
  });

  it("gives the history with its causal chains", async () => {
    await newSave();
    await turn("save_one", "look around", 0);
    const h = await svc.history("save_one");
    expect(h.rows.length).toBeGreaterThan(0);
    expect(h.rows[0]).toHaveProperty("children");
  });

  it("404s an unknown save rather than inventing one", async () => {
    await expect(svc.snapshot("save_ghost")).rejects.toThrow(ServiceError);
  });
});

/** Answers the intent call, then falls over exactly where a real provider would. */
class DeadNarrator implements LLMClient {
  readonly name = "dead";
  private readonly inner = new MockLLM({ seed: "dead" });
  async complete<T>(req: LLMRequest<T>): Promise<LLMResponse<T>> {
    if (req.role === "narrate" || req.role === "narrate_hi") {
      throw new LLMTransportError("503 from the provider", 503, true);
    }
    return this.inner.complete(req);
  }
}

async function journalLength(id: string): Promise<number> {
  return (await store.readJournal(id)).length;
}
