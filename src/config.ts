import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { isPermissionState, toRecord } from "./common.js";
import type { PermissionConfig, ToolPermissions } from "./types.js";

export function getGlobalConfigPath(): string {
  return join(homedir(), ".pi", "agent", "minimal-pi-permissions.jsonc");
}

export function getProjectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "agent", "pi-permissions.jsonc");
}

function normalizeToolPermissions(value: unknown): ToolPermissions {
  const record = toRecord(value);
  const result: ToolPermissions = {};
  for (const [key, state] of Object.entries(record)) {
    if (isPermissionState(state)) {
      result[key] = state;
    }
  }
  return result;
}

function parseConfig(raw: string, filePath: string): PermissionConfig {
  const errors: unknown[] = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`Failed to parse ${filePath}`);
  }
  const record = toRecord(parsed);
  return {
    bash: record.bash !== undefined ? normalizeToolPermissions(record.bash) : undefined,
    read: record.read !== undefined ? normalizeToolPermissions(record.read) : undefined,
    write: record.write !== undefined ? normalizeToolPermissions(record.write) : undefined,
    edit: record.edit !== undefined ? normalizeToolPermissions(record.edit) : undefined,
  };
}

export function loadConfig(path: string | null, onWarning?: (msg: string) => void): PermissionConfig | null {
  if (!path) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return parseConfig(raw, path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return null;
    }
    const msg = error instanceof Error ? error.message : String(error);
    onWarning?.(`Failed to load permission config from ${path}: ${msg}`);
    return null;
  }
}

export function mergeConfigs(global: PermissionConfig | null, project: PermissionConfig | null): PermissionConfig {
  const result: PermissionConfig = {};
  const tools: (keyof PermissionConfig)[] = ["bash", "read", "write", "edit"];
  for (const tool of tools) {
    const globalRules = global?.[tool] ?? {};
    const projectRules = project?.[tool] ?? {};
    result[tool] = { ...globalRules, ...projectRules };
  }
  return result;
}

function getFileStamp(path: string): string {
  try {
    return String(statSync(path).mtimeMs);
  } catch {
    return "missing";
  }
}

export interface CachedConfig {
  config: PermissionConfig;
  stamp: string;
}

export function buildStamp(globalPath: string, projectPath: string | null): string {
  return `${getFileStamp(globalPath)}|${projectPath ? getFileStamp(projectPath) : "none"}`;
}

export function resolveConfig(
  globalPath: string,
  projectPath: string | null,
  onWarning?: (msg: string) => void,
): CachedConfig {
  const globalConfig = loadConfig(globalPath, onWarning);
  const projectConfig = projectPath ? loadConfig(projectPath, onWarning) : null;
  const merged = mergeConfigs(globalConfig, projectConfig);
  const stamp = buildStamp(globalPath, projectPath);
  return { config: merged, stamp };
}
