import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LLMTransportError, type LLMClient, type LLMRequest, type LLMResponse, type StreamHandlers } from "../../src/llm/client.js";
import { ModelConfig, Router } from "../../src/llm/router.js";

/**
 * A RETRIED STREAM DOES NOT SAY IT TWICE.
 *
 * Streaming and retrying are both good ideas that spoil each other. An attempt can put a
 * paragraph on the reader's screen and then fail — a truncated JSON body is the common
 * way, and it is common precisely because a thinking model spends its token budget before
 * it starts writing. The router then tries again, or falls through to another provider,
 * and that attempt writes its own paragraph. Without a retraction the reader is shown
 * both, which reads as the DM narrating the scene twice with two different endings.
 *
 * Bytes cannot be un-sent, so the contract carries the withdrawal instead.
 */

const schema = z.object({ narration: z.string() });

function cfg(overrides: Partial<z.input<typeof ModelConfig>> = {}) {
  return ModelConfig.parse({
    roles: { narrate: { provider: "flaky", model: "m1" } },
    providers: { backup: { model: "m2" } },
    fallback_chain: ["backup"],
    retry: { attempts: 2, base_delay_ms: 0 },
    ...overrides,
  });
}

/** Emits `text`, then either resolves with it or throws after the fact. */
class Scripted implements LLMClient {
  constructor(readonly name: string, private readonly text: string, private readonly fail: boolean) {}

  async complete<T>(_req: LLMRequest<T>): Promise<LLMResponse<T>> {
    throw new Error("this test is about streaming");
  }

  async stream<T>(req: LLMRequest<T>, on: StreamHandlers): Promise<LLMResponse<T>> {
    // Half a paragraph reaches the reader BEFORE anything can go wrong. That ordering is
    // the whole problem; a client that failed before emitting would need no retraction.
    on.onText?.(this.text);
    if (this.fail) throw new LLMTransportError(`${this.name} truncated`, 500, true);
    const raw = JSON.stringify({ narration: this.text });
    return {
      value: req.schema.parse({ narration: this.text }),
      raw, provider: this.name, model: "m",
      usage: { input_tokens: 1, output_tokens: 1 }, ms: 1,
    };
  }
}

function collect() {
  let shown = "";
  const handlers: StreamHandlers = {
    onText: (d) => { shown += d; },
    onReset: () => { shown = ""; },
  };
  return { handlers, get text() { return shown; } };
}

describe("a retried stream", () => {
  it("retracts what it showed before falling through to another provider", async () => {
    const router = new Router(cfg(), new Map<string, LLMClient>([
      ["flaky", new Scripted("flaky", "The smith sets down the tongs and", true)],
      ["backup", new Scripted("backup", "Cotter does not look up.", false)],
    ]));

    const sink = collect();
    const res = await router.stream({ role: "narrate", system: "s", user: "u", schema, schemaName: "N" }, sink.handlers);

    expect(res.value.narration).toBe("Cotter does not look up.");
    // Not "…tongs andCotter does not look up." — the abandoned half is gone.
    expect(sink.text).toBe("Cotter does not look up.");
  });

  it("retracts between two attempts at the SAME provider", async () => {
    let n = 0;
    const flaky: LLMClient = {
      name: "flaky",
      complete: async () => { throw new Error("unused"); },
      stream: async (req, on) => {
        n++;
        const text = n === 1 ? "A false start." : "The true line.";
        on.onText?.(text);
        if (n === 1) throw new LLMTransportError("flaky truncated", 500, true);
        return {
          value: req.schema.parse({ narration: text }),
          raw: JSON.stringify({ narration: text }), provider: "flaky", model: "m1",
          usage: { input_tokens: 1, output_tokens: 1 }, ms: 1,
        };
      },
    };

    const router = new Router(cfg(), new Map<string, LLMClient>([["flaky", flaky]]));
    const sink = collect();
    const res = await router.stream({ role: "narrate", system: "s", user: "u", schema, schemaName: "N" }, sink.handlers);

    expect(n).toBe(2);
    expect(res.value.narration).toBe("The true line.");
    expect(sink.text).toBe("The true line.");
  });

  it("does not retract when the first attempt succeeds", async () => {
    const router = new Router(cfg(), new Map<string, LLMClient>([
      ["flaky", new Scripted("flaky", "One clean paragraph.", false)],
    ]));

    let resets = 0;
    let shown = "";
    await router.stream({ role: "narrate", system: "s", user: "u", schema, schemaName: "N" }, {
      onText: (d) => { shown += d; },
      onReset: () => { resets++; },
    });

    expect(resets).toBe(0);
    expect(shown).toBe("One clean paragraph.");
  });

  it("does not retract when an attempt fails before it has shown anything", async () => {
    const silent: LLMClient = {
      name: "flaky",
      complete: async () => { throw new Error("unused"); },
      // Fails at connect time. Nothing was displayed, so there is nothing to withdraw and
      // a spurious reset would clear prose that a previous frame legitimately wrote.
      stream: async () => { throw new LLMTransportError("refused the connection", null, true); },
    };

    const router = new Router(cfg(), new Map<string, LLMClient>([
      ["flaky", silent],
      ["backup", new Scripted("backup", "The fallback speaks.", false)],
    ]));

    let resets = 0;
    let shown = "";
    const res = await router.stream({ role: "narrate", system: "s", user: "u", schema, schemaName: "N" }, {
      onText: (d) => { shown += d; },
      onReset: () => { resets++; },
    });

    expect(resets).toBe(0);
    expect(shown).toBe("The fallback speaks.");
    expect(res.value.narration).toBe("The fallback speaks.");
  });
});

describe("provider quirks travel with the provider", () => {
  it("sends a provider's extra_body on every request to it, and to nobody else", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ narration: "ok" }) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const { OpenAICompatClient } = await import("../../src/llm/openaiCompat.js");
    const quirky = new OpenAICompatClient({
      name: "quirky", baseUrl: "https://example.invalid", apiKey: "k", model: "m",
      extraBody: { reasoning: { effort: "low" } }, fetchImpl,
    });
    const plain = new OpenAICompatClient({
      name: "plain", baseUrl: "https://example.invalid", apiKey: "k", model: "m", fetchImpl,
    });

    const req = { role: "narrate" as const, system: "s", user: "u", schema, schemaName: "N" };
    await quirky.complete(req);
    await plain.complete(req);

    expect(bodies[0]!["reasoning"]).toEqual({ effort: "low" });
    expect(bodies[1]!["reasoning"]).toBeUndefined();
  });
});
