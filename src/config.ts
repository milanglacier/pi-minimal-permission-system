import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { type ParseError as JsoncParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

import { isPermissionState, toRecord } from "./common.js";
import type { PermissionConfig, PermissionRule, SupportedToolName, ToolPermissions } from "./types.js";

const SUPPORTED_TOOLS = ["bash", "read", "edit", "write"] as const satisfies readonly SupportedToolName[];

export interface CachedPolicy {
  rules: PermissionRule[];
  stamp: string;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function formatJsoncParseSummary(input: string, errors: readonly JsoncParseError[]): string {
  const firstError = errors[0];
  if (!firstError) {
    return "unknown parse error";
  }

  const beforeOffset = input.slice(0, firstError.offset).split("\n");
  const line = beforeOffset.length;
  const column = (beforeOffset.at(-1)?.length ?? 0) + 1;
  return `${printParseErrorCode(firstError.error)} at line ${line}, column ${column}`;
}

export function getGlobalConfigPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "permissions.jsonc");
}

export function getProjectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "agent", "permissions.jsonc");
}

function normalizeToolPermissions(value: unknown): ToolPermissions {
  const record = toRecord(value);
  const normalized: ToolPermissions = {};

  for (const [pattern, state] of Object.entries(record)) {
    if (isPermissionState(state)) {
      normalized[pattern] = state;
    }
  }

  return normalized;
}

export function parsePermissionConfig(raw: string, filePath: string): PermissionConfig {
  const errors: JsoncParseError[] = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true });

  if (errors.length > 0) {
    throw new Error(`Failed to parse permission config at '${filePath}' (${formatJsoncParseSummary(raw, errors)})`);
  }

  const record = toRecord(parsed);
  const config: PermissionConfig = {};

  for (const toolName of SUPPORTED_TOOLS) {
    if (record[toolName] !== undefined) {
      config[toolName] = normalizeToolPermissions(record[toolName]);
    }
  }

  return config;
}

export function loadPermissionConfig(
  path: string | null,
  onWarning?: (message: string) => void,
): PermissionConfig | null {
  if (!path) {
    return null;
  }

  try {
    return parsePermissionConfig(readFileSync(path, "utf-8"), path);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return null;
    }

    const message = error instanceof Error ? error.message : String(error);
    onWarning?.(`Failed to load permission config from '${path}': ${message}`);
    return null;
  }
}

function pushRules(
  rules: PermissionRule[],
  layer: PermissionRule["layer"],
  config: PermissionConfig | null,
): void {
  if (!config) {
    return;
  }

  for (const toolName of SUPPORTED_TOOLS) {
    const toolRules = config[toolName];
    if (!toolRules) {
      continue;
    }

    for (const [pattern, state] of Object.entries(toolRules)) {
      rules.push({ toolName, pattern, state, layer });
    }
  }
}

export function resolvePermissionRules(
  globalPath: string,
  projectPath: string | null,
  onWarning?: (message: string) => void,
): PermissionRule[] {
  const globalConfig = loadPermissionConfig(globalPath, onWarning);
  const projectConfig = projectPath ? loadPermissionConfig(projectPath, onWarning) : null;
  const rules: PermissionRule[] = [];

  pushRules(rules, "global", globalConfig);
  pushRules(rules, "project", projectConfig);

  return rules;
}

function getFileStamp(path: string): string {
  try {
    return String(statSync(path).mtimeMs);
  } catch {
    return "missing";
  }
}

export function buildPolicyStamp(globalPath: string, projectPath: string | null): string {
  return `${globalPath}:${getFileStamp(globalPath)}|${projectPath ?? "none"}:${projectPath ? getFileStamp(projectPath) : "none"}`;
}

export function resolveCachedPolicy(
  globalPath: string,
  projectPath: string | null,
  onWarning?: (message: string) => void,
): CachedPolicy {
  return {
    rules: resolvePermissionRules(globalPath, projectPath, onWarning),
    stamp: buildPolicyStamp(globalPath, projectPath),
  };
}
