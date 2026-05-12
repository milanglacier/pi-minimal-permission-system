import { homedir } from "node:os";
import { basename, isAbsolute, normalize, relative, resolve } from "node:path";

import type { PermissionState } from "./types.js";

export function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

export function getNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function isPermissionState(value: unknown): value is PermissionState {
  return value === "allow" || value === "deny" || value === "ask";
}

export function normalizeForMatch(value: string): string {
  const normalized = normalize(value);
  return (process.platform === "win32" ? normalized.toLowerCase() : normalized).replace(/\\/g, "/");
}

function expandHome(pathValue: string): string {
  if (pathValue === "~") {
    return homedir();
  }

  if (pathValue.startsWith("~/") || pathValue.startsWith("~\\")) {
    return resolve(homedir(), pathValue.slice(2));
  }

  return pathValue;
}

export function normalizePathForPermission(pathValue: string, cwd: string | undefined): string {
  const trimmed = pathValue.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) {
    return "";
  }

  const expanded = expandHome(trimmed);
  const absolute = cwd && !isAbsolute(expanded) ? resolve(cwd, expanded) : resolve(expanded);
  return normalizeForMatch(absolute);
}

export function createPathMatchCandidates(pathValue: string, cwd: string | undefined): string[] {
  const trimmed = pathValue.trim().replace(/^["']|["']$/g, "");
  const normalizedInput = normalizeForMatch(expandHome(trimmed));
  const normalizedPath = normalizePathForPermission(pathValue, cwd);
  const candidates = new Set<string>();

  if (normalizedPath) {
    candidates.add(normalizedPath);
  }

  if (cwd && normalizedPath) {
    const normalizedCwd = normalizeForMatch(resolve(cwd));
    const relativePath = normalizeForMatch(relative(normalizedCwd, normalizedPath));

    if (relativePath && relativePath !== "." && !relativePath.startsWith("../") && relativePath !== "..") {
      candidates.add(relativePath);
    }
  }

  if (normalizedInput) {
    candidates.add(normalizedInput);
  }

  const base = basename(normalizedPath);
  if (base) {
    candidates.add(base);
  }

  return [...candidates].filter(Boolean);
}
