import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

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
  options: { yoloFlag?: boolean } = {},
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
  if (options.yoloFlag === true) {
    flagValues.set("yolo", true);
  }

  minimalPermissionExtension({
    on(name: string, handler: MockEventHandler): void {
      eventHandlers[name] = handler;
    },
    registerCommand(name: string, commandOptions: { handler: MockSlashCommandHandler }): void {
      slashCommands[name] = commandOptions.handler;
    },
    registerFlag(name: string, flagOptions: { default?: boolean | string }): void {
      if (flagOptions.default !== undefined && !flagValues.has(name)) {
        flagValues.set(name, flagOptions.default);
      }
    },
    getFlag(name: string): boolean | string | undefined {
      return flagValues.get(name);
    },
  } as never);

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
  };
}

async function runToolCall(
  harness: Harness,
  event: Record<string, unknown>,
  options: MockContextOptions = {},
): Promise<Record<string, unknown>> {
  const result = await harness.toolCallHandler(
    event,
    createMockContext(harness.cwd, harness.prompts, harness.warnings, options),
  );
  return (result ?? {}) as Record<string, unknown>;
}

async function runSlashCommand(harness: Harness, name: string, args = ""): Promise<void> {
  const slashCommand = harness.slashCommands[name];
  assert.equal(typeof slashCommand, "function");
  await slashCommand(args, createMockContext(harness.cwd, harness.prompts, harness.warnings, { hasUI: true }));
}

const askToolCalls = [
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
