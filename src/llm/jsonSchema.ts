import type { z } from "zod";
import { zodToJsonSchema as convert } from "zod-to-json-schema";

/**
 * Zod → JSON Schema for provider structured-output modes.
 *
 * This is the third job the schema files do: they already generate the TypeScript types and
 * validate at runtime, and here they become the contract the model is held to. One
 * definition, three uses — which is the reason the LLM can never return a shape the engine
 * has not agreed to.
 *
 * Providers running "strict" structured output are fussier than plain JSON Schema: every
 * object must forbid extra properties and list every key as required (optionality is
 * expressed by allowing null instead). We convert, then walk the result to satisfy that.
 */
export function zodToJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const raw = convert(schema, {
    $refStrategy: "none",     // strict mode does not follow $ref
    target: "jsonSchema7",
  }) as Record<string, unknown>;

  delete raw["$schema"];
  return strictify(raw) as Record<string, unknown>;
}

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!node || typeof node !== "object") return node;

  const obj = { ...(node as Record<string, unknown>) };

  for (const key of Object.keys(obj)) {
    obj[key] = strictify(obj[key]);
  }

  if (obj["type"] === "object" && obj["properties"] && typeof obj["properties"] === "object") {
    obj["additionalProperties"] = false;
    // Strict mode requires every property to be listed as required. A field that was
    // optional in Zod is still satisfied, because our schemas give those a nullable
    // default — the model returns null and Zod fills the default back in.
    obj["required"] = Object.keys(obj["properties"] as Record<string, unknown>);
  }

  return obj;
}
