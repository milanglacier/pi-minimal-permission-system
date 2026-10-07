import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  BashToolCallEvent, EditToolCallEvent, ExtensionAPI, ExtensionContext,
  GrepToolCallEvent, ReadToolCallEvent, SessionStartEvent, ToolCallEvent, ToolCallEventResult, WriteToolCallEvent,
} from "@earendil-works/pi-coding-agent";

type ToolFixture =
  | Pick<BashToolCallEvent, "toolName" | "input">
  | Pick<ReadToolCallEvent, "toolName" | "input">
  | Pick<EditToolCallEvent, "toolName" | "input">
  | Pick<WriteToolCallEvent, "toolName" | "input">
  | Pick<GrepToolCallEvent, "toolName" | "input">
  | { toolName: "codemode"; input: Record<string, unknown> };

import minimalPermissionExtension from "../index.js";
import { getGlobalConfigPath, parsePermissionConfig, resolvePermissionRules } from "../src/config.js";
import { createPathMatchCandidates } from "../src/common.js";
import { compileRules, findLastGlobalMatch, findLastMatch } from "../src/matcher.js";
import type { PermissionRule } from "../src/types.js";

type TestFn = () => void | Promise<void>;

async function runTest(name: string, fn: TestFn): Promise<void> {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function withTempDir<T>(operation: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pi-minimal-permission-system-"));
  try {
    return operation(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeJsonc(path: string, content: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function getHomeConfigPath(home: string): string {
  return join(home, ".pi", "agent", "permissions.jsonc");
}

function getProjectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "agent", "permissions.jsonc");
}

function findEffectiveMatch(rules: PermissionRule[], toolName: PermissionRule["toolName"], values: string[]) {
  const compiled = compileRules(rules.filter((rule) => rule.toolName === toolName));
  const match = findLastMatch(compiled, values);
  if (match?.state !== "deny") {
    const globalMatch = findLastGlobalMatch(compiled, values);
    if (globalMatch?.state === "deny") {
      return globalMatch;
    }
  }
  return match;
}

type MockEventHandler = (
  event: SessionStartEvent | ToolCallEvent,
  ctx: Record<string, unknown>,
) => Promise<ToolCallEventResult | void> | ToolCallEventResult | void;

type MockSlashCommandHandler = (args: string, ctx: Record<string, unknown>) => Promise<void> | void;

type Harness = {
  home: string;
  cwd: string;
  toolCallHandler: MockEventHandler;
  slashCommands: Record<string, MockSlashCommandHandler>;
  prompts: string[];
  warnings: string[];
  cleanup(): void;
};

async function createHarness(
  globalConfig: string | null,
  projectConfig: string | null,
  options: {
    yoloFlag?: boolean; noYoloFlag?: boolean; yoloEnv?: string; inheritYoloEnv?: boolean; noninteractiveEnv?: string;
  } = {},
): Promise<Harness> {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-minimal-permission-system-runtime-"));
  const home = join(baseDir, "home");
  const cwd = join(baseDir, "project");
  const prompts: string[] = [];
  const warnings: string[] = [];
  const eventHandlers: Record<string, MockEventHandler> = {};
  const slashCommands: Record<string, MockSlashCommandHandler> = {};
  const flagValues = new Map<string, boolean | string>();
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalYoloEnv = process.env.PI_MINIMAL_PERMISSION_SYSTEM_YOLO;
  const originalNoninteractiveEnv = process.env.PI_MINIMAL_PERMISSION_SYSTEM_NONINTERACTIVE;

  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  if (globalConfig !== null) {
    writeJsonc(getHomeConfigPath(home), globalConfig);
  }

  if (projectConfig !== null) {
    writeJsonc(getProjectConfigPath(cwd), projectConfig);
  }

  process.env.HOME = home;
  delete process.env.PI_CODING_AGENT_DIR;
  if (!options.inheritYoloEnv) {
    if (options.yoloEnv === undefined) delete process.env.PI_MINIMAL_PERMISSION_SYSTEM_YOLO;
    else process.env.PI_MINIMAL_PERMISSION_SYSTEM_YOLO = options.yoloEnv;
  }
  if (options.noninteractiveEnv === undefined) delete process.env.PI_MINIMAL_PERMISSION_SYSTEM_NONINTERACTIVE;
  else process.env.PI_MINIMAL_PERMISSION_SYSTEM_NONINTERACTIVE = options.noninteractiveEnv;
  if (options.yoloFlag !== undefined) {
    flagValues.set("yolo", options.yoloFlag);
  }
  if (options.noYoloFlag !== undefined) {
    flagValues.set("no-yolo", options.noYoloFlag);
  }

  const api = {
    // This adapter stores the overloaded SDK callbacks for the partial runtime harness.
    on: ((name: string, handler: MockEventHandler): (() => void) => {
      eventHandlers[name] = handler;
      return () => {};
    }) as unknown as ExtensionAPI["on"],
    registerCommand(name, commandOptions): void {
      slashCommands[name] = commandOptions.handler as unknown as MockSlashCommandHandler;
    },
    registerFlag(name, flagOptions): void {
      if (flagOptions.default !== undefined && !flagValues.has(name)) {
        flagValues.set(name, flagOptions.default);
      }
    },
    getFlag(name: string): boolean | string | undefined {
      return flagValues.get(name);
    },
  } satisfies Pick<ExtensionAPI, "on" | "registerCommand" | "registerFlag" | "getFlag">;

  // The harness implements only the registration methods used by this extension.
  minimalPermissionExtension(api as ExtensionAPI);

  assert.equal(typeof eventHandlers.tool_call, "function");
  assert.equal(typeof eventHandlers.session_start, "function");
  await eventHandlers.session_start({ type: "session_start", reason: "startup" }, createMockContext(cwd, prompts, warnings));

  return {
    home,
    cwd,
    toolCallHandler: eventHandlers.tool_call,
    slashCommands,
    prompts,
    warnings,
    cleanup(): void {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      }
      if (originalYoloEnv === undefined) delete process.env.PI_MINIMAL_PERMISSION_SYSTEM_YOLO;
      else process.env.PI_MINIMAL_PERMISSION_SYSTEM_YOLO = originalYoloEnv;
      if (originalNoninteractiveEnv === undefined) delete process.env.PI_MINIMAL_PERMISSION_SYSTEM_NONINTERACTIVE;
      else process.env.PI_MINIMAL_PERMISSION_SYSTEM_NONINTERACTIVE = originalNoninteractiveEnv;
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

type Confirm = ExtensionContext["ui"]["confirm"];

type MockContextOptions = {
  hasUI?: boolean;
  confirm?: Confirm;
  signal?: AbortSignal;
};

function createDeferredConfirm() {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let reply: ((approved: boolean) => void) | undefined;
  let dialogOptions: Parameters<Confirm>[2];

  const confirm: Confirm = (_title, _message, options) => {
    dialogOptions = options;
    const signal = options?.signal;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (approved: boolean): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(approved);
      };
      const onAbort = (): void => {
        finish(false);
      };
      reply = finish;
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
      markStarted();
    });
  };

  return {
    confirm,
    started,
    get options() {
      return dialogOptions;
    },
    reply(approved: boolean): void {
      assert.ok(reply, "Confirmation must have started before replying");
      reply(approved);
    },
    cleanup(): void {
      reply?.(false);
    },
  };
}

async function within<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function assertPending(promise: Promise<unknown>, description: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      promise.then(() => "settled"),
      new Promise<"pending">((resolve) => {
        timer = setTimeout(() => resolve("pending"), 30);
      }),
    ]);
    assert.equal(outcome, "pending", description);
  } finally {
    clearTimeout(timer);
  }
}

