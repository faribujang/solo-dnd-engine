/**
 * PROSE, AS IT ARRIVES.
 *
 * The narrator answers with one JSON object whose first field is `narration`. Waiting for
 * the whole object before showing a word means the player stares at nothing for the length
 * of the slowest field, which is the prose itself. So we watch the raw text as the provider
 * streams it, find the `"narration"` string, and hand its characters on as they decode —
 * while the rest of the object (facts, proposals, chips) still arrives whole and is still
 * validated whole. One call, no extra cost, and the mechanics were on screen before any of
 * this started.
 *
 * This is a tap on a string literal inside a JSON document being written left to right. It
 * is not a JSON parser, and it does not need to be: strict structured output emits keys in
 * schema order, so the first `"narration"` we see is the key. If a provider ever violated
 * that, the failure is graceful — no deltas, and the final parse still governs what the
 * player ends up with.
 */
export class NarrationTap {
  private buf = "";
  private pos = 0;
  private state: "seek_key" | "seek_colon" | "seek_quote" | "in_string" | "done" = "seek_key";
  private pendingEscape = "";

  /** Feed the next chunk of raw provider text. Returns newly decoded narration, if any. */
  push(chunk: string): string {
    this.buf += chunk;
    let out = "";

    while (this.pos < this.buf.length) {
      if (this.state === "done") break;

      if (this.state === "seek_key") {
        const i = this.buf.indexOf('"narration"', this.pos);
        if (i === -1) { this.pos = Math.max(this.pos, this.buf.length - 11); break; }
        this.pos = i + '"narration"'.length;
        this.state = "seek_colon";
        continue;
      }

      const ch = this.buf[this.pos]!;

      if (this.state === "seek_colon") {
        this.pos++;
        if (ch === ":") this.state = "seek_quote";
        continue;
      }

      if (this.state === "seek_quote") {
        this.pos++;
        if (ch === '"') this.state = "in_string";
        continue;
      }

      // in_string
      if (this.pendingEscape) {
        this.pendingEscape += ch;
        this.pos++;
        const decoded = decodeEscape(this.pendingEscape);
        if (decoded === null) continue;           // still incomplete (\uXXXX)
        if (decoded === undefined) { this.pendingEscape = ""; continue; } // malformed; drop
        out += decoded;
        this.pendingEscape = "";
        continue;
      }
      if (ch === "\\") { this.pendingEscape = "\\"; this.pos++; continue; }
      if (ch === '"') { this.state = "done"; this.pos++; break; }
      out += ch;
      this.pos++;
    }
    return out;
  }

  get finished(): boolean { return this.state === "done"; }
}

/**
 * Decode one JSON escape sequence. Returns the character, `null` if more input is needed,
 * or `undefined` if the sequence is malformed and should be dropped.
 */
function decodeEscape(seq: string): string | null | undefined {
  if (seq.length < 2) return null;
  const c = seq[1]!;
  switch (c) {
    case '"': return '"';
    case "\\": return "\\";
    case "/": return "/";
    case "b": return "\b";
    case "f": return "\f";
    case "n": return "\n";
    case "r": return "\r";
    case "t": return "\t";
    case "u": {
      if (seq.length < 6) return null;
      const code = Number.parseInt(seq.slice(2, 6), 16);
      return Number.isNaN(code) ? undefined : String.fromCharCode(code);
    }
    default: return undefined;
  }
}

/**
 * Split provider SSE text into `data:` payloads. Providers differ in how they chunk; this
 * only depends on the one thing they agree on — events end at a blank line.
 */
export class SseLineReader {
  private carry = "";

  /** Feed raw bytes-as-text; get back the complete `data:` payloads found so far. */
  push(text: string): string[] {
    this.carry += text.replace(/\r\n/g, "\n");
    const out: string[] = [];
    let idx: number;
    while ((idx = this.carry.indexOf("\n\n")) !== -1) {
      const block = this.carry.slice(0, idx);
      this.carry = this.carry.slice(idx + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) out.push(data);
    }
    return out;
  }
}

/** Break finished text into word-ish chunks, for a mock that has to pretend to stream. */
export function chunkForStreaming(text: string, size = 3): string[] {
  const words = text.split(/(?<=\s)/);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(""));
  return out.filter((c) => c.length > 0);
}
