import type { z } from "zod";
import { Rng, seedToState } from "../rules/rng.js";
import { estimateTokens, type LLMClient, type LLMRequest, type LLMResponse, type StreamHandlers } from "./client.js";
import { chunkForStreaming } from "./stream.js";
import { Intent, Narration, SceneDigest, AmbientBeat } from "./contracts.js";
import { classify } from "../engine/questions.js";

/**
 * A deterministic stand-in for a real model.
 *
 * This exists so the entire turn loop — intent, context, narration, validation, commit —
 * can be exercised, tested and demoed with no API key, no network and no cost, and so the
 * test suite stays reproducible. It is not trying to write well; it is trying to be
 * *structurally* honest about what a real model returns, including the ways it misbehaves.
 *
 * `mischief` makes it occasionally propose things the narrator is not allowed to do. That
 * is deliberate: the phase-1 gate asks for rejects.jsonl to be reviewed and understood, and
 * a validator that has never rejected anything has not been tested.
 */
export interface MockOptions {
  seed?: string;
  /** 0..1 — how often to emit a proposal the validator should refuse. */
  mischief?: number;
  /** Simulated latency, in ms. Zero in tests. */
  latencyMs?: number;
}

export class MockLLM implements LLMClient {
  readonly name = "mock";
  private rng: Rng;
  private readonly mischief: number;
  private readonly latencyMs: number;
  /** Every call made, for assertions and for the debug view. */
  readonly calls: Array<{ role: string; system: string; user: string }> = [];

  constructor(opts: MockOptions = {}) {
    this.rng = new Rng(seedToState(opts.seed ?? "mock-dm"));
    this.mischief = opts.mischief ?? 0;
    this.latencyMs = opts.latencyMs ?? 0;
  }

