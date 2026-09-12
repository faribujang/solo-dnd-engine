import { z } from "zod";
import { LLMTransportError, type LLMClient, type LLMRequest, type LLMResponse, type Role } from "./client.js";

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
    const roleCfg = this.config.roles[req.role];
    if (!roleCfg) throw new Error(`No model configured for role "${req.role}"`);

    // The role's own provider first, then whatever the chain offers that we have not tried.
    const order = [roleCfg.provider, ...this.config.fallback_chain.filter((p) => p !== roleCfg.provider)];
    const { attempts, base_delay_ms } = this.config.retry;

    let lastError: unknown;

    for (const providerName of order) {
      const provider = this.providers.get(providerName);
      if (!provider) continue;

      for (let attempt = 1; attempt <= attempts; attempt++) {
        const started = Date.now();
        try {
          const res = await provider.complete({
            ...req,
            maxTokens: req.maxTokens ?? roleCfg.max_tokens,
            temperature: req.temperature ?? roleCfg.temperature,
          });
          this.log.push({
            role: req.role, provider: providerName, model: res.model,
            ms: Date.now() - started, ok: true, attempt,
          });
          return res;
        } catch (err) {
          lastError = err;
          this.log.push({
            role: req.role, provider: providerName, model: roleCfg.model,
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
