import picomatch from "picomatch";
import type { PermissionState } from "./types.js";

export interface CompiledPattern {
  pattern: string;
  state: PermissionState;
  test: (value: string) => boolean;
}

export function compilePatterns(patterns: Record<string, PermissionState>): CompiledPattern[] {
  const entries: CompiledPattern[] = [];
  for (const [pattern, state] of Object.entries(patterns)) {
    entries.push({
      pattern,
      state,
      test: picomatch(pattern, { dot: true }),
    });
  }
  return entries;
}

export function findMatch(
  patterns: CompiledPattern[],
  value: string,
): { state: PermissionState; matchedPattern: string } | null {
  for (let i = patterns.length - 1; i >= 0; i--) {
    if (patterns[i].test(value)) {
      return { state: patterns[i].state, matchedPattern: patterns[i].pattern };
    }
  }
  return null;
}
