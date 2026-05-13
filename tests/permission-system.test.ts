import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
  await Promise.resolve(
    eventHandlers.session_start({ type: "session_start", reason: "startup" }, createMockContext(cwd, prompts, warnings)),
  );

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

function createMockContext(
  cwd: string,
  prompts: string[],
  warnings: string[],
  options: { hasUI?: boolean; confirmResult?: boolean } = {},
): Record<string, unknown> {
  return {
    cwd,
    hasUI: options.hasUI === true,
    ui: {
      notify(message: string, level: string): void {
        warnings.push(`${level}: ${message}`);
      },
      async confirm(_title: string, message: string): Promise<boolean> {
        prompts.push(message);
        return options.confirmResult ?? true;
      },
    },
  };
}

async function runToolCall(
  harness: Harness,
  event: Record<string, unknown>,
  options: { hasUI?: boolean; confirmResult?: boolean } = {},
): Promise<Record<string, unknown>> {
  const result = await Promise.resolve(
    harness.toolCallHandler(event, createMockContext(harness.cwd, harness.prompts, harness.warnings, options)),
  );
  return (result ?? {}) as Record<string, unknown>;
}

async function runSlashCommand(harness: Harness, name: string, args = ""): Promise<void> {
  const slashCommand = harness.slashCommands[name];
  assert.equal(typeof slashCommand, "function");
  await Promise.resolve(
    slashCommand(args, createMockContext(harness.cwd, harness.prompts, harness.warnings, { hasUI: true })),
  );
}

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

await runTest("tool_call prompts on ask with UI and blocks when user denies", async () => {
  const harness = await createHarness(`{"read": {".env": "ask"}}`, null);
  try {
    const result = await runToolCall(
      harness,
      { toolName: "read", input: { path: ".env" } },
      { hasUI: true, confirmResult: false },
    );

    assert.equal(result.block, true);
    assert.match(String(result.reason), /User denied read/);
    assert.equal(harness.prompts.length, 1);
    assert.match(harness.prompts[0], /\.env/);
  } finally {
    harness.cleanup();
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
  } finally {
    harness.cleanup();
  }
});

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