async function cleanupPendingConfirmation(
  harness: Harness,
  dialog: ReturnType<typeof createDeferredConfirm>,
  pending: Promise<unknown>,
): Promise<void> {
  dialog.cleanup();
  try {
    await within(pending, "permission handler cleanup");
  } finally {
    harness.cleanup();
  }
}

function createMockContext(
  cwd: string,
  prompts: string[],
  warnings: string[],
  options: MockContextOptions = {},
): Record<string, unknown> {
  return {
    cwd,
    hasUI: options.hasUI === true,
    signal: options.signal,
    ui: {
      notify(message: string, level = "info"): void {
        warnings.push(`${level}: ${message}`);
      },
      confirm: (title, message, dialogOptions) => {
        prompts.push(message);
        return options.confirm?.(title, message, dialogOptions) ?? Promise.resolve(true);
      },
    } satisfies Pick<ExtensionContext["ui"], "notify" | "confirm">,
  } satisfies Pick<ExtensionContext, "cwd" | "hasUI" | "signal"> & {
    ui: Pick<ExtensionContext["ui"], "notify" | "confirm">;
  };
}

async function runToolCall(
  harness: Harness,
  event: ToolFixture,
  options: MockContextOptions = {},
): Promise<ToolCallEventResult> {
  const toolEvent: ToolCallEvent = { type: "tool_call", toolCallId: "test-call", ...event };
  const result = await harness.toolCallHandler(
    toolEvent,
    createMockContext(harness.cwd, harness.prompts, harness.warnings, options),
  );
  return result ?? {};
}

async function runSlashCommand(harness: Harness, name: string, args = ""): Promise<void> {
  const slashCommand = harness.slashCommands[name];
  assert.equal(typeof slashCommand, "function");
  await slashCommand(args, createMockContext(harness.cwd, harness.prompts, harness.warnings, { hasUI: true }));
}

const askToolCalls: ToolFixture[] = [
  { toolName: "bash", input: { command: "printf permission-test", timeout: 1 } },
  { toolName: "read", input: { path: "notes.txt" } },
  { toolName: "edit", input: { path: "notes.txt", edits: [{ oldText: "hello", newText: "goodbye" }] } },
  { toolName: "write", input: { path: "notes.txt", content: "hello" } },
];

for (const event of askToolCalls) {
  await runTest(`aborting an unanswered ${event.toolName} permission request blocks the tool`, async () => {
    const pattern = event.toolName === "bash" ? ".*" : "*";
    const harness = await createHarness(JSON.stringify({ [event.toolName]: { [pattern]: "ask" } }), null);
    const controller = new AbortController();
    const dialog = createDeferredConfirm();
    const pending = runToolCall(harness, event, {
      hasUI: true, signal: controller.signal, confirm: dialog.confirm,
    });
    try {
      await within(dialog.started, `${event.toolName} confirmation to open`);
      controller.abort();

      const result = await within(pending, "aborted permission request to settle");
      assert.equal(result.block, true);
      assert.match(String(result.reason), /cancelled.*aborted/i);
      assert.doesNotMatch(String(result.reason), /denied|policy-enforced|Hard stop/i);
    } finally {
      await cleanupPendingConfirmation(harness, dialog, pending);
    }
  });
}

for (const event of askToolCalls) {
  for (const outcome of ["deny", "refused", "no UI"] as const) {
    await runTest(`${event.toolName} ${outcome} explains the effective rule and blocking cause`, async () => {
      const pattern = event.toolName === "bash" ? "printf .*" : "**/*.txt";
      const state = outcome === "deny" ? "deny" : "ask";
      const harness = await createHarness(JSON.stringify({ [event.toolName]: { [pattern]: state } }), null);
      try {
        const result = await runToolCall(harness, event, {
          hasUI: outcome === "refused", confirm: async () => false,
        });
        const reason = String(result.reason);
        const summary = `Effective policy: ${event.toolName}[${JSON.stringify(pattern)}] = ${state}`;
        assert.equal(result.block, true);
        assert.ok(reason.includes(summary));
        assert.doesNotMatch(reason, /global config|project config/);
        if (outcome === "no UI") {
          assert.match(reason, /requires approval, but no interactive UI is available/);
          assert.match(reason, /non-interactive session cannot present the approval request for user review or approval/);
          assert.match(reason, /operation is blocked/);
          assert.doesNotMatch(reason, /User denied|denied by policy|Hard stop/);
        } else {
          assert.match(reason, outcome === "deny" ? /Permission denied.*policy/ : /User denied/);
          assert.match(reason, /Hard stop/);
        }
        if (outcome === "refused") {
          assert.ok(harness.prompts[0]!.includes(summary));
          assert.doesNotMatch(harness.prompts[0]!, /global config|project config/);
        }
      } finally {
        harness.cleanup();
      }
    });
  }
}

for (const event of askToolCalls.slice(0, 2)) {
  for (const hasUI of [true, false]) {
    await runTest(`unmatched ${event.toolName} ${hasUI ? "refusal" : "without UI"} explains built-in default ask`, async () => {
      const harness = await createHarness(null, null);
      try {
        const result = await runToolCall(harness, event, { hasUI, confirm: async () => false });
        assert.equal(result.block, true);
        assert.ok(String(result.reason).includes("Effective policy: built-in default ask (no matching rule)."));
        if (hasUI) {
          assert.ok(harness.prompts[0]!.includes("Effective policy: built-in default ask (no matching rule)."));
        }
      } finally {
        harness.cleanup();
      }
    });
  }
}

