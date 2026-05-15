import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import { createPathMatchCandidates, getNonEmptyString, normalizePathForPermission, toRecord } from "./src/common.js";
import {
  buildPolicyStamp,
  getGlobalConfigPath,
  getProjectConfigPath,
  resolveCachedPolicy,
  type CachedPolicy,
} from "./src/config.js";
import { compileRules, findLastGlobalMatch, findLastMatch, type CompiledRule, type RuleMatch } from "./src/matcher.js";
import type { PermissionCheckResult, SupportedToolName } from "./src/types.js";

const SUPPORTED_TOOLS = new Set<string>(["bash", "read", "edit", "write"] satisfies SupportedToolName[]);

type RuntimePolicy = CachedPolicy & {
  compiledRules: CompiledRule[];
};

let cachedPolicy: RuntimePolicy | null = null;
let cachedCwd: string | undefined;
let yoloEnabled = false;

function isSupportedToolName(toolName: string): toolName is SupportedToolName {
  return SUPPORTED_TOOLS.has(toolName);
}

function loadPolicy(ctx: ExtensionContext): RuntimePolicy {
  const globalPath = getGlobalConfigPath();
  const projectPath = ctx.cwd ? getProjectConfigPath(ctx.cwd) : null;
  const stamp = buildPolicyStamp(globalPath, projectPath);

  if (cachedPolicy && cachedCwd === ctx.cwd && cachedPolicy.stamp === stamp) {
    return cachedPolicy;
  }

  const warn = (message: string): void => {
    if (ctx.hasUI) {
      ctx.ui.notify(message, "warning");
    }
  };

  const resolved = resolveCachedPolicy(globalPath, projectPath, warn);
  cachedPolicy = {
    ...resolved,
    compiledRules: compileRules(resolved.rules),
  };
  cachedCwd = ctx.cwd;
  return cachedPolicy;
}

function resolveRuleMatch(
  rules: readonly CompiledRule[],
  toolName: SupportedToolName,
  values: readonly string[],
): RuleMatch | null {
  const toolRules = rules.filter((rule) => rule.toolName === toolName);
  const match = findLastMatch(toolRules, values);

  if (match?.state !== "deny") {
    const globalMatch = findLastGlobalMatch(toolRules, values);
    if (globalMatch?.state === "deny") {
      return globalMatch;
    }
  }

  return match;
}

function checkPermission(
  toolName: SupportedToolName,
  input: unknown,
  cwd: string | undefined,
  policy: RuntimePolicy,
): PermissionCheckResult {
  const record = toRecord(input);

  if (toolName === "bash") {
    const command = getNonEmptyString(record.command) ?? "";
    const match = resolveRuleMatch(policy.compiledRules, toolName, [command]);

    return {
      toolName,
      state: match?.state ?? "ask",
      matchedPattern: match?.matchedPattern,
      matchedLayer: match?.matchedLayer,
      command,
    };
  }

  const pathValue = getNonEmptyString(record.path) ?? getNonEmptyString(record.file_path) ?? "";
  const path = pathValue ? normalizePathForPermission(pathValue, cwd) : "";
  const candidates = pathValue ? createPathMatchCandidates(pathValue, cwd) : [];
  const match = resolveRuleMatch(policy.compiledRules, toolName, candidates);

  return {
    toolName,
    state: match?.state ?? "ask",
    matchedPattern: match?.matchedPattern,
    matchedLayer: match?.matchedLayer,
    path,
  };
}

function formatMatchSuffix(result: PermissionCheckResult): string {
  if (!result.matchedPattern) {
    return "";
  }

  const layer = result.matchedLayer ? ` from ${result.matchedLayer} config` : "";
  return ` (matched '${result.matchedPattern}'${layer})`;
}

function hardStop(): string {
  return "Hard stop: this permission denial is policy-enforced. Do not retry or investigate bypasses; report the block to the user.";
}

function formatDenyReason(result: PermissionCheckResult): string {
  if (result.toolName === "bash") {
    return `Permission denied for bash command '${result.command ?? ""}'${formatMatchSuffix(result)}. ${hardStop()}`;
  }

  return `Permission denied for ${result.toolName} on '${result.path ?? ""}'${formatMatchSuffix(result)}. ${hardStop()}`;
}

function formatAskPrompt(result: PermissionCheckResult): string {
  if (result.toolName === "bash") {
    return `Allow bash command '${result.command ?? ""}'${formatMatchSuffix(result)}?`;
  }

  return `Allow ${result.toolName} on '${result.path ?? ""}'${formatMatchSuffix(result)}?`;
}

function formatUnavailableReason(result: PermissionCheckResult): string {
  if (result.toolName === "bash") {
    return `Bash command '${result.command ?? ""}' requires approval, but no interactive UI is available.`;
  }

  return `${result.toolName} on '${result.path ?? ""}' requires approval, but no interactive UI is available.`;
}

function formatUserDeniedReason(result: PermissionCheckResult): string {
  if (result.toolName === "bash") {
    return `User denied bash command '${result.command ?? ""}'. ${hardStop()}`;
  }

  return `User denied ${result.toolName} on '${result.path ?? ""}'. ${hardStop()}`;
}

export default function minimalPermissionExtension(pi: ExtensionAPI): void {
  yoloEnabled = false;

  pi.registerFlag("yolo", {
    description: "Bypass permission checks enforced by pi-minimal-permission-system.",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("yolo", {
    description: "Toggle permission checks enforced by pi-minimal-permission-system.",
    handler: async (_args, ctx) => {
      yoloEnabled = !yoloEnabled;
      ctx.ui.notify(`YOLO mode ${yoloEnabled ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    yoloEnabled = pi.getFlag("yolo") === true;
    if (!yoloEnabled) {
      loadPolicy(ctx);
    }
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult> => {
    if (!isSupportedToolName(event.toolName)) {
      return {};
    }

    if (yoloEnabled) {
      return {};
    }

    const policy = loadPolicy(ctx);
    const result = checkPermission(
      event.toolName,
      event.input,
      ctx.cwd,
      policy,
    );

    if (result.state === "deny") {
      return { block: true, reason: formatDenyReason(result) };
    }

    if (result.state === "ask") {
      if (!ctx.hasUI) {
        return { block: true, reason: formatUnavailableReason(result) };
      }

      const approved = await ctx.ui.confirm("Permission Required", formatAskPrompt(result));
      if (!approved) {
        return { block: true, reason: formatUserDeniedReason(result) };
      }
    }

    return {};
  });
}
