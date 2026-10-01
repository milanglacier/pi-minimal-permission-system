import { parse } from "acorn";
import esquery from "esquery";

import { toRecord } from "./common.js";
import type { CodemodePermissionRule, CodemodePolicyDiagnostic, PermissionState } from "./types.js";

type EsqueryNode = Parameters<typeof esquery.match>[0];

export type CodemodeCheckResult =
  | { kind: "block"; reason: string }
  | { kind: "decision"; state: PermissionState; matches: CodemodePermissionRule[] };

function block(reason: string): CodemodeCheckResult {
  return { kind: "block", reason };
}

function parseScript(code: string): ReturnType<typeof parse> {
  return parse(code, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  });
}

function asEsqueryNode(ast: ReturnType<typeof parse>): EsqueryNode {
  // Acorn and esquery both use ESTree; their published ESTree versions differ slightly.
  return ast as unknown as EsqueryNode;
}

function resolveState(matches: readonly CodemodePermissionRule[]): PermissionState {
  if (matches.some((rule) => rule.state === "deny")) {
    return "deny";
  }
  if (matches.some((rule) => rule.state === "ask")) {
    return "ask";
  }
  return "allow";
}

export function checkCodemodeScript(
  input: unknown,
  rules: readonly CodemodePermissionRule[],
  diagnostics: readonly CodemodePolicyDiagnostic[],
): CodemodeCheckResult {
  if (diagnostics.length > 0) {
    return block(diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }

  if (rules.length === 0) {
    return { kind: "decision", state: "allow", matches: [] };
  }

  const code = toRecord(input).code;
  if (typeof code !== "string") {
    return block("Codemode permission rules are configured, but the tool input does not contain a string 'code' field.");
  }

  let ast: ReturnType<typeof parse>;
  try {
    ast = parseScript(code);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return block(`Could not check codemode script syntax: ${detail}`);
  }

  const matches: CodemodePermissionRule[] = [];
  for (const rule of rules) {
    try {
      if (esquery.match(asEsqueryNode(ast), rule.compiledSelector).length > 0) {
        matches.push(rule);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return block(`Could not evaluate codemode selector '${rule.selector}' from '${rule.configPath}': ${detail}`);
    }
  }

  return {
    kind: "decision",
    state: resolveState(matches),
    matches,
  };
}