for (const protectDeny of [false, true]) {
  await runTest(`${protectDeny ? "protected deny" : "project override"} reports only the effective rule`, async () => {
    const harness = await createHarness(
      JSON.stringify({ bash: { "printf .*": protectDeny ? "deny" : "allow" } }),
      JSON.stringify({ bash: { "printf permission-test": "ask" } }),
    );
    try {
      const result = await runToolCall(harness, askToolCalls[0]!);
      const summary = String(result.reason).split("\n").find((line) => line.startsWith("Effective policy:"));
      assert.equal(summary, protectDeny
        ? 'Effective policy: bash["printf .*"] = deny'
        : 'Effective policy: bash["printf permission-test"] = ask');
    } finally {
      harness.cleanup();
    }
  });
}

await runTest("rule patterns use JSON escaping in approval prompts and rejection details", async () => {
  const pattern = 'printf|"quoted"\n\u001b';
  const harness = await createHarness(JSON.stringify({ bash: { [pattern]: "ask" } }), null);
  try {
    const result = await runToolCall(harness, askToolCalls[0]!, { hasUI: true, confirm: async () => false });
    const summary = `Effective policy: bash[${JSON.stringify(pattern)}] = ask`;
    for (const message of [String(result.reason), harness.prompts[0]!]) {
      assert.ok(message.includes(summary));
      assert.doesNotMatch(message, /\u001b/);
      assert.ok(message.includes('\\"quoted\\"\\n\\u001b'));
    }
  } finally {
    harness.cleanup();
  }
});

await runTest("cancellation wins when approval resolves just before the permission handler resumes", async () => {
  const harness = await createHarness(null, null);
  const controller = new AbortController();
  const dialog = createDeferredConfirm();
  const pending = runToolCall(
    harness,
    { toolName: "read", input: { path: "notes.txt" } },
    { hasUI: true, signal: controller.signal, confirm: dialog.confirm },
  );
  try {
    await within(dialog.started, "read confirmation to open");
    // Resolve approval, then abort in the same task before the awaiting handler can resume.
    dialog.reply(true);
    controller.abort();

    const result = await within(pending, "racing permission request to settle");
    assert.equal(result.block, true);
    assert.match(String(result.reason), /cancelled.*aborted/i);
    assert.doesNotMatch(String(result.reason), /denied|policy-enforced|Hard stop/i);
  } finally {
    await cleanupPendingConfirmation(harness, dialog, pending);
  }
});

await runTest("an already-aborted turn blocks an ask request without prompting for approval", async () => {
  const harness = await createHarness(null, null);
  const controller = new AbortController();
  controller.abort();
  const dialog = createDeferredConfirm();
  const pending = runToolCall(
    harness,
    { toolName: "write", input: { path: "notes.txt", content: "hello" } },
    { hasUI: true, signal: controller.signal, confirm: dialog.confirm },
  );
  try {
    const result = await within(pending, "already-aborted permission request to settle");
    assert.equal(result.block, true);
    assert.match(String(result.reason), /cancelled.*aborted/i);
    assert.equal(harness.prompts.length, 0);
  } finally {
    await cleanupPendingConfirmation(harness, dialog, pending);
  }
});

await runTest("an unmatched tool keeps waiting for explicit approval while its turn is active", async () => {
  const harness = await createHarness(null, null);
  const controller = new AbortController();
  const dialog = createDeferredConfirm();
  const pending = runToolCall(
    harness,
    { toolName: "read", input: { path: "notes.txt" } },
    { hasUI: true, signal: controller.signal, confirm: dialog.confirm },
  );
  try {
    await within(dialog.started, "default-ask confirmation to open");
    assert.equal(dialog.options?.timeout, undefined, "Permission approval must not have an arbitrary deadline");
    await assertPending(pending, "An unanswered confirmation must remain a valid wait while the turn is active");
    dialog.reply(true);

    assert.deepEqual(await within(pending, "approved permission request to settle"), {});
  } finally {
    await cleanupPendingConfirmation(harness, dialog, pending);
  }
});

await runTest("JSONC config parses supported tools and ignores unknown states", () => {
  const config = parsePermissionConfig(`{
    // comment
    "bash": { ".*": "ask", "git status": "allow", "bad": "sometimes" },
    "read": { "**/creds/*": "deny" },
    "mcp": { "*": "allow" }
  }`, "inline.jsonc");

  assert.deepEqual(config.bash, { ".*": "ask", "git status": "allow" });
  assert.deepEqual(config.read, { "**/creds/*": "deny" });
  assert.equal("mcp" in config, false);
});

await runTest("global config path defaults to permissions.jsonc in the Pi agent directory", () => {
  withTempDir((dir) => {
    const originalHome = process.env.HOME;
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.HOME = dir;
      delete process.env.PI_CODING_AGENT_DIR;

      assert.equal(getGlobalConfigPath(), join(dir, ".pi", "agent", "permissions.jsonc"));
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      }
    }
  });
});

await runTest("PI_CODING_AGENT_DIR replaces the default Pi agent directory", () => {
  withTempDir((dir) => {
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      const agentDir = join(dir, "custom-agent-dir");
      process.env.PI_CODING_AGENT_DIR = agentDir;

      assert.equal(getGlobalConfigPath(), join(agentDir, "permissions.jsonc"));
    } finally {
      if (originalAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      }
    }
  });
});

await runTest("bash rules use last declared match", () => {
  withTempDir((dir) => {
    const globalPath = join(dir, "permissions.jsonc");
    writeJsonc(globalPath, `{
      "bash": {
        ".*": "allow",
        "git .*": "ask",
        "git status": "allow",
        "rm -rf .*": "deny"
      }
    }`);

    const rules = resolvePermissionRules(globalPath, null);

    assert.equal(findEffectiveMatch(rules, "bash", ["git log"])?.state, "ask");
    assert.equal(findEffectiveMatch(rules, "bash", ["git status"])?.state, "allow");
    assert.equal(findEffectiveMatch(rules, "bash", ["rm -rf build"])?.state, "deny");
  });
});

await runTest("project rules cannot relax global deny", () => {
  withTempDir((dir) => {
    const globalPath = join(dir, "global.jsonc");
    const projectPath = join(dir, "project.jsonc");
    writeJsonc(globalPath, `{"bash": {"rm -rf .*": "deny"}}`);
    writeJsonc(projectPath, `{"bash": {"rm -rf build": "allow"}}`);

    const rules = resolvePermissionRules(globalPath, projectPath);
    const match = findEffectiveMatch(rules, "bash", ["rm -rf build"]);

    assert.equal(match?.state, "deny");
    assert.equal(match?.matchedPattern, "rm -rf .*");
  });
});

