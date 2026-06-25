import Ajv, { type ValidateFunction } from "ajv";
import { stableStringify } from "./journal.js";
import type { JsonSchema } from "./types.js";

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
const validatorCache = new Map<string, ValidateFunction>();

function compile(schema: JsonSchema): ValidateFunction {
  const key = stableStringify(schema);
  let v = validatorCache.get(key);
  if (!v) {
    v = ajv.compile(schema);
    validatorCache.set(key, v);
  }
  return v;
}

/** Format ajv errors into a compact, human/LLM-readable list. */
function formatErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((e) => `- ${e.instancePath || "(root)"} ${e.message ?? "invalid"}`)
    .join("\n");
}

/**
 * Validate an already-parsed candidate against a schema. The single ajv entry
 * point reused by both the prompt-parse path and the host-native path, so a
 * native host's output is never trusted blindly — it is always re-validated.
 */
export function validateAgainst(
  schema: JsonSchema,
  candidate: unknown,
): { ok: true; value: unknown } | { ok: false; errors: string } {
  const validate = compile(schema);
  if (validate(candidate)) return { ok: true, value: candidate };
  return { ok: false, errors: formatErrors(validate) };
}

/** Build the instruction appended to a prompt when a JSON schema is requested. */
export function buildSchemaEnvelope(basePrompt: string, schema: JsonSchema): string {
  return `${basePrompt}

---
You MUST respond with a single JSON value that strictly conforms to this JSON Schema:
<json-schema>
${JSON.stringify(schema, null, 2)}
</json-schema>
Respond with ONLY the JSON, inside one \`\`\`json fenced code block. No prose, no explanation, before or after.`;
}

function buildRetryPrompt(errors: string, previous: string): string {
  const prev = previous.length > 4000 ? `${previous.slice(0, 4000)}…(truncated)` : previous;
  return `Your previous response did not satisfy the JSON Schema.

Validation errors:
${errors}

Your previous output was:
${prev}

Re-output ONLY the corrected JSON in a single \`\`\`json fenced code block, conforming exactly to the schema. Do not include any prose.`;
}

/**
 * Extract a JSON value from free-form model text.
 * Order: fenced ```json block → first balanced {...}/[...] → whole-string parse.
 */
export function extractJson(text: string): unknown | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates: string[] = [];
  if (fenced && fenced[1]) candidates.push(fenced[1].trim());
  const balanced = firstBalanced(text);
  if (balanced) candidates.push(balanced);
  candidates.push(text.trim());

  for (const c of candidates) {
    const parsed = tryParse(c);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    // Tolerant retry: strip trailing commas before } or ].
    try {
      return JSON.parse(s.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      return undefined;
    }
  }
}

/** Find the first balanced {...} or [...] region, respecting string literals. */
function firstBalanced(text: string): string | undefined {
  const startBrace = text.indexOf("{");
  const startBracket = text.indexOf("[");
  let start = -1;
  let open = "{";
  let close = "}";
  if (startBrace >= 0 && (startBracket < 0 || startBrace < startBracket)) {
    start = startBrace;
  } else if (startBracket >= 0) {
    start = startBracket;
    open = "[";
    close = "]";
  }
  if (start < 0) return undefined;

  let depth = 0;
  let inStr = false;
  let quote = "";
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

export interface StructuredResult {
  value: unknown | null;
  attempts: number;
}

/**
 * Drive a schema-constrained generation with validate-and-retry.
 *
 * `run(prompt, attempt)` performs one model turn (the caller reuses one
 * sub-session across attempts so the model sees its prior output). Returns the
 * validated value, or null after exhausting retries / on a dead turn.
 */
export async function runStructured(params: {
  basePrompt: string;
  schema: JsonSchema;
  retries: number;
  run: (prompt: string, attempt: number) => Promise<string | null>;
  onRetry?: (attempt: number, reason: string) => void;
}): Promise<StructuredResult> {
  const { basePrompt, schema, retries, run, onRetry } = params;

  let prompt = buildSchemaEnvelope(basePrompt, schema);
  const maxAttempts = retries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const text = await run(prompt, attempt);
    if (text == null) return { value: null, attempts: attempt };

    const parsed = extractJson(text);
    if (parsed === undefined) {
      const reason = "no parseable JSON found in response";
      if (attempt < maxAttempts) {
        onRetry?.(attempt, reason);
        prompt = buildRetryPrompt(reason, text);
        continue;
      }
      return { value: null, attempts: attempt };
    }

    const result = validateAgainst(schema, parsed);
    if (result.ok) return { value: result.value, attempts: attempt };

    if (attempt < maxAttempts) {
      onRetry?.(attempt, result.errors);
      prompt = buildRetryPrompt(result.errors, text);
      continue;
    }
    return { value: null, attempts: attempt };
  }

  return { value: null, attempts: maxAttempts };
}
