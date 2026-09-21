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
  /** Extra top-level request fields this provider needs. See ModelConfig.providers. */
  extraBody?: Record<string, unknown>;
  /** Mark the system prompt as cacheable. Off unless the provider is known to accept it. */
  cacheSystem?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class OpenAICompatClient implements LLMClient {
  readonly name: string;

  constructor(private readonly opts: OpenAICompatOptions) {
    this.name = opts.name;
  }

  /** The model the most recent call actually used, for the cost ledger. */
  private lastModel = "";

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
    this.lastModel = req.model ?? this.opts.model;
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
          model: req.model ?? this.opts.model,
          temperature: req.temperature ?? 0.7,
          max_tokens: req.maxTokens ?? 1000,
          /**
           * The system prompt is the same ~2,200 tokens on every single turn, and it sits
           * at the FRONT of the request, which is exactly the shape a prefix cache wants.
           * Marking it lets a provider that supports caching charge a fraction for it and
           * skip re-reading it; providers that do not understand the block form get the
           * plain string instead, because a rejected request is worse than a full-price
           * one. See `cache_system` in config/models.json.
           */
          messages: [
            this.opts.cacheSystem
              ? {
                  role: "system",
                  content: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
                }
              : { role: "system", content: req.system },
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
          ...this.opts.extraBody,
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
      model: this.lastModel,
      usage: {
        input_tokens: usage?.prompt_tokens ?? estimateTokens(req.system + req.user),
        output_tokens: usage?.completion_tokens ?? estimateTokens(raw),
        // Of the input tokens, how many the provider served from its cache.
        cached_input_tokens: cachedTokensOf(usage),
      },
      ms: Date.now() - started,
    };
  }
}

/**
 * What came back about tokens.
 *
 * Providers disagree on where a cache hit is reported: OpenAI-compatible endpoints nest
 * it under `prompt_tokens_details`, while Anthropic-style ones put it at the top level.
 * Both are read, because a number we do not read is a saving we cannot prove.
 */
type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

export function cachedTokensOf(u: Usage | undefined): number {
  return u?.prompt_tokens_details?.cached_tokens ?? u?.cache_read_input_tokens ?? 0;
}

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
  defaults: Record<string, { model: string; extra_body?: Record<string, unknown>; cache_system?: boolean }> = {},
): Map<string, LLMClient> {
  const out = new Map<string, LLMClient>();
  const extraFor = (provider: string) => defaults[provider]?.extra_body ?? {};
  const cacheFor = (provider: string) => defaults[provider]?.cache_system === true;
  // A provider's own default first — it is the only thing that is right when this provider
  // is standing in for another. Then the first role that names it. Then nothing, and the
  // router will skip it rather than send a request with no model.
  const modelFor = (provider: string) =>
    defaults[provider]?.model
    ?? Object.values(models).find((r) => r.provider === provider)?.model
    ?? "";

  if (env["GEMINI_API_KEY"]) {
    out.set("gemini", new OpenAICompatClient({
      name: "gemini",
      baseUrl: env["GEMINI_BASE_URL"] ?? "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: env["GEMINI_API_KEY"],
      model: modelFor("gemini"),
      extraBody: extraFor("gemini"),
      cacheSystem: cacheFor("gemini"),
    }));
  }

  if (env["OPENROUTER_API_KEY"]) {
    out.set("openrouter", new OpenAICompatClient({
      name: "openrouter",
      baseUrl: env["OPENROUTER_BASE_URL"] ?? "https://openrouter.ai/api/v1",
      apiKey: env["OPENROUTER_API_KEY"],
      model: modelFor("openrouter"),
      extraBody: extraFor("openrouter"),
      cacheSystem: cacheFor("openrouter"),
      headers: { "x-title": "Solo D&D Engine" },
    }));
  }

  return out;
}
