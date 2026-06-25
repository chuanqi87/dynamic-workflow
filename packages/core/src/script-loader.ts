import { parseExpressionAt } from "acorn";
import type { WorkflowGlobals, WorkflowMeta } from "./types.js";

/** Thrown when a script cannot be parsed into a valid (meta, body) pair. */
export class ScriptLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptLoadError";
  }
}

const META_PREFIX = /^\s*export\s+const\s+meta\s*=\s*/;

export interface LoadedScript {
  meta: WorkflowMeta;
  /** Source of the async function body (everything after the meta literal). */
  body: string;
}

/**
 * Split a workflow script into its `meta` literal and its executable body.
 *
 * The contract requires the file to begin with `export const meta = { ... }`
 * (a pure literal) followed by an async function body that uses top-level
 * `return` and ambient globals. Because that combination is neither a valid
 * ES module (top-level `return`) nor a valid script (`export`), we parse ONLY
 * the meta object expression with acorn and treat the remainder as opaque body
 * source handed to an AsyncFunction.
 */
export function loadScript(source: string): LoadedScript {
  const prefix = META_PREFIX.exec(source);
  if (!prefix) {
    throw new ScriptLoadError(
      "workflow script must begin with `export const meta = { ... }`",
    );
  }
  const exprStart = prefix[0].length;
  if (source[exprStart] !== "{") {
    throw new ScriptLoadError("`meta` must be an object literal");
  }

  let node: AnyNode;
  try {
    node = parseExpressionAt(source, exprStart, {
      ecmaVersion: "latest",
    }) as unknown as AnyNode;
  } catch (err) {
    throw new ScriptLoadError(
      `failed to parse the meta literal: ${(err as Error).message}`,
    );
  }
  if (node.type !== "ObjectExpression") {
    throw new ScriptLoadError("`meta` must be an object literal");
  }

  const meta = materialize(node) as WorkflowMeta;
  if (typeof meta.name !== "string" || typeof meta.description !== "string") {
    throw new ScriptLoadError("`meta` must include string `name` and `description`");
  }

  // Body = everything after the literal, minus an optional trailing semicolon.
  let bodyStart = node.end;
  while (bodyStart < source.length && /\s/.test(source[bodyStart]!)) bodyStart++;
  if (source[bodyStart] === ";") bodyStart++;
  const body = source.slice(bodyStart);

  return { meta, body };
}

// ---------------------------------------------------------------------------
// Pure-literal materialization (defence in depth alongside the validator)
// ---------------------------------------------------------------------------

interface AnyNode {
  type: string;
  start: number;
  end: number;
  [k: string]: unknown;
}

function materialize(node: AnyNode): unknown {
  switch (node.type) {
    case "Literal":
      return node.value;
    case "TemplateLiteral": {
      const exprs = node.expressions as unknown[];
      const quasis = node.quasis as Array<{ value: { cooked: string } }>;
      if (exprs.length !== 0) {
        throw new ScriptLoadError("`meta` may not contain template interpolation");
      }
      return quasis.map((q) => q.value.cooked).join("");
    }
    case "UnaryExpression": {
      const op = node.operator as string;
      const arg = node.argument as AnyNode;
      if ((op === "-" || op === "+") && arg.type === "Literal" && typeof arg.value === "number") {
        return op === "-" ? -arg.value : arg.value;
      }
      throw new ScriptLoadError(`unsupported expression in \`meta\`: ${op}`);
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((el) => {
        if (el == null) throw new ScriptLoadError("sparse arrays not allowed in `meta`");
        return materialize(el);
      });
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type !== "Property" || prop.computed === true || prop.kind !== "init") {
          throw new ScriptLoadError("`meta` may only contain plain literal properties");
        }
        const key = prop.key as AnyNode;
        const name =
          key.type === "Identifier"
            ? (key.name as string)
            : key.type === "Literal"
              ? String(key.value)
              : (() => {
                  throw new ScriptLoadError("invalid key in `meta`");
                })();
        out[name] = materialize(prop.value as AnyNode);
      }
      return out;
    }
    default:
      throw new ScriptLoadError(
        `\`meta\` must be a pure literal; found ${node.type}`,
      );
  }
}

// ---------------------------------------------------------------------------
// Sandboxed execution
// ---------------------------------------------------------------------------

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...a: unknown[]) => Promise<unknown>;

/** Deterministic stubs that shadow non-deterministic builtins inside scripts. */
function determinismStubs(): { Date: unknown; Math: unknown } {
  const RealDate = Date;
  class DateStub extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        throw new Error(
          "argument-less `new Date()` is forbidden in workflow scripts (must be deterministic); pass a fixed value or inject time via `args`",
        );
      }
      super(...(args as ConstructorParameters<typeof Date>));
    }
    static override now(): number {
      throw new Error(
        "`Date.now()` is forbidden in workflow scripts (must be deterministic)",
      );
    }
  }

  const MathStub: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(Math)) {
    MathStub[key] = (Math as unknown as Record<string, unknown>)[key];
  }
  MathStub.random = () => {
    throw new Error(
      "`Math.random()` is forbidden in workflow scripts (must be deterministic); derive randomness from `args`",
    );
  };

  return { Date: DateStub, Math: Object.freeze(MathStub) };
}

/**
 * Execute a workflow body with the given ambient globals.
 *
 * Globals are injected as function parameters so that any free identifier in
 * the body resolves to either an injected name or a real (whitelisted) global.
 * `Date`/`Math` are shadowed with deterministic stubs.
 */
export async function executeBody(
  body: string,
  globals: WorkflowGlobals & { meta: WorkflowMeta },
): Promise<unknown> {
  const stubs = determinismStubs();
  const injected: Record<string, unknown> = { ...globals, ...stubs };
  const names = Object.keys(injected);
  const fn = new AsyncFunction(...names, `"use strict";\n${body}`);
  return await fn(...names.map((n) => injected[n]));
}
