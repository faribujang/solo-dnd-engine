import { zodToJsonSchema } from "./jsonSchema.js";
import {
  estimateTokens, LLMSchemaError, LLMTransportError,
  type LLMClient, type LLMRequest, type LLMResponse,
} from "./client.js";

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
    const f = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 45_000);

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
        }),
      });
    } catch (err) {
      throw new LLMTransportError(
        `${this.name}: ${err instanceof Error ? err.message : String(err)}`,
        null,
        true,   // network faults and timeouts are worth another go
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // 429 and 5xx are worth retrying or falling through; 4xx means we asked wrongly.
      const retryable = res.status === 429 || res.status >= 500;
      throw new LLMTransportError(
        `${this.name} returned ${res.status}: ${body.slice(0, 300)}`,
        res.status,
        retryable,
      );
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const raw = json.choices?.[0]?.message?.content ?? "";

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
        input_tokens: json.usage?.prompt_tokens ?? estimateTokens(req.system + req.user),
        output_tokens: json.usage?.completion_tokens ?? estimateTokens(raw),
      },
      ms: Date.now() - started,
    };
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