await runTest("global allow can override earlier global deny before project rules", () => {
  withTempDir((dir) => {
    const globalPath = join(dir, "global.jsonc");
    const projectPath = join(dir, "project.jsonc");
    writeJsonc(globalPath, `{
      "bash": {
        "git .*": "deny",
        "git status": "allow"
      }
    }`);
    writeJsonc(projectPath, `{"bash": {"git status": "allow"}}`);

    const rules = resolvePermissionRules(globalPath, projectPath);
    const match = findEffectiveMatch(rules, "bash", ["git status"]);

    assert.equal(match?.state, "allow");
    assert.equal(match?.matchedPattern, "git status");
  });
});

await runTest("bash regex rules match command substrings including slashes", () => {
  const rules: PermissionRule[] = [
    { toolName: "bash", pattern: ".*", state: "allow", layer: "global" },
    { toolName: "bash", pattern: "git status", state: "ask", layer: "global" },
    { toolName: "bash", pattern: "git push", state: "deny", layer: "global" },
  ];

  assert.equal(
    findEffectiveMatch(rules, "bash", ['find /home/milanglacier/.pi -name "permissions.jsonc" 2>/dev/null | head -5'])
      ?.state,
    "allow",
  );
  assert.equal(findEffectiveMatch(rules, "bash", ["echo git status"])?.state, "ask");
  assert.equal(findEffectiveMatch(rules, "bash", ["git status"])?.state, "ask");
  assert.equal(findEffectiveMatch(rules, "bash", ["cd xxx && git push origin master"])?.state, "deny");
});

await runTest("invalid bash regex rules do not match", () => {
  const rules: PermissionRule[] = [
    { toolName: "bash", pattern: "*", state: "allow", layer: "global" },
    { toolName: "bash", pattern: "git status", state: "ask", layer: "global" },
  ];

  assert.equal(findEffectiveMatch(rules, "bash", ["find /tmp -name file"])?.state, undefined);
  assert.equal(findEffectiveMatch(rules, "bash", ["git status"])?.state, "ask");
});

await runTest("file globs match cwd paths, external paths, dotfiles, and basenames", () => {
  const cwd = "/workspace/project";
  const rules: PermissionRule[] = [
    { toolName: "read", pattern: "**/creds/*", state: "deny", layer: "global" },
    { toolName: "read", pattern: ".env", state: "ask", layer: "global" },
  ];

  assert.equal(
    findEffectiveMatch(rules, "read", createPathMatchCandidates("/tmp/creds/token", cwd))?.state,
    "deny",
  );
  assert.equal(
    findEffectiveMatch(rules, "read", createPathMatchCandidates("services/creds/token", cwd))?.state,
    "deny",
  );
  assert.equal(
    findEffectiveMatch(rules, "read", createPathMatchCandidates("/workspace/project/.env", cwd))?.state,
    "ask",
  );
});

await runTest("tool_call allows supported tool when matching rule is allow", async () => {
  const harness = await createHarness(`{"bash": {"git status": "allow"}}`, null);
  try {
    const result = await runToolCall(harness, {
      toolName: "bash",
      input: { command: "git status" },
    });

    assert.deepEqual(result, {});
  } finally {
    harness.cleanup();
  }
});

await runTest("tool_call blocks deny and passes unsupported tools through", async () => {
  const harness = await createHarness(`{"bash": {"rm -rf .*": "deny"}}`, null);
  try {
    const denied = await runToolCall(harness, {
      toolName: "bash",
      input: { command: "rm -rf build" },
    });
    const unsupported = await runToolCall(harness, {
      toolName: "grep",
      input: { pattern: "needle" },
    });

    assert.equal(denied.block, true);
    assert.match(String(denied.reason), /rm -rf build/);
    assert.ok(String(denied.reason).includes('Effective policy: bash["rm -rf .*"] = deny'));
    assert.doesNotMatch(String(denied.reason), /global config|project config/);
    assert.match(String(denied.reason), /Hard stop/);
    assert.deepEqual(unsupported, {});
  } finally {
    harness.cleanup();
  }
});

await runTest("tool_call prompts on ask with UI and keeps an explicit denial distinct from cancellation", async () => {
  const harness = await createHarness(`{"read": {".env": "ask"}}`, null);
  const controller = new AbortController();
  const dialog = createDeferredConfirm();
  const pending = runToolCall(
    harness,
    { toolName: "read", input: { path: ".env" } },
    { hasUI: true, signal: controller.signal, confirm: dialog.confirm },
  );
  try {
    await within(dialog.started, "read confirmation to open");
    dialog.reply(false);

    const result = await within(pending, "denied permission request to settle");
    assert.equal(result.block, true);
    assert.match(String(result.reason), /User denied read/);
    assert.match(String(result.reason), /Hard stop/);
    assert.doesNotMatch(String(result.reason), /cancelled|aborted/i);
    assert.equal(controller.signal.aborted, false);
    assert.equal(harness.prompts.length, 1);
    assert.match(harness.prompts[0], /\.env/);
  } finally {
    await cleanupPendingConfirmation(harness, dialog, pending);
  }
});

await runTest("tool_call blocks ask when no UI is available", async () => {
  const harness = await createHarness(`{"write": {"*": "ask"}}`, null);
  try {
    const result = await runToolCall(harness, {
      toolName: "write",
      input: { path: "notes.txt", content: "hello" },
    });

    assert.equal(result.block, true);
    assert.match(String(result.reason), /requires approval, but no interactive UI is available/);
    assert.equal(harness.prompts.length, 0);
  } finally {
    harness.cleanup();
  }
});

await runTest("codemode allows by default when no codemode rules are configured", async () => {
  const harness = await createHarness(null, null);
  try {
    assert.deepEqual(await runToolCall(harness, { toolName: "codemode", input: {} }), {});
    assert.equal(harness.prompts.length, 0);
  } finally {
    harness.cleanup();
  }
});

await runTest("codemode deny rules block before execution and identify their decisive selector", async () => {
  const harness = await createHarness('{"codemode":{"DebuggerStatement":"deny"}}', null);
  try {
    const result = await runToolCall(harness, { toolName: "codemode", input: { code: "debugger;" } });
    assert.equal(result.block, true);
    assert.match(String(result.reason), /Effective codemode policy: deny/);
    assert.ok(String(result.reason).includes('- Decisive rule: selector["DebuggerStatement"] = deny'));
    assert.doesNotMatch(String(result.reason), /global config|project config/);
    assert.match(String(result.reason), /Hard stop/);
  } finally {
    harness.cleanup();
  }
});

