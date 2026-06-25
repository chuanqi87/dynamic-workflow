import { parse } from "acorn";
import { fullAncestor } from "acorn-walk";
import { loadScript, ScriptLoadError } from "./script-loader.js";
import { LIMITS, type WorkflowMeta } from "./types.js";

export type Severity = "error" | "warning";

export interface ValidationIssue {
  severity: Severity;
  rule: string;
  message: string;
  line?: number;
  column?: number;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  meta?: WorkflowMeta;
}

const ALLOWED_META_KEYS = new Set(["name", "description", "phases", "whenToUse", "model"]);

/** Identifiers that should never appear in a portable workflow body. */
const ESCAPE_IDENTIFIERS = new Set([
  "globalThis",
  "process",
  "require",
  "eval",
  "Function",
  "GeneratorFunction",
  "AsyncFunction",
  "Bun",
  "Deno",
  "module",
  "exports",
]);

/** Free identifiers that are legitimately available to a workflow body. */
const AMBIENT_GLOBALS = new Set([
  "agent",
  "parallel",
  "pipeline",
  "phase",
  "log",
  "workflow",
  "question",
  "args",
  "budget",
  "meta",
]);

const SAFE_BUILTINS = new Set([
  "console",
  "JSON",
  "Promise",
  "Object",
  "Array",
  "Math",
  "Date",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "Infinity",
  "NaN",
  "undefined",
  "isNaN",
  "isFinite",
  "parseInt",
  "parseFloat",
  "encodeURIComponent",
  "decodeURIComponent",
  "structuredClone",
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "atob",
  "btoa",
  "BigInt",
]);

interface AnyNode {
  type: string;
  start: number;
  end: number;
  [k: string]: unknown;
}

/**
 * Statically validate that a workflow script conforms to the portable
 * contract. Any `error`-severity issue means the script must NOT be executed.
 */
export function validateScript(source: string): ValidationResult {
  const issues: ValidationIssue[] = [];
  const push = (
    severity: Severity,
    rule: string,
    message: string,
    pos?: number,
  ): void => {
    const loc = pos != null ? lineCol(source, pos) : undefined;
    issues.push({ severity, rule, message, line: loc?.line, column: loc?.column });
  };

  // ---- 1. meta extraction + purity (delegated to the loader) -------------
  let meta: WorkflowMeta | undefined;
  let body: string | undefined;
  try {
    const loaded = loadScript(source);
    meta = loaded.meta;
    body = loaded.body;
  } catch (err) {
    if (err instanceof ScriptLoadError) {
      push("error", "meta-literal", err.message, 0);
      return { ok: false, issues };
    }
    throw err;
  }

  // ---- 2. meta field shape ------------------------------------------------
  for (const key of Object.keys(meta)) {
    if (!ALLOWED_META_KEYS.has(key)) {
      push("error", "meta-keys", `unknown \`meta\` field: ${key}`, 0);
    }
  }

  // ---- 3. parse body (script mode, return/await allowed) -----------------
  let ast: AnyNode;
  // The body source starts partway through the file; offset keeps positions
  // pointing at the real location for diagnostics.
  const bodyOffset = source.length - body.length;
  try {
    ast = parse(body, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      locations: false,
    }) as unknown as AnyNode;
  } catch (err) {
    push(
      "error",
      "syntax",
      `body is not valid plain JavaScript (TypeScript syntax is not allowed): ${(err as Error).message}`,
      bodyOffset,
    );
    return { ok: false, issues, meta };
  }

  // ---- 4. AST walk: forbidden APIs, escapes, batch limits ----------------
  const declared = collectDeclaredNames(ast);
  const seenFreeWarnings = new Set<string>();

  fullAncestor(ast as never, (raw, _state, ancestors) => {
    const node = raw as unknown as AnyNode;
    const pos = node.start + bodyOffset;
    const parent = ancestors[ancestors.length - 2] as unknown as AnyNode | undefined;

    switch (node.type) {
      case "WithStatement":
        push("error", "with", "`with` statements are not allowed", pos);
        break;
      case "ImportExpression":
        push("error", "dynamic-import", "dynamic `import()` is not allowed", pos);
        break;
      case "MemberExpression": {
        const obj = node.object as AnyNode;
        const prop = node.property as AnyNode;
        const propName =
          prop.type === "Identifier" ? (prop.name as string) : undefined;
        if (obj.type === "Identifier" && obj.name === "Math" && propName === "random") {
          push(
            "error",
            "no-random",
            "`Math.random()` is forbidden (workflows must be deterministic)",
            pos,
          );
        }
        if (obj.type === "Identifier" && obj.name === "Date" && propName === "now") {
          push(
            "error",
            "no-now",
            "`Date.now()` is forbidden (workflows must be deterministic)",
            pos,
          );
        }
        if (!node.computed && (propName === "constructor" || propName === "__proto__")) {
          push(
            "error",
            "proto-access",
            `access to \`.${propName}\` is not allowed (possible sandbox escape)`,
            pos,
          );
        }
        break;
      }
      case "NewExpression": {
        const callee = node.callee as AnyNode;
        const argsArr = node.arguments as unknown[];
        if (callee.type === "Identifier" && callee.name === "Date" && argsArr.length === 0) {
          push(
            "error",
            "no-now",
            "argument-less `new Date()` is forbidden (workflows must be deterministic)",
            pos,
          );
        }
        break;
      }
      case "CallExpression": {
        checkBatchLimit(node, push, bodyOffset);
        break;
      }
      case "Identifier": {
        const name = node.name as string;
        if (!isReferencePosition(node, parent)) break;
        if (ESCAPE_IDENTIFIERS.has(name)) {
          push("error", "escape", `use of \`${name}\` is not allowed in a portable workflow`, pos);
          break;
        }
        if (
          !declared.has(name) &&
          !AMBIENT_GLOBALS.has(name) &&
          !SAFE_BUILTINS.has(name) &&
          !seenFreeWarnings.has(name)
        ) {
          seenFreeWarnings.add(name);
          push(
            "warning",
            "unknown-global",
            `\`${name}\` is not an ambient workflow global or known builtin; it may not exist on every host`,
            pos,
          );
        }
        break;
      }
    }
  });

  const ok = issues.every((i) => i.severity !== "error");
  return { ok, issues, meta };
}

