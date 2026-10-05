import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createYoloSession, WRITTEN_CONTENT, YOLO_ENV } from "./fixtures/yolo-session.js";

type YoloSession = Awaited<ReturnType<typeof createYoloSession>>;
const execFileAsync = promisify(execFile);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  console.log(`ok - ${name}`);
}

async function withYoloSessions(
  verify: (context: { cwd: string; agentDir: string; start: (flags?: ReadonlyMap<string, boolean>) => Promise<YoloSession> }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pi-yolo-integration-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const savedEnvironment = new Map(["HOME", "PI_CODING_AGENT_DIR", YOLO_ENV].map((key) => [key, process.env[key]]));
  const sessions: YoloSession[] = [];

  try {
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "permissions.jsonc"), '{"write":{"**":"deny"}}', "utf8");
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env[YOLO_ENV];

    await verify({
      cwd,
      agentDir,
      start: async (flags) => {
        const created = await createYoloSession(cwd, agentDir, flags);
        sessions.push(created);
        return created;
      },
    });
  } finally {
    for (const created of sessions.reverse()) created.session.dispose();
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

async function expectWrite(created: YoloSession, cwd: string, filename: string, allowed: boolean): Promise<void> {
  const result = await created.write(filename);
  assert.equal(result.nestedCalls.length, 1);
  assert.equal(result.nestedCalls[0]!.toolName, "write");
  assert.ok(result.nestedCalls[0]!.parentToolCallId);
  assert.equal(existsSync(join(cwd, filename)), allowed);
  if (allowed) {
    assert.equal(readFileSync(join(cwd, filename), "utf8"), WRITTEN_CONTENT);
    assert.equal(result.isError, false);
    assert.match(result.text, /^Script completed\n/);
  } else {
    assert.equal(result.isError, true);
    assert.match(result.text, /Permission denied for write/);
    assert.ok(result.text.includes('Effective policy: write["**"] = deny'));
  }
}

await test("real sessions inherit YOLO without changing the enforcement of active sessions", async () => {
  await withYoloSessions(async ({ cwd, start }) => {
    const parent = await start();
    assert.equal(process.env[YOLO_ENV], "0");
    await parent.session.prompt("/yolo");
    assert.equal(process.env[YOLO_ENV], "1");
    await expectWrite(parent, cwd, "parent-on.txt", true);

    const enabledChild = await start();
    await expectWrite(enabledChild, cwd, "child-inherited-on.txt", true);
    await expectWrite(parent, cwd, "parent-after-child-start.txt", true);

    await parent.session.prompt("/yolo");
    assert.equal(process.env[YOLO_ENV], "0");
    await expectWrite(enabledChild, cwd, "child-after-parent-off.txt", true);
    await expectWrite(parent, cwd, "parent-off.txt", false);

    const disabledChild = await start();
    await expectWrite(disabledChild, cwd, "new-child-off.txt", false);
    await expectWrite(enabledChild, cwd, "enabled-child-after-off-child-start.txt", true);

    await parent.session.prompt("/yolo");
    assert.equal(process.env[YOLO_ENV], "1");
    await expectWrite(parent, cwd, "parent-reenabled.txt", true);
    await expectWrite(disabledChild, cwd, "disabled-child-after-parent-on.txt", false);

    const overriddenChild = await start(new Map([["no-yolo", true]]));
    assert.equal(process.env[YOLO_ENV], "0");
    await expectWrite(overriddenChild, cwd, "overridden-child-off.txt", false);
    await expectWrite(parent, cwd, "parent-after-off-child-start.txt", true);
  });
});

await test("real session flags override the environment and no-yolo wins when both are set", async () => {
  await withYoloSessions(async ({ cwd, start }) => {
    process.env[YOLO_ENV] = "0";
    const enabled = await start(new Map([["yolo", true]]));
    assert.equal(process.env[YOLO_ENV], "1");
    await expectWrite(enabled, cwd, "flag-enabled.txt", true);

    const disabled = await start(new Map([["no-yolo", true]]));
    assert.equal(process.env[YOLO_ENV], "0");
    await expectWrite(disabled, cwd, "flag-disabled.txt", false);
    await expectWrite(enabled, cwd, "enabled-after-disabled-flag.txt", true);

    process.env[YOLO_ENV] = "1";
    const both = await start(new Map([["yolo", true], ["no-yolo", true]]));
    assert.equal(process.env[YOLO_ENV], "0");
    await expectWrite(both, cwd, "both-flags.txt", false);
  });
});

await test("SDK subprocesses inherit the parent's published YOLO environment with normal enforcement when off", async () => {
  await withYoloSessions(async ({ cwd, agentDir, start }) => {
    const parent = await start();
    await parent.session.prompt("/yolo");
    assert.equal(process.env[YOLO_ENV], "1");

    for (const allowed of [true, false]) {
      if (!allowed) await parent.session.prompt("/yolo");
      const expectedYolo = allowed ? "1" : "0";
      assert.equal(process.env[YOLO_ENV], expectedYolo);
      const filename = allowed ? "subprocess-on.txt" : "subprocess-off.txt";
      const fixture = fileURLToPath(new URL("./fixtures/yolo-subprocess.ts", import.meta.url));
      const { stdout } = await execFileAsync(process.execPath, [
        "--import", import.meta.resolve("tsx"), fixture, cwd, agentDir, filename,
      ], {
        cwd,
        env: { ...process.env },
        timeout: 30_000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      });
      const report: unknown = JSON.parse(stdout.trim());
      assert.ok(isRecord(report));
      assert.equal(report.publishedYolo, expectedYolo);
      assert.equal(report.written, allowed);
      assert.equal(report.content, allowed ? WRITTEN_CONTENT : null);
      assert.equal(report.isError, !allowed);
      assert.ok(Array.isArray(report.nestedCalls));
      assert.equal(report.nestedCalls.length, 1);
      const nestedCall: unknown = report.nestedCalls[0];
      assert.ok(isRecord(nestedCall));
      assert.equal(nestedCall.toolName, "write");
      assert.ok(typeof nestedCall.parentToolCallId === "string" && nestedCall.parentToolCallId.length > 0);
      assert.ok(typeof report.text === "string");
      if (allowed) {
        assert.match(report.text, /^Script completed\n/);
        assert.equal(readFileSync(join(cwd, filename), "utf8"), WRITTEN_CONTENT);
      } else {
        assert.match(report.text, /Permission denied for write/);
        assert.ok(report.text.includes('Effective policy: write["**"] = deny'));
        assert.equal(existsSync(join(cwd, filename)), false);
      }
      assert.equal(process.env[YOLO_ENV], expectedYolo);
    }
  });
});