  async complete<T>(req: LLMRequest<T>): Promise<LLMResponse<T>> {
    this.calls.push({ role: req.role, system: req.system, user: req.user });
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));

    const value =
      req.role === "intent" ? this.intent(req.user)
      : req.role === "digest" ? this.digest(req.user)
      : req.role === "ambient" ? this.ambient(req.user)
      : this.narrate(req.user);

    const raw = JSON.stringify(value);
    const parsed = req.schema.parse(value);

    return {
      value: parsed,
      raw,
      provider: "mock",
      model: "mock-1",
      usage: { input_tokens: estimateTokens(req.system + req.user), output_tokens: estimateTokens(raw) },
      ms: this.latencyMs,
    };
  }

  /**
   * Pretend to stream. The value is computed exactly as `complete` computes it — same
   * generator draws, same result — and the prose is then handed out in word-sized pieces.
   * That equivalence is what lets the streaming turn path share the replay tests with the
   * non-streaming one.
   */
  async stream<T>(req: LLMRequest<T>, on: StreamHandlers): Promise<LLMResponse<T>> {
    const res = await this.complete(req);
    const text = (res.value as { narration?: unknown } | null)?.narration;
    if (typeof text === "string" && on.onText) {
      for (const piece of chunkForStreaming(text)) {
        on.onText(piece);
        if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, Math.min(30, this.latencyMs)));
      }
    }
    return res;
  }

  // ---------------------------------------------------------------- intent

  /**
   * Keyword intent parsing. Crude, but it doubles as the real system's fallback when the
   * provider is down — a player should get a playable turn, not a stack trace.
   */
  private intent(user: string): z.infer<typeof Intent> {
    const text = (user.split("PLAYER SAID:")[1] ?? user).toLowerCase().trim();
    const base = { rationale: "mock keyword parse", confidence: 0.9 };
    const after = (...words: string[]): string | null => {
      for (const w of words) {
        const m = new RegExp(`${w}\\s+(?:the\\s+|a\\s+|to\\s+|at\\s+|with\\s+)?([a-z' ]+)`).exec(text);
        // Stop at a preposition — "talk to thorne about the bell" names Thorne, and the
        // rest is the topic. A real model does this naturally; the mock has to be told.
        if (m?.[1]) return m[1].split(/\s+(?:about|regarding|concerning|for|and)\s+/)[0]!.trim();
      }
      return null;
    };

    // Questions first: mistaking one for an action spends a turn the player did not mean
    // to spend, which is worse than failing to understand it.
    const q = classify(text);
    if (q) return Intent.parse({ action: "ask", question: q.kind, target_name: q.subject ?? null, ...base });

    if (/\b(end (my )?turn|done|pass|that's all)\b/.test(text)) return Intent.parse({ action: "end_turn", ...base });
    if (/\bdash\b/.test(text)) return Intent.parse({ action: "dash", ...base });
    if (/\bdisengage\b/.test(text)) return Intent.parse({ action: "disengage", ...base });
    if (/\bdodge\b/.test(text)) return Intent.parse({ action: "dodge", ...base });
    if (/\b(flee|run away|retreat|escape the fight)\b/.test(text)) return Intent.parse({ action: "flee", ...base });
    if (/^(look|examine|survey|describe)\b/.test(text)) {
      return Intent.parse({ action: "look", ...base });
    }
    if (/^(i|inv|inventory|what am i carrying)\b/.test(text)) {
      return Intent.parse({ action: "inventory", ...base });
    }
    const bareDir = /\b(north|south|east|west|up|down|in|out|back)\b/.exec(text)?.[1] ?? null;
    // A direction plus almost any verb of motion or attempt: "try the path down again".
    if (bareDir && /\b(go|walk|head|move|travel|climb|enter|leave|exit|try|back|path|again|toward|towards)\b/.test(text)) {
      return Intent.parse({ action: "move", direction: bareDir, ...base });
    }
    if (/\b(go|walk|head|move|travel|climb|enter|leave|exit)\b/.test(text)) {
      return Intent.parse({ action: "move", direction: bareDir, ...base, confidence: 0.4 });
    }
    if (/\b(attack|strike|stab|hit|swing|kill|fight)\b/.test(text)) {
      return Intent.parse({ action: "attack", target_name: after("attack", "stab", "hit", "kill", "strike"), ...base });
    }
    if (/\b(sneak|hide|creep|slip past)\b/.test(text)) {
      return Intent.parse({ action: "skill_check", skill: "stealth", difficulty_band: "medium", tag: "sneak", ...base });
    }
    if (/\b(search|look for|rummage|investigate|examine closely)\b/.test(text)) {
      return Intent.parse({ action: "skill_check", skill: "investigation", difficulty_band: "medium", tag: "search", ...base });
    }
    if (/\b(listen|watch|notice|spot|perceive)\b/.test(text)) {
      return Intent.parse({ action: "skill_check", skill: "perception", difficulty_band: "easy", tag: "listen", ...base });
    }
    if (/\b(persuade|convince|ask|beg|plead)\b/.test(text)) {
      return Intent.parse({
        action: "skill_check", skill: "persuasion", difficulty_band: "medium",
        target_name: after("persuade", "convince", "ask"), dialogue_intent: "persuade", ...base,
      });
    }
    if (/\b(lie|deceive|bluff)\b/.test(text)) {
      return Intent.parse({ action: "skill_check", skill: "deception", difficulty_band: "medium", dialogue_intent: "deceive", ...base });
    }
    if (/\b(threaten|intimidate|menace)\b/.test(text)) {
      return Intent.parse({ action: "skill_check", skill: "intimidation", difficulty_band: "medium", dialogue_intent: "intimidate", ...base });
    }
    if (/\b(talk|speak|greet|say|tell|chat)\b/.test(text)) {
      return Intent.parse({
        action: "talk", target_name: after("talk", "speak", "greet", "tell"),
        dialogue_intent: "inquire", topic: text.split(/\babout\b/)[1]?.trim() ?? null, ...base,
      });
    }
    if (/\b(cast|conjure|invoke)\b/.test(text)) {
      return Intent.parse({ action: "cast", target_name: after("at", "on"), ...base });
    }
    if (/\b(buy|sell|trade|barter|haggle)\b/.test(text)) {
      return Intent.parse({ action: "trade", target_name: after("with", "from"), ...base });
    }
    if (/\b(drink|quaff|use|apply)\b/.test(text)) {
      return Intent.parse({ action: "use_item", item_name: after("drink", "quaff", "use", "apply"), ...base });
    }
    if (/\b(take|grab|pick up|pocket|steal)\b/.test(text)) {
      return Intent.parse({ action: "take", item_name: after("take", "grab", "pick up", "pocket", "steal"), ...base });
    }
    if (/\b(rest|sleep|camp|catch my breath)\b/.test(text)) {
      return Intent.parse({ action: "rest", rest_kind: /long|sleep|night/.test(text) ? "long" : "short", ...base });
    }
    if (/\b(wait|linger|pause)\b/.test(text)) {
      const n = /\d+/.exec(text)?.[0];
      return Intent.parse({ action: "wait", minutes: n ? Number(n) : 10, ...base });
    }

    return Intent.parse({ action: "unclear", rationale: "no keyword matched", confidence: 0.2 });
  }

  // ------------------------------------------------------------- narration

  private narrate(user: string): z.infer<typeof Narration> {
    const scene = section(user, "SCENE");
    const mech = section(user, "THIS TURN'S RESOLVED MECHANICS");
    const locName = scene.split("\n")[0]?.split("—")[0]?.trim() ?? "the room";
    const npcNames = namesFrom(section(user, "PRESENT"));

    const failed = /FAIL|miss|REFUSED/i.test(mech);
    const crit = /CRITICAL/i.test(mech);
    const killed = /killed|dies|drops/i.test(mech);

    const opener = this.rng.pick(
      failed
        ? ["It does not go the way you intended.", "The moment turns against you.", "You come up short."]
        : crit
          ? ["It could not have gone better.", "Everything lands at once."]
          : ["It goes as you hoped.", "The moment turns your way.", "You manage it."],
    );

    const body = this.rng.pick([
      `${locName} does not change for you either way; the water and the dark go on as they were.`,
      `Somewhere past the near wall of ${locName}, something settles, and then is quiet.`,
      `The air in ${locName} is colder than it was a moment ago, or you have only just noticed.`,
    ]);

    const withNpc = npcNames.length
      ? this.rng.pick([
          `${npcNames[0]} watches you and says nothing, which is its own kind of answer.`,
          `${npcNames[0]} shifts their weight and does not look directly at you.`,
          `${npcNames[0]} makes a small sound that could be agreement or could be a warning.`,
        ])
      : "";

    const narration = [opener, body, withNpc].filter(Boolean).join("\n\n");

    const out: z.infer<typeof Narration> = {
      narration,
      facts: [],
      attitude_deltas: [],
      opinion_updates: [],
      proposals: [],
      suggested_actions: [],
      scene_change: null,
      // The mock never promises anything on the player's behalf.
      new_thread: null,
      settled_thread: null,
    };

    // Occasionally establish something — the real narrator does this constantly.
    if (this.rng.chance(0.35)) {
      out.facts.push({
        text: `${locName} carries a smell of cold iron that does not belong to the river.`,
        kind: "world",
        subjects: [],
        importance: 2,
        secret: false,
      });
    }

    if (npcNames.length && this.rng.chance(0.4)) {
      out.attitude_deltas.push({
        subject: npcNames[0]!,
        object: "you",
        dims: { affinity: failed ? -2 : 3 },
        reason: failed ? "watched you fumble it" : "watched you handle it",
      });
    }

    if (killed && npcNames.length) {
      out.attitude_deltas.push({
        subject: npcNames[0]!, object: "you", dims: { fear: 6 }, reason: "saw what you are capable of",
      });
    }

    // A real model reads the SUGGEST THESE block and rephrases it. The mock does the same,
    // minimally — which keeps the demo honest about where suggestions come from.
    const shortlist = section(user, "SUGGEST THESE")
      .split("\n")
      .map((l) => l.replace(/^-\s*/, "").replace(/\s*\([^)]*\)\s*$/, "").trim())
      .filter(Boolean);
    out.suggested_actions = shortlist.length
      ? shortlist.map((l) => phrase(l))
      : ["Look around", "Wait and listen"];

    // --- deliberate misbehaviour, so the validator is genuinely exercised ---
    //
    // Note what is NOT here: reaching for `damage` or `set_quest_status`. Under strict
    // structured output those are unreachable — the schema forbids the discriminator, so
    // the provider cannot return them at all. validate.ts still refuses them as
    // defence-in-depth (a degraded provider, or a fallback returning loose JSON), and
    // tests/llm/validate.test.ts covers that path directly.
    //
    // These are the misbehaviours a well-formed response CAN still carry: right shape,
    // wrong content.
    if (this.rng.chance(this.mischief)) {
      switch (this.rng.int(0, 4)) {
        case 0:
          // Taking the player for a walk. Shape is legal; moving the PC never is.
          out.proposals.push({ t: "move_entity", entity_id: "pc_main", location_id: "loc_flagon" });
          break;
        case 1:
          // Naming a place that does not exist.
          out.proposals.push({ t: "reveal_location", location_id: "loc_the_moon" });
          break;
        case 2:
          // Swinging a relationship far past what one turn should allow.
          out.attitude_deltas.push({
            subject: npcNames[0] ?? "Thorne Blackwater", object: "you",
            dims: { trust: 85 }, reason: "instant lifelong devotion",
          });
          break;
        case 3:
          // Pushing the clock further than a single narrated beat should.
          out.proposals.push({ t: "advance_time", minutes: 900 });
          break;
        default:
          // Attaching a lead to a quest nobody wrote.
          out.proposals.push({ t: "add_lead", quest_id: "q_invented", text: "A rumour of nothing.", points_to_location_id: null });
      }
    }

    return out;
  }

  private digest(user: string): z.infer<typeof SceneDigest> {
    const turns = section(user, "RECENT TURNS").split("\n").filter(Boolean);
    return SceneDigest.parse({
      digest: `A stretch of ${turns.length} turns passed in much the same key: attention, small risks, and nothing yet resolved.`,
      title: "A quiet stretch",
    });
  }

  private ambient(user: string): z.infer<typeof AmbientBeat> {
    const what = section(user, "WHAT HAPPENED") || "Something shifts nearby.";
    return AmbientBeat.parse({
      line: this.rng.pick([
        `You catch the edge of it: ${lower(what)}`,
        `Word reaches you, secondhand and half-complete: ${lower(what)}`,
        `Somewhere out of sight, ${lower(what)}`,
      ]),
    });
  }
}

// --------------------------------------------------------------- utilities

function section(prompt: string, title: string): string {
  const re = new RegExp(`## ${escape(title)}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`);
  return re.exec(prompt)?.[1]?.trim() ?? "";
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pull the leading name from each NPC block. */
function namesFrom(block: string): string[] {
  return block
    .split("\n")
    .filter((l) => l.length > 0 && !l.startsWith("  "))
    .map((l) => l.split("—")[0]!.trim())
    .filter((n) => n !== "" && n !== "Nobody else is here.");
}

/** Turn an engine label into something a person would say. */
function phrase(label: string): string {
  return label
    .replace(/^Talk to /, "Ask ")
    .replace(/^Persuasion /, "Try to talk ")
    .replace(/^Intimidation /, "Lean on ")
    .replace(/^Deception /, "Lie to ")
    .replace(/^Go (\w+) — .*/, "Head $1")
    .replace(/^Search here$/, "Search the place")
    .replace(/^Listen and watch$/, "Stop and listen");
}

function lower(s: string): string {
  const line = s.split("\n")[0] ?? s;
  return line.charAt(0).toLowerCase() + line.slice(1);
}
