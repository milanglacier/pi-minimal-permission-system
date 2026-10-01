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
import { checkCodemodeScript } from "./src/codemode.js";
import type { CodemodePermissionRule, PermissionCheckResult, SupportedToolName } from "./src/types.js";

const SUPPORTED_TOOLS = new Set<string>(["bash", "read", "edit", "write"] satisfies SupportedToolName[]);
const CODEMODE_TOOL_NAME = "codemode";
const CODEMODE_PREVIEW_LIMIT = 1000;

// Deliberately not a "denial": the user stopped the turn, they did not refuse the tool.
const CANCELLED_BY_ABORT: ToolCallEventResult = {
  block: true,
  reason: "Permission request cancelled because the agent turn was aborted.",
};

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

function formatCodemodeMatches(matches: readonly CodemodePermissionRule[]): string {
  return matches
    .map((rule) => `- ${JSON.stringify(rule.selector)}: ${rule.state} (${rule.layer} config)`)
    .join("\n");
}

function escapePreviewControls(code: string): string {
  return code.replace(/[\u0000-\u001f\u007f]/g, (character) => {
    if (character === "\n") return "\n";
    if (character === "\t") return "\\t";
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

function formatCodemodePreview(code: string): string {
  const preview = escapePreviewControls(code.slice(0, CODEMODE_PREVIEW_LIMIT));
  const truncated = code.length > CODEMODE_PREVIEW_LIMIT;
  return `Script preview${truncated ? ` (truncated to ${CODEMODE_PREVIEW_LIMIT} of ${code.length} characters)` : ""}:\n${preview}`;
}

async function enforceCodemode(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  policy: RuntimePolicy,
): Promise<ToolCallEventResult> {
  const check = checkCodemodeScript(event.input, policy.codemodeRules, policy.codemodeDiagnostics);
  if (check.kind === "block") {
    return { block: true, reason: `Codemode is blocked because its permission check failed:\n${check.reason}` };
  }

  if (check.state === "deny") {
    return {
      block: true,
      reason: `Codemode script denied by policy:\n${formatCodemodeMatches(check.matches)}\n${hardStop()}`,
    };
  }

  if (check.state !== "ask") {
    return {};
  }

  if (!ctx.hasUI) {
    return {
      block: true,
      reason: `Codemode script requires approval, but no interactive UI is available.\n${formatCodemodeMatches(check.matches)}`,
    };
  }

  const code = toRecord(event.input).code;
  if (typeof code !== "string") {
    return { block: true, reason: "Codemode script input could not be read for approval." };
  }

  const signal = ctx.signal;
  if (signal?.aborted) {
    return CANCELLED_BY_ABORT;
  }

  const message = [
    "Allow this codemode script?",
    "Matching rules:",
    formatCodemodeMatches(check.matches),
    formatCodemodePreview(code),
  ].join("\n\n");
  const approved = await ctx.ui.confirm("Codemode Permission Required", message, { signal });
  if (signal?.aborted) {
    return CANCELLED_BY_ABORT;
  }
  if (!approved) {
    return { block: true, reason: `User denied codemode script. ${hardStop()}` };
  }

  return {};
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
    if (event.toolName !== CODEMODE_TOOL_NAME && !isSupportedToolName(event.toolName)) {
      return {};
    }

    if (yoloEnabled) {
      return {};
    }

    const policy = loadPolicy(ctx);
    if (event.toolName === CODEMODE_TOOL_NAME) {
      return enforceCodemode(event, ctx, policy);
    }

    if (!isSupportedToolName(event.toolName)) {
      return {};
    }

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

      const signal = ctx.signal;
      if (signal?.aborted) {
        return CANCELLED_BY_ABORT;
      }

      const approved = await ctx.ui.confirm("Permission Required", formatAskPrompt(result), { signal });
      // Abort can race with an approval before this handler resumes.
      if (signal?.aborted) {
        return CANCELLED_BY_ABORT;
      }
      if (!approved) {
        return { block: true, reason: formatUserDeniedReason(result) };
      }
    }

    return {};
  });
}
