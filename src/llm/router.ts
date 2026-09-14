import { z } from "zod";
import { LLMTransportError, type LLMClient, type LLMRequest, type LLMResponse, type Role, type StreamHandlers } from "./client.js";

/**
 * Role-based model routing with a fallback chain.
 *
 * Cheap, deterministic work (intent parsing) and expensive, creative work (narration) want
 * different models, and free tiers fall over. One config file decides both, and it is read
 * at runtime so switching providers never means touching game code.
 */

export const RoleConfig = z.object({
  provider: z.string(),
  model: z.string(),
  max_tokens: z.number().int().positive().default(1000),
  temperature: z.number().min(0).max(2).default(0.7),
});
export type RoleConfig = z.infer<typeof RoleConfig>;

export const ModelConfig = z.object({
  roles: z.record(z.string(), RoleConfig),
  /**
   * What each provider should use when it is standing in for another one.
   *
   * A fallback provider has no role of its own, so it has no model — and a request with no
   * model is a 400, which turns a resilience feature into a second way to fail. Naming a
   * default here is what makes the chain actually worth having. Model ids differ between
   * providers for the same model, which is why this cannot be inferred.
   */
  providers: z.record(z.string(), z.object({
    model: z.string(),
    /**
     * Extra top-level fields for every request to this provider.
     *
     * Gateways have quirks, and a quirk belongs to the gateway rather than to a role: it
     * has to travel with the provider when a role falls through to it, and it must NOT
     * travel to a different provider that would reject the field. `reasoning` is the
     * live example — a thinking model spends its token budget deliberating and then
     * truncates the JSON it was asked for, which arrives as "did not return JSON".
     */
    extra_body: z.record(z.string(), z.unknown()).default({}),
  })).default({}),
  /** Providers to try, in order, when the role's own provider fails. */
  fallback_chain: z.array(z.string()).default([]),
  escalate_to_hi_when: z.object({
    importance_gte: z.number().int().default(4),
    scene_opening: z.boolean().default(true),
    combat_round: z.boolean().default(false),
  }).default({}),
  retry: z.object({
    attempts: z.number().int().min(1).default(3),
    base_delay_ms: z.number().int().nonnegative().default(400),
  }).default({}),
});
export type ModelConfig = z.infer<typeof ModelConfig>;

export interface RouterEvent {
  role: Role;
  provider: string;
  model: string;
  ms: number;
  ok: boolean;
  error?: string;
  attempt: number;
}

export class Router implements LLMClient {
  readonly name = "router";
  readonly log: RouterEvent[] = [];

  constructor(
    private readonly config: ModelConfig,
    private readonly providers: Map<string, LLMClient>,
  ) {}

  async complete<T>(req: LLMRequest<T>): Promise<LLMResponse<T>> {
    return this.run(req, (provider, r) => provider.complete(r));
  }

  /**
   * Streamed where the provider can, whole where it cannot. A provider without `stream`
   * still satisfies the caller: the prose is handed over once, at the end, and the caller
   * cannot tell the difference except by the clock.
   */
  async stream<T>(req: LLMRequest<T>, on: StreamHandlers): Promise<LLMResponse<T>> {
    // Whether the attempt currently running has already put words on someone's screen.
    // If it has and it then fails, the next attempt must not simply append to them.
    let emitted = false;
    const tap: StreamHandlers = {
      ...(on.onText ? { onText: (d: string) => { emitted = true; on.onText!(d); } } : {}),
      ...(on.onReset ? { onReset: on.onReset } : {}),
    };

    return this.run(
      req,
      async (provider, r) => {
        emitted = false;
        if (provider.stream) return provider.stream(r, tap);
        const res = await provider.complete(r);
        const text = (res.value as { narration?: unknown } | null)?.narration;
        if (typeof text === "string" && tap.onText) tap.onText(text);
        return res;
      },
      () => { if (emitted) { emitted = false; on.onReset?.(); } },
    );
  }

  private async run<T>(
    req: LLMRequest<T>,
    invoke: (provider: LLMClient, r: LLMRequest<T>) => Promise<LLMResponse<T>>,
    /** Called after a failed attempt, before the next one begins. */
    onAbandon?: () => void,
  ): Promise<LLMResponse<T>> {
    const roleCfg = this.config.roles[req.role];
    if (!roleCfg) throw new Error(`No model configured for role "${req.role}"`);

    // The role's own provider first, then whatever the chain offers that we have not tried.
    const order = [roleCfg.provider, ...this.config.fallback_chain.filter((p) => p !== roleCfg.provider)];
    const { attempts, base_delay_ms } = this.config.retry;

    let lastError: unknown;

    for (const providerName of order) {
      const provider = this.providers.get(providerName);
      if (!provider) continue;

      // Which model THIS provider should use. Its own if it owns the role, otherwise the
      // default it was given. A provider with neither is skipped rather than sent a request
      // it cannot serve — a 400 in the middle of a fallback chain is worse than no fallback.
      const model = providerName === roleCfg.provider
        ? roleCfg.model
        : this.config.providers[providerName]?.model;
      if (!model) continue;

      for (let attempt = 1; attempt <= attempts; attempt++) {
        const started = Date.now();
        try {
          const res = await invoke(provider, {
            ...req,
            maxTokens: req.maxTokens ?? roleCfg.max_tokens,
            temperature: req.temperature ?? roleCfg.temperature,
            model,
          });
          this.log.push({
            role: req.role, provider: providerName, model: res.model,
            ms: Date.now() - started, ok: true, attempt,
          });
          return res;
        } catch (err) {
          lastError = err;
          onAbandon?.();
          this.log.push({
            role: req.role, provider: providerName, model,
            ms: Date.now() - started, ok: false, attempt,
            error: err instanceof Error ? err.message : String(err),
          });

          const retryable = err instanceof LLMTransportError ? err.retryable : false;
          if (!retryable || attempt === attempts) break;   // move to the next provider
          await sleep(base_delay_ms * 2 ** (attempt - 1));
        }
      }
    }

    throw new LLMTransportError(
      `Every provider failed for role "${req.role}": ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      null,
      false,
    );
  }

  /** Whether this turn deserves the expensive narrator. */
  shouldEscalate(signals: { importance?: number; sceneOpening?: boolean; combatRound?: boolean }): boolean {
    const rule = this.config.escalate_to_hi_when;
    if (signals.combatRound && !rule.combat_round) return false;
    if (signals.sceneOpening && rule.scene_opening) return true;
    if ((signals.importance ?? 0) >= rule.importance_gte) return true;
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
