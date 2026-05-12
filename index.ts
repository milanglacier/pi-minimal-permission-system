import { homedir } from "node:os";
import { resolve, normalize, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getGlobalConfigPath, getProjectConfigPath, resolveConfig, buildStamp } from "./src/config.js";
import { compilePatterns } from "./src/matcher.js";
import type { CachedConfig } from "./src/config.js";
import type { PermissionCheckResult, PermissionConfig, PermissionState } from "./src/types.js";

const SUPPORTED_TOOLS = new Set(["bash", "read", "write", "edit"]);

function normalizePath(pathValue: string, cwd: string): string {
  const trimmed = pathValue.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return "";

  let normalizedPath = trimmed;
  if (normalizedPath === "~") {
    normalizedPath = homedir();
  } else if (normalizedPath.startsWith("~/")) {
    normalizedPath = join(homedir(), normalizedPath.slice(2));
  }

  const absolutePath = resolve(cwd, normalizedPath);
  const normalizedAbsolutePath = normalize(absolutePath);
  return process.platform === "win32" ? normalizedAbsolutePath.toLowerCase() : normalizedAbsolutePath;
}

function getRelativePath(absolutePath: string, cwd: string): string {
  const rel = relative(normalize(cwd), absolutePath);
  return process.platform === "win32" ? normalize(rel).replace(/\\/g, "/") : normalize(rel);
}

function checkPermission(
  toolName: string,
  input: unknown,
  cwd: string | undefined,
  config: PermissionConfig,
): PermissionCheckResult {
  const rules = config[toolName as keyof PermissionConfig];
  if (!rules || Object.keys(rules).length === 0) {
    return { toolName, state: "ask" };
  }

  const compiled = compilePatterns(rules);

  if (toolName === "bash") {
    const command = typeof (input as Record<string, unknown>).command === "string"
      ? String((input as Record<string, unknown>).command)
      : "";

    let lastMatch: { state: PermissionState; matchedPattern: string } | null = null;
    for (let i = compiled.length - 1; i >= 0; i--) {
      if (compiled[i].test(command)) {
        lastMatch = { state: compiled[i].state, matchedPattern: compiled[i].pattern };
        break;
      }
    }

    return {
      toolName,
      state: lastMatch?.state ?? "ask",
      matchedPattern: lastMatch?.matchedPattern,
      command,
    };
  }

  // read, write, edit
  const pathInput = typeof (input as Record<string, unknown>).path === "string"
    ? String((input as Record<string, unknown>).path)
    : "";

  const absolutePath = cwd ? normalizePath(pathInput, cwd) : pathInput;
  const relPath = cwd ? getRelativePath(absolutePath, cwd) : pathInput;

  let lastMatch: { state: PermissionState; matchedPattern: string } | null = null;

  for (let i = compiled.length - 1; i >= 0; i--) {
    const pattern = compiled[i];
    if (pattern.test(absolutePath) || pattern.test(relPath)) {
      lastMatch = { state: pattern.state, matchedPattern: pattern.pattern };
      break;
    }
  }

  return {
    toolName,
    state: lastMatch?.state ?? "ask",
    matchedPattern: lastMatch?.matchedPattern,
    path: absolutePath,
  };
}

function formatDenyReason(result: PermissionCheckResult): string {
  if (result.toolName === "bash" && result.command) {
    return `Permission denied for bash command '${result.command}'${result.matchedPattern ? ` (matched '${result.matchedPattern}')` : ""}. Hard stop: do not retry or investigate bypasses; report the block to the user.`;
  }
  if (result.path) {
    return `Permission denied for ${result.toolName} on '${result.path}'${result.matchedPattern ? ` (matched '${result.matchedPattern}')` : ""}. Hard stop: do not retry or investigate bypasses; report the block to the user.`;
  }
  return `Permission denied for tool '${result.toolName}'. Hard stop: do not retry or investigate bypasses; report the block to the user.`;
}

function formatAskPrompt(result: PermissionCheckResult): string {
  if (result.toolName === "bash" && result.command) {
    return `Allow bash command '${result.command}'?`;
  }
  if (result.path) {
    return `Allow ${result.toolName} on '${result.path}'?`;
  }
  return `Allow tool '${result.toolName}'?`;
}

function formatUnavailableReason(result: PermissionCheckResult): string {
  if (result.toolName === "bash" && result.command) {
    return `Bash command '${result.command}' requires approval, but no interactive UI is available.`;
  }
  if (result.path) {
    return `${result.toolName} on '${result.path}' requires approval, but no interactive UI is available.`;
  }
  return `Tool '${result.toolName}' requires approval, but no interactive UI is available.`;
}

function formatUserDeniedReason(result: PermissionCheckResult): string {
  if (result.toolName === "bash" && result.command) {
    return `User denied bash command '${result.command}'. Hard stop: do not retry or investigate bypasses; report the block to the user.`;
  }
  if (result.path) {
    return `User denied ${result.toolName} on '${result.path}'. Hard stop: do not retry or investigate bypasses; report the block to the user.`;
  }
  return `User denied tool '${result.toolName}'. Hard stop: do not retry or investigate bypasses; report the block to the user.`;
}

export default function minimalPermissionExtension(pi: ExtensionAPI): void {
  let cached: CachedConfig | null = null;
  let lastCwd: string | undefined;

  const refreshConfig = (ctx: ExtensionContext, onWarning?: (msg: string) => void): PermissionConfig => {
    const globalPath = getGlobalConfigPath();
    const projectPath = ctx.cwd ? getProjectConfigPath(ctx.cwd) : null;
    const stamp = buildStamp(globalPath, projectPath);

    if (cached && lastCwd === ctx.cwd && cached.stamp === stamp) {
      return cached.config;
    }

    const resolved = resolveConfig(globalPath, projectPath, onWarning);
    cached = resolved;
    lastCwd = ctx.cwd;
    return resolved.config;
  };

  pi.on("session_start", async (_event, ctx) => {
    refreshConfig(ctx, (msg) => {
      if (ctx.hasUI) ctx.ui.notify(msg, "warning");
    });
  });

  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;
    if (!SUPPORTED_TOOLS.has(toolName)) {
      return {};
    }

    const config = refreshConfig(ctx, (msg) => {
      if (ctx.hasUI) ctx.ui.notify(msg, "warning");
    });

    const result = checkPermission(toolName, event.input, ctx.cwd, config);

    if (result.state === "deny") {
      return { block: true, reason: formatDenyReason(result) };
    }

    if (result.state === "ask") {
      if (!ctx.hasUI) {
        return { block: true, reason: formatUnavailableReason(result) };
      }

      const message = formatAskPrompt(result);
      const ok = await ctx.ui.confirm("Permission Required", message);
      if (!ok) {
        return { block: true, reason: formatUserDeniedReason(result) };
      }
    }

    return {};
  });
}
