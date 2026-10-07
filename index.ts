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
import type { CodemodePermissionRule, PermissionCheckResult, PermissionState, SupportedToolName } from "./src/types.js";

const SUPPORTED_TOOLS = new Set<string>(["bash", "read", "edit", "write"] satisfies SupportedToolName[]);
const CODEMODE_TOOL_NAME = "codemode";
const CODEMODE_PREVIEW_LIMIT = 1000;
const YOLO_ENV_VAR = "PI_MINIMAL_PERMISSION_SYSTEM_YOLO";
// Set by hosts that run Pi without a person, such as an RPC host that cancels every dialog.
const NONINTERACTIVE_ENV_VAR = "PI_MINIMAL_PERMISSION_SYSTEM_NONINTERACTIVE";

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

function formatPolicySummary(result: PermissionCheckResult): string {
  if (result.matchedPattern === undefined) {
    return "Effective policy: built-in default ask (no matching rule).";
  }

  return `Effective policy: ${result.toolName}[${JSON.stringify(result.matchedPattern)}] = ${result.state}`;
}

function hardStop(): string {
  return "Hard stop: this permission denial is policy-enforced. Do not retry or investigate bypasses; report the block to the user.";
}

function formatDenyReason(result: PermissionCheckResult): string {
  if (result.toolName === "bash") {
    return `Permission denied for bash command '${result.command ?? ""}' by policy.\n${formatPolicySummary(result)}\n${hardStop()}`;
  }

  return `Permission denied for ${result.toolName} on '${result.path ?? ""}' by policy.\n${formatPolicySummary(result)}\n${hardStop()}`;
}

function formatAskPrompt(result: PermissionCheckResult): string {
  if (result.toolName === "bash") {
    return `Allow bash command '${result.command ?? ""}'?\n${formatPolicySummary(result)}`;
  }

  return `Allow ${result.toolName} on '${result.path ?? ""}'?\n${formatPolicySummary(result)}`;
}

function unavailableExplanation(): string {
  return "This non-interactive session cannot present the approval request for user review or approval. The operation is blocked.";
}

function formatUnavailableReason(result: PermissionCheckResult): string {
  const target = result.toolName === "bash"
    ? `Bash command '${result.command ?? ""}'`
    : `${result.toolName} on '${result.path ?? ""}'`;
  return `${target} requires approval, but no interactive UI is available.\n${unavailableExplanation()}\n${formatPolicySummary(result)}`;
}

function formatUserDeniedReason(result: PermissionCheckResult): string {
  if (result.toolName === "bash") {
    return `User denied bash command '${result.command ?? ""}'.\n${formatPolicySummary(result)}\n${hardStop()}`;
  }

  return `User denied ${result.toolName} on '${result.path ?? ""}'.\n${formatPolicySummary(result)}\n${hardStop()}`;
}

function formatCodemodeMatches(matches: readonly CodemodePermissionRule[], state: PermissionState): string {
  const rules = matches.map((rule) => {
    const role = rule.state === state ? "Decisive rule" : "Context rule";
    return `- ${role}: selector[${JSON.stringify(rule.selector)}] = ${rule.state}`;
  });
  return [`Effective codemode policy: ${state}`, ...rules].join("\n");
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
  canRequestApproval: boolean,
): Promise<ToolCallEventResult> {
  const check = checkCodemodeScript(event.input, policy.codemodeRules, policy.codemodeDiagnostics);
  if (check.kind === "block") {
    return { block: true, reason: `Codemode is blocked because its permission check failed:\n${check.reason}` };
  }

  if (check.state === "deny") {
    return {
      block: true,
      reason: `Codemode script denied by policy:\n${formatCodemodeMatches(check.matches, check.state)}\n${hardStop()}`,
    };
  }

  if (check.state !== "ask") {
    return {};
  }

  if (!canRequestApproval) {
    return {
      block: true,
      reason: `Codemode script requires approval, but no interactive UI is available.\n${unavailableExplanation()}\n${formatCodemodeMatches(check.matches, check.state)}`,
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
    formatCodemodeMatches(check.matches, check.state),
    formatCodemodePreview(code),
  ].join("\n\n");
  const approved = await ctx.ui.confirm("Codemode Permission Required", message, { signal });
  if (signal?.aborted) {
    return CANCELLED_BY_ABORT;
  }
  if (!approved) {
    return {
      block: true,
      reason: `User denied codemode script.\n${formatCodemodeMatches(check.matches, check.state)}\n${hardStop()}`,
    };
  }

  return {};
}

export default function minimalPermissionExtension(pi: ExtensionAPI): void {
  let yoloEnabled = false;
  let noninteractive = false;

  const canRequestApproval = (ctx: ExtensionContext): boolean => ctx.hasUI && !noninteractive;

  pi.registerFlag("yolo", {
    description: "Bypass permission checks enforced by pi-minimal-permission-system.",
    type: "boolean",
  });

  pi.registerFlag("no-yolo", {
    description: "Enforce permissions even when YOLO is inherited from the environment.",
    type: "boolean",
  });

  pi.registerCommand("yolo", {
    description: "Toggle permission checks enforced by pi-minimal-permission-system.",
    handler: async (_args, ctx) => {
      yoloEnabled = !yoloEnabled;
      process.env[YOLO_ENV_VAR] = yoloEnabled ? "1" : "0";
      ctx.ui.notify(`YOLO mode ${yoloEnabled ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const yoloFlag = pi.getFlag("yolo");
    if (pi.getFlag("no-yolo") === true) {
      yoloEnabled = false;
    } else if (typeof yoloFlag === "boolean") {
      yoloEnabled = yoloFlag;
    } else {
      yoloEnabled = process.env[YOLO_ENV_VAR] === "1";
    }
    process.env[YOLO_ENV_VAR] = yoloEnabled ? "1" : "0";
    noninteractive = process.env[NONINTERACTIVE_ENV_VAR] === "1";
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
      return enforceCodemode(event, ctx, policy, canRequestApproval(ctx));
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
      if (!canRequestApproval(ctx)) {
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