function checkBatchLimit(
  node: AnyNode,
  push: (s: Severity, r: string, m: string, pos?: number) => void,
  offset: number,
): void {
  const callee = node.callee as AnyNode;
  if (callee.type !== "Identifier") return;
  const name = callee.name as string;
  if (name !== "parallel" && name !== "pipeline") return;
  const first = (node.arguments as AnyNode[])[0];
  if (first && first.type === "ArrayExpression") {
    const len = (first.elements as unknown[]).length;
    if (len > LIMITS.MAX_BATCH) {
      push(
        "error",
        "batch-limit",
        `${name}() received ${len} literal items; the limit is ${LIMITS.MAX_BATCH}`,
        node.start + offset,
      );
    }
  }
}

/** Collect every name introduced by a binding anywhere in the tree. */
function collectDeclaredNames(ast: AnyNode): Set<string> {
  const names = new Set<string>();
  const addPattern = (pat: AnyNode | null | undefined): void => {
    if (!pat) return;
    switch (pat.type) {
      case "Identifier":
        names.add(pat.name as string);
        break;
      case "ObjectPattern":
        for (const p of pat.properties as AnyNode[]) {
          if (p.type === "RestElement") addPattern(p.argument as AnyNode);
          else addPattern(p.value as AnyNode);
        }
        break;
      case "ArrayPattern":
        for (const el of pat.elements as Array<AnyNode | null>) addPattern(el);
        break;
      case "AssignmentPattern":
        addPattern(pat.left as AnyNode);
        break;
      case "RestElement":
        addPattern(pat.argument as AnyNode);
        break;
    }
  };

  fullAncestor(ast as never, (raw) => {
    const node = raw as unknown as AnyNode;
    switch (node.type) {
      case "VariableDeclarator":
        addPattern(node.id as AnyNode);
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        if (node.id) addPattern(node.id as AnyNode);
        for (const p of node.params as AnyNode[]) addPattern(p);
        break;
      case "ClassDeclaration":
      case "ClassExpression":
        if (node.id) addPattern(node.id as AnyNode);
        break;
      case "CatchClause":
        if (node.param) addPattern(node.param as AnyNode);
        break;
    }
  });
  return names;
}

/** Decide whether an Identifier node is a value reference (vs a binding/key). */
function isReferencePosition(node: AnyNode, parent: AnyNode | undefined): boolean {
  if (!parent) return true;
  switch (parent.type) {
    case "MemberExpression":
      // `a.b` → `b` is a property name, not a free variable (unless computed).
      return !(parent.property === node && !parent.computed);
    case "Property":
      // `{ b: x }` → `b` is a key unless computed/shorthand value.
      if (parent.key === node && !parent.computed) return false;
      return true;
    case "VariableDeclarator":
      return parent.id !== node;
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
    case "ClassDeclaration":
    case "ClassExpression":
      return parent.id !== node && !(parent.params as unknown[] | undefined)?.includes(node);
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return false;
    default:
      return true;
  }
}

function lineCol(source: string, pos: number): { line: number; column: number } {
  let line = 1;
  let last = 0;
  for (let i = 0; i < pos && i < source.length; i++) {
    if (source[i] === "\n") {
      line++;
      last = i + 1;
    }
  }
  return { line, column: pos - last + 1 };
}

/** Format issues as a human-readable report. */
export function formatIssues(issues: ValidationIssue[]): string {
  return issues
    .map((i) => {
      const at = i.line != null ? ` (line ${i.line}:${i.column})` : "";
      return `  [${i.severity}] ${i.rule}: ${i.message}${at}`;
    })
    .join("\n");
}