await runTest("repeated approved codemode scripts each require a fresh confirmation", async () => {
  const harness = await createHarness('{"codemode":{"Program":"ask"}}', null);
  const script = { toolName: "codemode" as const, input: { code: "return 1;" } };
  try {
    assert.deepEqual(await runToolCall(harness, script, { hasUI: true, confirm: async () => true }), {});
    assert.deepEqual(await runToolCall(harness, script, { hasUI: true, confirm: async () => true }), {});
    assert.equal(harness.prompts.length, 2);
  } finally {
    harness.cleanup();
  }
});

await runTest("codemode ask prompts once with rule details and a bounded script preview", async () => {
  const harness = await createHarness('{"codemode":{"Program":"ask"}}', null);
  const code = `return 42;\n${"// preview\n".repeat(150)}`;
  try {
    const result = await runToolCall(
      harness,
      { toolName: "codemode", input: { code } },
      { hasUI: true },
    );
    assert.deepEqual(result, {});
    assert.equal(harness.prompts.length, 1);
    assert.match(harness.prompts[0]!, /Effective codemode policy: ask/);
    assert.ok(harness.prompts[0]!.includes('- Decisive rule: selector["Program"] = ask'));
    assert.doesNotMatch(harness.prompts[0]!, /global config|project config/);
    assert.match(harness.prompts[0]!, /Script preview \(truncated to 1000 of/);
  } finally {
    harness.cleanup();
  }
});

await runTest("refusing codemode approval returns an explicit denial", async () => {
  const harness = await createHarness('{"codemode":{"Program":"ask"}}', null);
  try {
    const result = await runToolCall(
      harness,
      { toolName: "codemode", input: { code: "return 1;" } },
      { hasUI: true, confirm: async () => false },
    );
    assert.equal(result.block, true);
    assert.match(String(result.reason), /User denied codemode script/);
    assert.match(String(result.reason), /Effective codemode policy: ask/);
    assert.ok(String(result.reason).includes('- Decisive rule: selector["Program"] = ask'));
    assert.doesNotMatch(String(result.reason), /global config|project config/);
    assert.match(String(result.reason), /Hard stop/);
    assert.doesNotMatch(String(result.reason), /cancelled|aborted/i);
  } finally {
    harness.cleanup();
  }
});

await runTest("cancellation wins when codemode approval races with an abort", async () => {
  const harness = await createHarness('{"codemode":{"Program":"ask"}}', null);
  const controller = new AbortController();
  const dialog = createDeferredConfirm();
  const pending = runToolCall(
    harness,
    { toolName: "codemode", input: { code: "return 1;" } },
    { hasUI: true, signal: controller.signal, confirm: dialog.confirm },
  );
  try {
    await within(dialog.started, "codemode confirmation to open");
    dialog.reply(true);
    controller.abort();
    const result = await within(pending, "racing codemode request to settle");
    assert.equal(result.block, true);
    assert.match(String(result.reason), /cancelled.*aborted/i);
  } finally {
    await cleanupPendingConfirmation(harness, dialog, pending);
  }
});

await runTest("codemode approval previews escape terminal control characters", async () => {
  const harness = await createHarness('{"codemode":{"Program":"ask"}}', null);
  const code = `// ${String.fromCharCode(27)}[31m\nreturn 1;`;
  try {
    const result = await runToolCall(
      harness,
      { toolName: "codemode", input: { code } },
      { hasUI: true },
    );
    assert.deepEqual(result, {});
    assert.doesNotMatch(harness.prompts[0]!, /\u001b/);
    assert.match(harness.prompts[0]!, /\\u001b\[31m/);
  } finally {
    harness.cleanup();
  }
});

await runTest("a pre-aborted codemode ask does not prompt", async () => {
  const harness = await createHarness('{"codemode":{"Program":"ask"}}', null);
  const controller = new AbortController();
  controller.abort();
  try {
    const result = await runToolCall(
      harness,
      { toolName: "codemode", input: { code: "return 1;" } },
      { hasUI: true, signal: controller.signal },
    );
    assert.equal(result.block, true);
    assert.match(String(result.reason), /cancelled.*aborted/i);
    assert.equal(harness.prompts.length, 0);
  } finally {
    harness.cleanup();
  }
});

await runTest("codemode ask fails closed when no interactive UI is available", async () => {
  const harness = await createHarness('{"codemode":{"Program":"ask"}}', null);
  try {
    const result = await runToolCall(harness, { toolName: "codemode", input: { code: "return 1;" } });
    assert.equal(result.block, true);
    assert.match(String(result.reason), /requires approval.*no interactive UI/i);
    assert.match(String(result.reason), /non-interactive session cannot present the approval request for user review or approval/);
    assert.match(String(result.reason), /operation is blocked/);
    assert.match(String(result.reason), /Effective codemode policy: ask/);
    assert.ok(String(result.reason).includes('- Decisive rule: selector["Program"] = ask'));
    assert.doesNotMatch(String(result.reason), /global config|project config|User denied|denied by policy|Hard stop/);
    assert.equal(harness.prompts.length, 0);
  } finally {
    harness.cleanup();
  }
});

function confirmMustNotOpen(): Confirm {
  return async () => {
    throw new Error("Approval dialog must not open");
  };
}

for (const event of askToolCalls) {
  await runTest(`${event.toolName} ask is blocked without a dialog when the host marks the session non-interactive`, async () => {
    const pattern = event.toolName === "bash" ? ".*" : "*";
    const harness = await createHarness(
      JSON.stringify({ [event.toolName]: { [pattern]: "ask" } }),
      null,
      { noninteractiveEnv: "1" },
    );
    try {
      const result = await runToolCall(harness, event, { hasUI: true, confirm: confirmMustNotOpen() });
      const reason = String(result.reason);
      assert.equal(result.block, true);
      assert.match(reason, /requires approval, but no interactive UI is available/);
      assert.match(reason, /non-interactive session cannot present the approval request/);
      assert.ok(reason.includes(`Effective policy: ${event.toolName}[${JSON.stringify(pattern)}] = ask`));
      assert.doesNotMatch(reason, /User denied|denied by policy|Hard stop/);
      assert.equal(harness.prompts.length, 0);
    } finally {
      harness.cleanup();
    }
  });
}

await runTest("codemode ask is blocked without a dialog when the host marks the session non-interactive", async () => {
  const harness = await createHarness('{"codemode":{"Program":"ask"}}', null, { noninteractiveEnv: "1" });
  try {
    const result = await runToolCall(
      harness,
      { toolName: "codemode", input: { code: "return 1;" } },
      { hasUI: true, confirm: confirmMustNotOpen() },
    );
    const reason = String(result.reason);
    assert.equal(result.block, true);
    assert.match(reason, /Codemode script requires approval, but no interactive UI is available/);
    assert.match(reason, /non-interactive session cannot present the approval request/);
    assert.ok(reason.includes('- Decisive rule: selector["Program"] = ask'));
    assert.doesNotMatch(reason, /User denied|denied by policy|Hard stop/);
    assert.equal(harness.prompts.length, 0);
  } finally {
    harness.cleanup();
  }
});

for (const noninteractiveEnv of [undefined, "0", "true", "", " 1 "]) {
  await runTest(`non-interactive environment ${JSON.stringify(noninteractiveEnv)} still opens approval dialogs`, async () => {
    const harness = await createHarness(
      '{"bash":{".*":"ask"},"codemode":{"Program":"ask"}}',
      null,
      { noninteractiveEnv },
    );
    try {
      assert.deepEqual(await runToolCall(harness, askToolCalls[0]!, { hasUI: true, confirm: async () => true }), {});
      assert.deepEqual(await runToolCall(
        harness,
        { toolName: "codemode", input: { code: "return 1;" } },
        { hasUI: true, confirm: async () => true },
      ), {});
      assert.equal(harness.prompts.length, 2);
      assert.equal(process.env.PI_MINIMAL_PERMISSION_SYSTEM_NONINTERACTIVE, noninteractiveEnv);
    } finally {
      harness.cleanup();
    }
  });
}

await runTest("non-interactive sessions keep allow and deny decisions unchanged", async () => {
  const harness = await createHarness(
    '{"bash":{"git status":"allow","rm -rf .*":"deny"},"codemode":{"DebuggerStatement":"deny"}}',
    null,
    { noninteractiveEnv: "1" },
  );
  try {
    const options = { hasUI: true, confirm: confirmMustNotOpen() };
    assert.deepEqual(await runToolCall(harness, { toolName: "bash", input: { command: "git status" } }, options), {});
    assert.deepEqual(await runToolCall(harness, { toolName: "codemode", input: { code: "return 1;" } }, options), {});

    const denied = await runToolCall(harness, { toolName: "bash", input: { command: "rm -rf build" } }, options);
    assert.equal(denied.block, true);
    assert.match(String(denied.reason), /Permission denied for bash command 'rm -rf build' by policy/);
    assert.match(String(denied.reason), /Hard stop/);

    const deniedScript = await runToolCall(harness, { toolName: "codemode", input: { code: "debugger;" } }, options);
    assert.equal(deniedScript.block, true);
    assert.match(String(deniedScript.reason), /Codemode script denied by policy/);
    assert.equal(harness.prompts.length, 0);
  } finally {
    harness.cleanup();
  }
});

await runTest("YOLO bypasses ask rules in a non-interactive session", async () => {
  const harness = await createHarness(
    '{"bash":{".*":"ask"},"codemode":{"Program":"ask"}}',
    null,
    { yoloFlag: true, noninteractiveEnv: "1" },
  );
  try {
    const options = { hasUI: true, confirm: confirmMustNotOpen() };
    assert.deepEqual(await runToolCall(harness, askToolCalls[0]!, options), {});
    assert.deepEqual(await runToolCall(harness, { toolName: "codemode", input: { code: "return 1;" } }, options), {});
    assert.equal(harness.prompts.length, 0);
  } finally {
    harness.cleanup();
  }
});

for (const initial of [undefined, "1"]) {
  await runTest(`a running session keeps the non-interactive setting it read at startup (${JSON.stringify(initial)})`, async () => {
    const harness = await createHarness('{"bash":{".*":"ask"}}', null, { noninteractiveEnv: initial });
    try {
      if (initial === undefined) process.env.PI_MINIMAL_PERMISSION_SYSTEM_NONINTERACTIVE = "1";
      else delete process.env.PI_MINIMAL_PERMISSION_SYSTEM_NONINTERACTIVE;

      const result = await runToolCall(harness, askToolCalls[0]!, { hasUI: true, confirm: async () => true });
      if (initial === undefined) {
        assert.deepEqual(result, {});
        assert.equal(harness.prompts.length, 1);
      } else {
        assert.equal(result.block, true);
        assert.match(String(result.reason), /no interactive UI is available/);
        assert.equal(harness.prompts.length, 0);
      }
    } finally {
      harness.cleanup();
    }
  });
}

for (const state of ["ask", "deny"] as const) {
  await runTest(`codemode ${state} distinguishes decisive matches from context across layers`, async () => {
    const harness = await createHarness(
      '{"codemode":{"Program":"allow","DebuggerStatement":"ask"}}',
      JSON.stringify({ codemode: { ReturnStatement: state } }),
    );
    try {
      const result = await runToolCall(
        harness,
        { toolName: "codemode", input: { code: "debugger; return 1;" } },
        { hasUI: true, confirm: async () => false },
      );
      assert.equal(result.block, true);
      const reason = String(result.reason);
      const summary = [
        `Effective codemode policy: ${state}`,
        '- Context rule: selector["Program"] = allow',
        `- ${state === "ask" ? "Decisive" : "Context"} rule: selector["DebuggerStatement"] = ask`,
        `- Decisive rule: selector["ReturnStatement"] = ${state}`,
      ].join("\n");
      assert.ok(reason.includes(summary));
      assert.doesNotMatch(reason, /global config|project config/);
      if (state === "ask") assert.ok(harness.prompts[0]!.includes(summary));
    } finally {
      harness.cleanup();
    }
  });
}

await runTest("codemode selectors use JSON escaping in approval prompts and rejection details", async () => {
  const selector = `Program,\n Identifier[name='"\u001b']`;
  const harness = await createHarness(JSON.stringify({ codemode: { [selector]: "ask" } }), null);
  try {
    const result = await runToolCall(
      harness,
      { toolName: "codemode", input: { code: "return 1;" } },
      { hasUI: true, confirm: async () => false },
    );
    assert.equal(result.block, true);
    const summary = `- Decisive rule: selector[${JSON.stringify(selector)}] = ask`;
    for (const message of [String(result.reason), harness.prompts[0]!]) {
      assert.ok(message.includes(summary));
      assert.doesNotMatch(message, /\u001b/);
      assert.ok(message.includes("\\n"));
      assert.ok(message.includes('\\"\\u001b'));
    }
  } finally {
    harness.cleanup();
  }
});

await runTest("codemode policy cache recovers after a config is fixed or removed", async () => {
  const harness = await createHarness('{"codemode":{"DebuggerStatement":"invalid"}}', null);
  const configPath = getHomeConfigPath(harness.home);
  const script = { toolName: "codemode" as const, input: { code: "debugger;" } };
  try {
    assert.equal((await runToolCall(harness, script)).block, true);

    writeJsonc(configPath, '{"codemode":{"DebuggerStatement":"allow"}}');
    assert.deepEqual(await runToolCall(harness, script), {});

    writeJsonc(configPath, '{"codemode":{"DebuggerStatement":"deny"}}');
    assert.equal((await runToolCall(harness, script)).block, true);

    rmSync(configPath);
    assert.deepEqual(await runToolCall(harness, script), {});

    mkdirSync(configPath);
    assert.equal((await runToolCall(harness, script)).block, true);
    rmSync(configPath, { recursive: true });
    assert.deepEqual(await runToolCall(harness, script), {});
  } finally {
    harness.cleanup();
  }
});

await runTest("atomic config replacement invalidates cache with unchanged mtime and size", async () => {
  const harness = await createHarness('{"codemode":{"DebuggerStatement":"deny"}}', null);
  const configPath = getHomeConfigPath(harness.home);
  const replacementPath = `${configPath}.replacement`;
  const script = { toolName: "codemode" as const, input: { code: "debugger;" } };
  try {
    const fixedTime = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(configPath, fixedTime, fixedTime);
    assert.equal((await runToolCall(harness, script)).block, true);
    const originalStat = statSync(configPath);
    writeJsonc(replacementPath, '{"codemode":{"DebuggerStatement":"ask" }}');
    utimesSync(replacementPath, originalStat.atime, originalStat.mtime);
    assert.equal(statSync(replacementPath).size, originalStat.size);
    assert.equal(statSync(replacementPath).mtimeMs, originalStat.mtimeMs);

    renameSync(replacementPath, configPath);
    assert.deepEqual(
      await runToolCall(harness, script, { hasUI: true, confirm: async () => true }),
      {},
    );
    assert.equal(harness.prompts.length, 1);
  } finally {
    harness.cleanup();
  }
});

await runTest("YOLO bypasses codemode policy validation and prompts", async () => {
  const harness = await createHarness('{"codemode":{"DebuggerStatement":"invalid"}}', null, { yoloFlag: true });
  try {
    assert.deepEqual(await runToolCall(harness, {
      toolName: "codemode",
      input: { code: "debugger;" },
    }), {});
    assert.equal(harness.prompts.length, 0);
  } finally {
    harness.cleanup();
  }
});

await runTest("toggling YOLO restores codemode enforcement when disabled again", async () => {
  const harness = await createHarness('{"codemode":{"DebuggerStatement":"deny"}}', null);
  const script = { toolName: "codemode" as const, input: { code: "debugger;" } };
  try {
    assert.equal((await runToolCall(harness, script)).block, true);
    await runSlashCommand(harness, "yolo");
    assert.deepEqual(await runToolCall(harness, script), {});
    await runSlashCommand(harness, "yolo");
    assert.equal((await runToolCall(harness, script)).block, true);
  } finally {
    harness.cleanup();
  }
});

await runTest("changing cwd reloads project codemode policy", async () => {
  const harness = await createHarness(null, '{"codemode":{"DebuggerStatement":"allow"}}');
  const otherCwd = join(harness.cwd, "other-project");
  mkdirSync(otherCwd, { recursive: true });
  writeJsonc(getProjectConfigPath(otherCwd), '{"codemode":{"DebuggerStatement":"deny"}}');
  const event = {
    type: "tool_call" as const,
    toolCallId: "cwd-change",
    toolName: "codemode" as const,
    input: { code: "debugger;" },
  };
  try {
    assert.deepEqual(await runToolCall(harness, event), {});
    const result = await harness.toolCallHandler(
      event,
      createMockContext(otherCwd, harness.prompts, harness.warnings),
    );
    assert.equal(result?.block, true);
    assert.ok(String(result?.reason).includes('- Decisive rule: selector["DebuggerStatement"] = deny'));
    assert.doesNotMatch(String(result?.reason), /global config|project config/);
  } finally {
    harness.cleanup();
  }
});

await runTest("aborting a codemode approval blocks execution with cancellation rather than denial", async () => {
  const harness = await createHarness('{"codemode":{"Program":"ask"}}', null);
  const controller = new AbortController();
  const dialog = createDeferredConfirm();
  const pending = runToolCall(
    harness,
    { toolName: "codemode", input: { code: "return 1;" } },
    { hasUI: true, signal: controller.signal, confirm: dialog.confirm },
  );
  try {
    await within(dialog.started, "codemode confirmation to open");
    controller.abort();
    const result = await within(pending, "codemode permission request to cancel");
    assert.equal(result.block, true);
    assert.match(String(result.reason), /cancelled.*aborted/i);
    assert.doesNotMatch(String(result.reason), /User denied|Hard stop/i);
  } finally {
    await cleanupPendingConfirmation(harness, dialog, pending);
  }
});

for (const mode of ["--yolo", "/yolo"]) {
  await runTest(`${mode} enabled before preflight bypasses ask without requesting approval`, async () => {
    const harness = await createHarness(null, null, { yoloFlag: mode === "--yolo" });
    const controller = new AbortController();
    const dialog = createDeferredConfirm();
    let pending: Promise<unknown> = Promise.resolve();
    try {
      if (mode === "/yolo") {
        await runSlashCommand(harness, "yolo");
      }
      pending = runToolCall(
        harness,
        { toolName: "bash", input: { command: "printf permission-test" } },
        { hasUI: true, signal: controller.signal, confirm: dialog.confirm },
      );

      assert.deepEqual(await within(pending, "YOLO preflight to settle"), {});
      assert.equal(harness.prompts.length, 0);
    } finally {
      await cleanupPendingConfirmation(harness, dialog, pending);
    }
  });
}

for (const yoloEnv of [undefined, "0", "1", "", "false", "true", " 1 "]) {
  for (const scenario of [
    { name: "no flags", flags: {}, enabled: yoloEnv === "1" },
    { name: "--yolo", flags: { yoloFlag: true }, enabled: true },
    { name: "--no-yolo", flags: { noYoloFlag: true }, enabled: false },
    { name: "both flags", flags: { yoloFlag: true, noYoloFlag: true }, enabled: false },
    { name: "explicit false yolo", flags: { yoloFlag: false }, enabled: false },
    { name: "false no-yolo", flags: { noYoloFlag: false }, enabled: yoloEnv === "1" },
  ]) {
    await runTest(`${scenario.name} with YOLO environment ${JSON.stringify(yoloEnv)} ${scenario.enabled ? "bypasses" : "enforces"} permissions`, async () => {
      const harness = await createHarness(JSON.stringify({
        bash: { ".*": "deny" },
        read: { "**": "deny" },
        edit: { "**": "deny" },
        write: { "**": "deny" },
        codemode: { DebuggerStatement: "invalid" },
      }), null, { ...scenario.flags, yoloEnv });
      try {
        assert.equal(process.env.PI_MINIMAL_PERMISSION_SYSTEM_YOLO, scenario.enabled ? "1" : "0");
        for (const event of [...askToolCalls, { toolName: "codemode" as const, input: { code: "debugger;" } }]) {
          const result = await runToolCall(harness, event);
          if (scenario.enabled) assert.deepEqual(result, {});
          else assert.equal(result.block, true);
        }
        assert.equal(harness.prompts.length, 0);
      } finally {
        harness.cleanup();
      }
    });
  }
}

await runTest("starting an explicitly normal child cannot disable its running YOLO parent", async () => {
  const sessions: Harness[] = [];
  const policy = '{"bash":{".*":"deny"}}';
  try {
    const parent = await createHarness(null, policy, { yoloFlag: true });
    sessions.push(parent);
    const child = await createHarness(null, policy, { noYoloFlag: true, inheritYoloEnv: true });
    sessions.push(child);
    assert.equal((await runToolCall(child, askToolCalls[0]!)).block, true);
    assert.deepEqual(await runToolCall(parent, askToolCalls[0]!), {});
    assert.equal(process.env.PI_MINIMAL_PERMISSION_SYSTEM_YOLO, "0");
    const laterChild = await createHarness(null, policy, { inheritYoloEnv: true });
    sessions.push(laterChild);
    assert.equal((await runToolCall(laterChild, askToolCalls[0]!)).block, true);
    assert.deepEqual(await runToolCall(parent, askToolCalls[0]!), {});
  } finally {
    for (const session of sessions.reverse()) session.cleanup();
  }
});

for (const initiallyEnabled of [true, false]) {
  await runTest(`turning parent YOLO ${initiallyEnabled ? "off" : "on"} changes future children but not an already-running child`, async () => {
    const sessions: Harness[] = [];
    const policy = '{"bash":{".*":"deny"}}';
    try {
      const parent = await createHarness(null, policy, { yoloFlag: initiallyEnabled });
      sessions.push(parent);
      assert.equal(process.env.PI_MINIMAL_PERMISSION_SYSTEM_YOLO, initiallyEnabled ? "1" : "0");
      const child = await createHarness(null, policy, { inheritYoloEnv: true });
      sessions.push(child);
      assert.equal((await runToolCall(child, askToolCalls[0]!)).block === true, !initiallyEnabled);
      assert.equal((await runToolCall(parent, askToolCalls[0]!)).block === true, !initiallyEnabled);

      await runSlashCommand(parent, "yolo");
      assert.equal(process.env.PI_MINIMAL_PERMISSION_SYSTEM_YOLO, initiallyEnabled ? "0" : "1");
      assert.equal((await runToolCall(parent, askToolCalls[0]!)).block === true, initiallyEnabled);
      assert.equal((await runToolCall(child, askToolCalls[0]!)).block === true, !initiallyEnabled);
      const laterChild = await createHarness(null, policy, { inheritYoloEnv: true });
      sessions.push(laterChild);
      assert.equal((await runToolCall(laterChild, askToolCalls[0]!)).block === true, initiallyEnabled);
      assert.equal((await runToolCall(child, askToolCalls[0]!)).block === true, !initiallyEnabled);
    } finally {
      for (const session of sessions.reverse()) session.cleanup();
    }
  });
}

await runTest("--yolo bypasses permission checks including global deny rules", async () => {
  const harness = await createHarness(`{"bash": {"rm -rf .*": "deny"}}`, null, { yoloFlag: true });
  try {
    const result = await runToolCall(harness, {
      toolName: "bash",
      input: { command: "rm -rf build" },
    });

    assert.deepEqual(result, {});
  } finally {
    harness.cleanup();
  }
});

await runTest("enabling YOLO does not approve a pending request, which remains cancellable", async () => {
  const harness = await createHarness(null, null);
  const controller = new AbortController();
  const dialog = createDeferredConfirm();
  const pending = runToolCall(
    harness,
    { toolName: "bash", input: { command: "printf waiting-for-approval" } },
    { hasUI: true, signal: controller.signal, confirm: dialog.confirm },
  );
  try {
    await within(dialog.started, "bash confirmation to open");
    await runSlashCommand(harness, "yolo");
    await assertPending(pending, "Enabling YOLO must not approve a request that was already waiting");

    const nextPreflight = await within(runToolCall(
      harness,
      { toolName: "read", input: { path: "notes.txt" } },
      { hasUI: true, signal: controller.signal },
    ), "later YOLO preflight to settle");
    assert.deepEqual(nextPreflight, {});
    assert.equal(harness.prompts.length, 1);

    controller.abort();
    const result = await within(pending, "permission request to cancel after enabling YOLO");
    assert.equal(result.block, true);
    assert.match(String(result.reason), /cancelled.*aborted/i);
  } finally {
    await cleanupPendingConfirmation(harness, dialog, pending);
  }
});

await runTest("/yolo toggles permission checks for the current session", async () => {
  const harness = await createHarness(`{"bash": {"rm -rf .*": "deny"}}`, null);
  try {
    const deniedBeforeToggle = await runToolCall(harness, {
      toolName: "bash",
      input: { command: "rm -rf build" },
    });
    assert.equal(deniedBeforeToggle.block, true);

    await runSlashCommand(harness, "yolo");
    const allowedWhileEnabled = await runToolCall(harness, {
      toolName: "bash",
      input: { command: "rm -rf build" },
    });
    assert.deepEqual(allowedWhileEnabled, {});

    await runSlashCommand(harness, "yolo");
    const deniedAfterToggle = await runToolCall(harness, {
      toolName: "bash",
      input: { command: "rm -rf build" },
    });
    assert.equal(deniedAfterToggle.block, true);

    assert.deepEqual(harness.warnings, ["info: YOLO mode enabled", "info: YOLO mode disabled"]);
  } finally {
    harness.cleanup();
  }
});
