import type { z } from "zod";

/**
 * The LLM boundary. Everything above this line is deterministic; everything below is not.
 *
 * One interface, three implementations: MockLLM (deterministic, no network, used by the
 * whole test suite), and OpenAI-compatible adapters for Gemini and OpenRouter.
 */

export type Role = "intent" | "narrate" | "narrate_hi" | "companion" | "digest" | "ambient";

export interface LLMRequest<T> {
  role: Role;
  system: string;
  user: string;
  /**
   * Three type parameters, not one: our schemas carry defaults, so the shape that goes IN
   * (what the model returns, with fields possibly missing) is not the shape that comes OUT
   * (fully populated). Declaring only the output type would reject every schema with a
   * default on it.
   */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** Name for the structured-output schema; some providers require one. */
  schemaName: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMResponse<T> {
  value: T;
  /** What the provider actually returned, kept for rejects.jsonl when parsing fails. */
  raw: string;
  provider: string;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  /** Milliseconds of wall time, so the UI can show why a turn felt slow. */
  ms: number;
}

/**
 * Callbacks for a streamed call. `onText` receives the narrator's PROSE as it decodes —
 * specifically the value of the top-level `narration` field — so a client can show words
 * while the rest of the structured answer is still arriving. Every other field is delivered
 * whole, in the resolved response, and validated whole.
 */
export interface StreamHandlers {
  onText?: (delta: string) => void;
}

export interface LLMClient {
  readonly name: string;
  complete<T>(req: LLMRequest<T>): Promise<LLMResponse<T>>;
  /**
   * Same contract as `complete` — identical resolved value, identical validation — with
   * prose handed on as it arrives. Optional: a client that cannot stream is used through
   * `complete`, and the caller emits the prose once at the end instead.
   */
  stream?<T>(req: LLMRequest<T>, on: StreamHandlers): Promise<LLMResponse<T>>;
}

/** Thrown when a provider answers, but not with something matching the schema. */
export class LLMSchemaError extends Error {
  constructor(
    message: string,
    readonly raw: string,
    readonly issues: unknown,
  ) {
    super(message);
    this.name = "LLMSchemaError";
  }
}

/** Thrown when a provider is unreachable, rate-limited or erroring. */
export class LLMTransportError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LLMTransportError";
  }
}

/** Rough token estimate. Good enough for budgeting; never used for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
