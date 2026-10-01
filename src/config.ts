import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import esquery from "esquery";
import { type ParseError as JsoncParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

import { isPermissionState, toRecord } from "./common.js";
import type {
  CodemodePermissionRule,
  CodemodePolicyDiagnostic,
  PermissionConfig,
  PermissionLayerName,
  PermissionRule,
  SupportedToolName,
  ToolPermissions,
} from "./types.js";

const SUPPORTED_TOOLS = ["bash", "read", "edit", "write"] as const satisfies readonly SupportedToolName[];

export interface CachedPolicy {
  rules: PermissionRule[];
  codemodeRules: CodemodePermissionRule[];
  codemodeDiagnostics: CodemodePolicyDiagnostic[];
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

function parseJsoncDocument(raw: string, filePath: string): unknown {
  const errors: JsoncParseError[] = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true });

  if (errors.length > 0) {
    throw new Error(`Failed to parse permission config at '${filePath}' (${formatJsoncParseSummary(raw, errors)})`);
  }

  return parsed;
}

function normalizeOriginalToolConfig(record: Record<string, unknown>): PermissionConfig {
  const config: PermissionConfig = {};
  for (const toolName of SUPPORTED_TOOLS) {
    if (record[toolName] !== undefined) {
      config[toolName] = normalizeToolPermissions(record[toolName]);
    }
  }
  return config;
}

export function parsePermissionConfig(raw: string, filePath: string): PermissionConfig {
  return normalizeOriginalToolConfig(toRecord(parseJsoncDocument(raw, filePath)));
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePolicyDocument(
  raw: string,
  filePath: string,
  layer: PermissionLayerName,
): { config: PermissionConfig; codemodeRules: CodemodePermissionRule[]; diagnostics: CodemodePolicyDiagnostic[] } {
  const parsed = parseJsoncDocument(raw, filePath);
  const record = toRecord(parsed);
  const config = normalizeOriginalToolConfig(record);
  const codemodeRules: CodemodePermissionRule[] = [];
  const diagnostics: CodemodePolicyDiagnostic[] = [];

  if (!isConfigObject(parsed)) {
    diagnostics.push({ configPath: filePath, message: `Permission config at '${filePath}' must have an object at its top level.` });
    return { config, codemodeRules, diagnostics };
  }

  if (!Object.hasOwn(record, "codemode")) {
    return { config, codemodeRules, diagnostics };
  }

  const codemode = record.codemode;
  if (!isConfigObject(codemode)) {
    diagnostics.push({
      configPath: filePath,
      message: `The codemode section in '${filePath}' must be an object mapping selectors to permission states.`,
    });
    return { config, codemodeRules, diagnostics };
  }

  for (const [selector, state] of Object.entries(codemode)) {
    if (!selector.trim()) {
      diagnostics.push({
        configPath: filePath,
        selector,
        message: `The codemode selector in '${filePath}' must not be empty.`,
      });
      continue;
    }
    if (!isPermissionState(state)) {
      diagnostics.push({
        configPath: filePath,
        selector,
        message: `Invalid permission state for codemode selector '${selector}' in '${filePath}'; expected allow, ask, or deny.`,
      });
      continue;
    }

    try {
      codemodeRules.push({
        selector,
        state,
        layer,
        configPath: filePath,
        compiledSelector: esquery.parse(selector),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      diagnostics.push({
        configPath: filePath,
        selector,
        message: `Invalid codemode selector '${selector}' in '${filePath}': ${detail}`,
      });
    }
  }

  return { config, codemodeRules, diagnostics };
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
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    return "missing";
  }
}

export function buildPolicyStamp(globalPath: string, projectPath: string | null): string {
  return `${globalPath}:${getFileStamp(globalPath)}|${projectPath ?? "none"}:${projectPath ? getFileStamp(projectPath) : "none"}`;
}

function loadPolicyDocument(
  path: string | null,
  layer: PermissionLayerName,
): { config: PermissionConfig | null; codemodeRules: CodemodePermissionRule[]; diagnostics: CodemodePolicyDiagnostic[] } {
  if (!path) {
    return { config: null, codemodeRules: [], diagnostics: [] };
  }

  try {
    return parsePolicyDocument(readFileSync(path, "utf-8"), path, layer);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return { config: null, codemodeRules: [], diagnostics: [] };
    }

    const detail = error instanceof Error ? error.message : String(error);
    const message = `Failed to load permission config from '${path}': ${detail}`;
    return {
      config: null,
      codemodeRules: [],
      diagnostics: [{ configPath: path, message }],
    };
  }
}

export function resolveCachedPolicy(
  globalPath: string,
  projectPath: string | null,
  onWarning?: (message: string) => void,
): CachedPolicy {
  const globalPolicy = loadPolicyDocument(globalPath, "global");
  const projectPolicy = loadPolicyDocument(projectPath, "project");
  const rules: PermissionRule[] = [];
  const codemodeRules = [...globalPolicy.codemodeRules, ...projectPolicy.codemodeRules];
  const codemodeDiagnostics = [...globalPolicy.diagnostics, ...projectPolicy.diagnostics];

  pushRules(rules, "global", globalPolicy.config);
  pushRules(rules, "project", projectPolicy.config);

  for (const diagnostic of codemodeDiagnostics) {
    onWarning?.(diagnostic.message);
  }

  return {
    rules,
    codemodeRules,
    codemodeDiagnostics,
    stamp: buildPolicyStamp(globalPath, projectPath),
  };
}
