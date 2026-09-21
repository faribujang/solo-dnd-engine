import { describe, expect, it } from "vitest";
import { NarrationTap, SseLineReader, chunkForStreaming } from "../../src/llm/stream.js";
import { MockLLM } from "../../src/llm/mock.js";
import { Narration } from "../../src/llm/contracts.js";
import { OpenAICompatClient } from "../../src/llm/openaiCompat.js";

/** Feed a string to the tap in pieces of the given sizes, collecting what comes out. */
function tapAll(text: string, sizes: number[]): string {
  const tap = new NarrationTap();
  let out = "";
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const n = sizes[k % sizes.length]!;
    out += tap.push(text.slice(i, i + n));
    i += n;
    k++;
  }
  return out;
}

describe("the narration tap", () => {
  const doc = JSON.stringify({
    narration: "The door gives.\n\"Who's there?\" says a voice — then nothing. Ünïcode ok.",
    facts: [{ text: "not narration" }],
    suggested_actions: ["narration is a word here too"],
  });

  it("recovers the narration exactly, however the text is chunked", () => {
    const want = JSON.parse(doc).narration as string;
    for (const sizes of [[1], [2, 3], [7], [50], [1, 1, 40], [1000]]) {
      expect(tapAll(doc, sizes)).toBe(want);
    }
  });

  it("handles an escape split across chunks", () => {
    const text = JSON.stringify({ narration: "a\nb\"c\\dé" });
    // Cut right after every backslash the encoder produced.
    const parts: string[] = [];
    let buf = "";
    for (const ch of text) { buf += ch; if (ch === "\\") { parts.push(buf); buf = ""; } }
    parts.push(buf);
    const tap = new NarrationTap();
    let out = "";
    for (const p of parts) out += tap.push(p);
    expect(out).toBe("a\nb\"c\\dé");
    expect(tap.finished).toBe(true);
  });

  it("emits nothing before the key, and nothing after the string closes", () => {
    const tap = new NarrationTap();
    expect(tap.push('{"facts":[],"narr')).toBe("");
    expect(tap.push('ation":"Hi')).toBe("Hi");
    expect(tap.push('","x":"narration"}')).toBe("");
    expect(tap.finished).toBe(true);
  });
});

describe("the SSE line reader", () => {
  it("yields data payloads across arbitrary chunk boundaries", () => {
    const r = new SseLineReader();
    const got: string[] = [];
    got.push(...r.push("data: {\"a\":1}\n\nda"));
    got.push(...r.push("ta: {\"b\":2}\r\n\r\ndata: [DONE]\n\n"));
    expect(got).toEqual(['{"a":1}', '{"b":2}', "[DONE]"]);
  });

  it("joins multi-line data fields as the spec says", () => {
    const r = new SseLineReader();
    expect(r.push("data: one\ndata: two\n\n")).toEqual(["one\ntwo"]);
  });
});

describe("the mock streams the same value it completes", () => {
  it("hands out the prose in pieces and resolves to an identical result", async () => {
    const req = { role: "narrate" as const, system: "s", user: "## SCENE\nThe Rusty Flagon — dusk\n## THIS TURN'S RESOLVED MECHANICS\nsuccess", schema: Narration, schemaName: "Narration" };
    const a = await new MockLLM({ seed: "x" }).complete(req);
    let streamed = "";
    const b = await new MockLLM({ seed: "x" }).stream(req, { onText: (d) => { streamed += d; } });
    expect(b.value).toEqual(a.value);
    expect(streamed).toBe(a.value.narration);
    expect(chunkForStreaming(a.value.narration).length).toBeGreaterThan(1);
  });
});

describe("the OpenAI-compatible adapter, streaming", () => {
  it("assembles a streamed JSON answer and taps the prose as it arrives", async () => {
    const payload = { narration: "The bell is silent. Then it is not.", facts: [], attitude_deltas: [], opinion_updates: [], proposals: [], suggested_actions: ["Listen"], scene_change: null };
    const full = JSON.stringify(payload);
    // Slice the JSON into deltas the way a provider would, and wrap each as an SSE event.
    const deltas = full.match(/.{1,5}/g)!;
    const sse = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`).join("")
      + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`;

    const fetchImpl = (async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const client = new OpenAICompatClient({ name: "t", baseUrl: "http://x", apiKey: "k", model: "m", fetchImpl });

    let prose = "";
    const res = await client.stream(
      { role: "narrate", system: "s", user: "u", schema: Narration, schemaName: "Narration" },
      { onText: (d) => { prose += d; } },
    );
    expect(res.value.narration).toBe(payload.narration);
    expect(prose).toBe(payload.narration);
    expect(res.usage).toMatchObject({ input_tokens: 11, output_tokens: 7 });
    expect(res.value.suggested_actions).toEqual(["Listen"]);
  });

  it("still validates the whole, so a malformed stream is refused not half-applied", async () => {
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: '{"narration": "hi", "facts": "not-an-array"}' } }] })}\n\ndata: [DONE]\n\n`;
    const fetchImpl = (async () => new Response(sse, { status: 200 })) as unknown as typeof fetch;
    const client = new OpenAICompatClient({ name: "t", baseUrl: "http://x", apiKey: "k", model: "m", fetchImpl });
    await expect(client.stream(
      { role: "narrate", system: "s", user: "u", schema: Narration, schemaName: "Narration" }, {},
    )).rejects.toThrow(/does not match/);
  });
});
