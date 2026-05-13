import picomatch from "picomatch";

import type { PermissionRule, PermissionState } from "./types.js";

export interface CompiledRule extends PermissionRule {
  test(value: string): boolean;
}

export interface RuleMatch {
  state: PermissionState;
  matchedPattern: string;
  matchedLayer: PermissionRule["layer"];
}

export function compileRules(rules: readonly PermissionRule[]): CompiledRule[] {
  return rules.map((rule) => ({
    ...rule,
    test: rule.toolName === "bash" ? compileBashRegex(rule.pattern) : picomatch(rule.pattern, { dot: true }),
  }));
}

function compileBashRegex(pattern: string): (value: string) => boolean {
  try {
    const regex = new RegExp(pattern, "u");
    return (value: string): boolean => regex.test(value);
  } catch {
    return (): boolean => false;
  }
}

export function findLastMatch(
  rules: readonly CompiledRule[],
  values: readonly string[],
): RuleMatch | null {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    for (const value of values) {
      if (value && rule.test(value)) {
        return {
          state: rule.state,
          matchedPattern: rule.pattern,
          matchedLayer: rule.layer,
        };
      }
    }
  }

  return null;
}

export function findLastGlobalMatch(
  rules: readonly CompiledRule[],
  values: readonly string[],
): RuleMatch | null {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (rule.layer !== "global") {
      continue;
    }

    for (const value of values) {
      if (value && rule.test(value)) {
        return {
          state: rule.state,
          matchedPattern: rule.pattern,
          matchedLayer: rule.layer,
        };
      }
    }
  }

  return null;
}
