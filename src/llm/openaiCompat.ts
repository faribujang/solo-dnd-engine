import { zodToJsonSchema } from "./jsonSchema.js";
import {
  estimateTokens, LLMSchemaError, LLMTransportError,
  type LLMClient, type LLMRequest, type LLMResponse, type StreamHandlers,
} from "./client.js";
import { NarrationTap, SseLineReader } from "./stream.js";

/**
 * One adapter for both real providers. Gemini and OpenRouter are close enough to the
 * OpenAI chat-completions shape that a single client covers them, which keeps the number
 * of things that can be subtly wrong down to one.
 *
 * Nothing above this file knows which provider answered.
 */

export interface OpenAICompatOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Some gateways want extra headers (OpenRouter asks for attribution). */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class OpenAICompatClient implements LLMClient {
  readonly name: string;

  constructor(private readonly opts: OpenAICompatOptions) {
    this.name = opts.name;
  }

  async complete<T>(req: LLMRequest<T>): Promise<LLMResponse<T>> {
    const started = Date.now();
    const { res, release } = await this.send(req, false);
    try {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const raw = json.choices?.[0]?.message?.content ?? "";
      return this.finish(req, raw, json.usage, started);
    } finally {
      release();
    }
  }

  /**
   * The same call with `stream: true`. Chunks arrive as server-sent events carrying pieces
   * of the JSON text; we accumulate them into the same raw string `complete` would have got,
   * and run a tap over the `narration` field so the prose reaches the caller as it decodes.
   * Validation happens once, on the whole, exactly as before.
   */
  async stream<T>(req: LLMRequest<T>, on: StreamHandlers): Promise<LLMResponse<T>> {
    const started = Date.now();
    const { res, release } = await this.send(req, true);
    try {
      if (!res.body) {
        // A gateway that ignored `stream: true` and answered whole. Fine — same result.
        const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: Usage };
        const raw = json.choices?.[0]?.message?.content ?? "";
        const text = narrationOf(raw);
        if (text && on.onText) on.onText(text);
        return this.finish(req, raw, json.usage, started);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const lines = new SseLineReader();
      const tap = new NarrationTap();
      let raw = "";
      let usage: Usage | undefined;

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const data of lines.push(decoder.decode(value, { stream: true }))) {
          if (data === "[DONE]") continue;
          let evt: { choices?: Array<{ delta?: { content?: string } }>; usage?: Usage };
          try { evt = JSON.parse(data); } catch { continue; }
          const delta = evt.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            raw += delta;
            const text = tap.push(delta);
            if (text && on.onText) on.onText(text);
          }
          if (evt.usage) usage = evt.usage;
        }
      }
      return this.finish(req, raw, usage, started);
    } finally {
      release();
    }
  }

  /** One fetch for both paths. The caller must `release()` to clear the timeout. */
  private async send<T>(req: LLMRequest<T>, stream: boolean): Promise<{ res: Response; release: () => void }> {
    const f = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    // The timer covers the whole exchange, including a long streamed body.
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 45_000);
    const release = () => clearTimeout(timer);

    let res: Response;
    try {
      res = await f(`${this.opts.baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.apiKey}`,
          ...this.opts.headers,
        },
        body: JSON.stringify({
          model: this.opts.model,
          temperature: req.temperature ?? 0.7,
          max_tokens: req.maxTokens ?? 1000,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: req.schemaName,
              strict: true,
              schema: zodToJsonSchema(req.schema),
            },
          },
          ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
        }),
      });
    } catch (err) {
      release();
      throw new LLMTransportError(
        `${this.name}: ${err instanceof Error ? err.message : String(err)}`,
        null,
        true,   // network faults and timeouts are worth another go
      );
    }

    if (!res.ok) {
      release();
      const body = await res.text().catch(() => "");
      // 429 and 5xx are worth retrying or falling through; 4xx means we asked wrongly.
      const retryable = res.status === 429 || res.status >= 500;
      throw new LLMTransportError(
        `${this.name} returned ${res.status}: ${body.slice(0, 300)}`,
        res.status,
        retryable,
      );
    }

    return { res, release };
  }

  private finish<T>(req: LLMRequest<T>, raw: string, usage: Usage | undefined, started: number): LLMResponse<T> {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new LLMSchemaError(`${this.name} did not return JSON`, raw, null);
    }

    const parsed = req.schema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new LLMSchemaError(`${this.name} returned JSON that does not match the schema`, raw, parsed.error.issues);
    }

    return {
      value: parsed.data,
      raw,
      provider: this.name,
      model: this.opts.model,
      usage: {
        input_tokens: usage?.prompt_tokens ?? estimateTokens(req.system + req.user),
        output_tokens: usage?.completion_tokens ?? estimateTokens(raw),
      },
      ms: Date.now() - started,
    };
  }
}

type Usage = { prompt_tokens?: number; completion_tokens?: number };

/** The `narration` field of a finished JSON object, for the non-streaming fallback. */
function narrationOf(raw: string): string {
  try {
    const v = JSON.parse(raw) as { narration?: unknown };
    return typeof v.narration === "string" ? v.narration : "";
  } catch {
    return "";
  }
}

/**
 * Build the providers named in config/models.json from the environment.
 *
 * Model IDs are deliberately NOT hardcoded anywhere in this repo — free tiers and model
 * names both move faster than code. They come from config.
 */
export function providersFromEnv(
  models: Record<string, { provider: string; model: string }>,
  env: NodeJS.ProcessEnv = process.env,
): Map<string, LLMClient> {
  const out = new Map<string, LLMClient>();
  const modelFor = (provider: string) =>
    Object.values(models).find((r) => r.provider === provider)?.model ?? "";

  if (env["GEMINI_API_KEY"]) {
    out.set("gemini", new OpenAICompatClient({
      name: "gemini",
      baseUrl: env["GEMINI_BASE_URL"] ?? "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: env["GEMINI_API_KEY"],
      model: modelFor("gemini"),
    }));
  }

  if (env["OPENROUTER_API_KEY"]) {
    out.set("openrouter", new OpenAICompatClient({
      name: "openrouter",
      baseUrl: env["OPENROUTER_BASE_URL"] ?? "https://openrouter.ai/api/v1",
      apiKey: env["OPENROUTER_API_KEY"],
      model: modelFor("openrouter"),
      headers: { "x-title": "Solo D&D Engine" },
    }));
  }

  return out;
}
