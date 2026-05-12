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
    test: picomatch(rule.pattern, { dot: true }),
  }));
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
