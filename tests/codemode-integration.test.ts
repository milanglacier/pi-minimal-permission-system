import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

import minimalPermissionExtension from "../index.js";

const HARD_STOP = "Hard stop: this permission denial is policy-enforced. Do not retry or investigate bypasses; report the block to the user.";
const NO_UI_EXPLANATION = "This non-interactive session cannot present the approval request for user review or approval. The operation is blocked.";

type ObservedNestedCall = { toolName: string; parentToolCallId?: string };
type TestSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

type SessionOptions = {
  code: string | string[];
  globalConfig?: string;
  projectConfig?: string;
  approve?: (title: string, message: string) => boolean | Promise<boolean>;
};

function writeJsonc(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  console.log(`ok - ${name}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codemodeResultTexts(session: TestSession): string[] {
  const messages = session.messages.filter((entry) =>
    entry.role === "toolResult" && "toolName" in entry && entry.toolName === "codemode",
  );
  if (messages.length === 0) {
    throw new Error("The Pi session did not record a codemode result.");
  }

  return messages.map((message) => {
    if (!("content" in message) || !Array.isArray(message.content)) {
      throw new Error("A Pi codemode result did not contain content.");
    }
    return message.content.map((item: unknown) => {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return "";
      return item.text;
    }).join("\n");
  });
}

function codemodeResultText(session: TestSession): string {
  return codemodeResultTexts(session)[0]!;
}

async function withPiCodemodeSession(
  options: SessionOptions,
  verify: (context: {
    cwd: string;
    session: TestSession;
    nestedCalls: ObservedNestedCall[];
    approvals: string[];
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pi-codemode-integration-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const nestedCalls: ObservedNestedCall[] = [];
  const approvals: string[] = [];
  let session: TestSession | undefined;

  mkdirSync(cwd, { recursive: true });
  if (options.globalConfig !== undefined) {
    writeJsonc(join(agentDir, "permissions.jsonc"), options.globalConfig);
  }
  if (options.projectConfig !== undefined) {
    writeJsonc(join(cwd, ".pi", "agent", "permissions.jsonc"), options.projectConfig);
  }
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const faux = fauxProvider({ provider: "pi-codemode-test" });
    const codes = typeof options.code === "string" ? [options.code] : options.code;
    faux.setResponses([
      ...codes.map((code) => fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" })),
      fauxAssistantMessage("Finished."),
    ]);

    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const observeNestedCalls = (pi: ExtensionAPI): void => {
      pi.on("tool_call", (event) => {
        if (event.parentToolCallId) {
          nestedCalls.push({ toolName: event.toolName, parentToolCallId: event.parentToolCallId });
        }
      });
    };
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [createCodemodeExtension(), observeNestedCalls, minimalPermissionExtension],
    });
    await resourceLoader.reload();

    const created = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model: faux.getModel(),
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({
        defaultTools: ["+codemode"],
        defaultProjectTrust: "always",
        compaction: { enabled: false },
      }),
    });
    session = created.session;
    if (options.approve) {
      const uiContext = {
        confirm: async (title: string, message: string): Promise<boolean> => {
          approvals.push(`${title}\n${message}`);
          return options.approve!(title, message);
        },
      } as unknown as ExtensionUIContext;
      await session.bindExtensions({ uiContext, mode: "rpc" });
    } else {
      await session.bindExtensions({});
    }
    assert.ok(session.getActiveToolNames().includes("codemode"));

    await session.prompt("Run the supplied codemode script.");
    await verify({ cwd, session, nestedCalls, approvals });
  } finally {
    session?.dispose();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
}

await test("the real codemode pipeline blocks a script before its nested write executes", async () => {
  const code = 'await tools.write({ path: "blocked.txt", content: "must not be written" });';
  const selector = "CallExpression[callee.object.name='tools'][callee.property.name='write']";
  await withPiCodemodeSession({
    code,
    globalConfig: '{"write":{"**":"allow"},"codemode":{"Program":"allow"}}',
    projectConfig: JSON.stringify({ codemode: { [selector]: "deny" } }),
  }, async ({ cwd, nestedCalls, session }) => {
    assert.equal(existsSync(join(cwd, "blocked.txt")), false);
    assert.deepEqual(nestedCalls, []);
    const result = codemodeResultText(session);
    assert.match(result, /Codemode script denied by policy/);
    assert.match(result, /Effective codemode policy: deny/);
    assert.ok(result.includes(`- Decisive rule: selector[${JSON.stringify(selector)}] = deny`));
    assert.ok(result.includes('- Context rule: selector["Program"] = allow'));
    assert.ok(result.includes(HARD_STOP));
    assert.doesNotMatch(result, /global config|project config/);
  });
});

for (const noUI of [false, true]) {
  await test(`codemode ask ${noUI ? "without a UI" : "rejected by the user"} explains its rules in the model-facing result`, async () => {
    await withPiCodemodeSession({
      code: 'await tools.write({ path: "script-ask-blocked.txt", content: "blocked" });',
      globalConfig: '{"write":{"**":"allow"},"codemode":{"Program":"ask"}}',
      projectConfig: '{"codemode":{"CallExpression":"allow"}}',
      approve: noUI ? undefined : async () => false,
    }, async ({ cwd, session, nestedCalls, approvals }) => {
      assert.equal(existsSync(join(cwd, "script-ask-blocked.txt")), false);
      assert.deepEqual(nestedCalls, []);
      assert.equal(approvals.length, noUI ? 0 : 1);
      const result = codemodeResultText(session);
      assert.match(result, /Effective codemode policy: ask/);
      assert.ok(result.includes('- Decisive rule: selector["Program"] = ask'));
      assert.ok(result.includes('- Context rule: selector["CallExpression"] = allow'));
      assert.doesNotMatch(result, /global config|project config/);
      if (noUI) {
        assert.match(result, /requires approval, but no interactive UI is available/);
        assert.ok(result.includes(NO_UI_EXPLANATION));
        assert.doesNotMatch(result, /User denied|denied by policy/);
      } else {
        assert.match(result, /User denied codemode script/);
        assert.ok(result.includes(HARD_STOP));
        assert.ok(approvals[0]!.includes('- Decisive rule: selector["Program"] = ask'));
        assert.doesNotMatch(approvals[0]!, /global config|project config/);
      }
    });
  });
}

await test("syntax denies prevent direct eval inside dynamic-import options from executing", async () => {
  const marker = "import-options-executed";
  const code = `try {
    await import("missing", { with: { type: eval('text("${marker}"); "json"') } });
  } catch {}`;

  await withPiCodemodeSession({ code }, async ({ session }) => {
    assert.match(codemodeResultText(session), /^Script completed\n/);
    assert.match(codemodeResultText(session), new RegExp(marker));
  });

  await withPiCodemodeSession({
    code,
    projectConfig: JSON.stringify({ codemode: { "CallExpression[callee.name='eval']": "deny" } }),
  }, async ({ session, nestedCalls }) => {
    assert.match(codemodeResultText(session), /Codemode script denied by policy/);
    assert.doesNotMatch(codemodeResultText(session), new RegExp(marker));
    assert.deepEqual(nestedCalls, []);
  });
});

await test("invalid global pseudo-classes block every script despite a project allow", async () => {
  await withPiCodemodeSession({
    code: ["return 1;", "const a = 1; return a;"],
    globalConfig: '{"codemode":{"Identifier:unknown":"deny"}}',
    projectConfig: '{"codemode":{"Program":"allow"}}',
  }, async ({ session, nestedCalls }) => {
    const results = codemodeResultTexts(session);
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.match(result, /Invalid codemode selector 'Identifier:unknown'/);
      assert.match(result, /Unknown class name: unknown/);
      assert.doesNotMatch(result, /^Script completed\n/);
    }
    assert.deepEqual(nestedCalls, []);
  });
});

await test("Pi's codemode runtime accepts supported script-body syntax under Program allow", async () => {
  const codes = [
    ";",
    "// comment-only script",
    '// @options: {"timeout_ms": 1000}\n;',
    'return "return-ok";',
    'await Promise.resolve(); return "await-ok";',
    'async function work() { await Promise.resolve(); return "async-ok"; } return await work();',
    'const result = ({ value: "optional-ok" })?.value; return result;',
    'let result; for await (const value of [Promise.resolve("for-await-ok")]) { result = value; } return result;',
  ];
  await withPiCodemodeSession({
    code: codes,
    projectConfig: '{"codemode":{"Program":"allow"}}',
  }, async ({ session, nestedCalls }) => {
    const results = codemodeResultTexts(session);
    assert.equal(results.length, codes.length);
    for (const result of results) assert.match(result, /^Script completed\n/);
    assert.match(results[3]!, /return-ok/);
    assert.match(results[4]!, /await-ok/);
    assert.match(results[5]!, /async-ok/);
    assert.match(results[6]!, /optional-ok/);
    assert.match(results[7]!, /for-await-ok/);
    assert.deepEqual(nestedCalls, []);
  });
});

await test("Pi rejects blank source after the Program allow policy passes it", async () => {
  await withPiCodemodeSession({
    code: "",
    projectConfig: '{"codemode":{"Program":"allow"}}',
  }, async ({ session }) => {
    const result = codemodeResultText(session);
    assert.match(result, /Expected JavaScript source text \(non-empty\)/);
    assert.doesNotMatch(result, /Codemode script denied by policy/);
  });
});

await test("an allowed script still enforces global denies for computed parallel nested calls", async () => {
  const code = `
    const writer = tools["write"];
    const results = await Promise.allSettled([
      writer({ path: "parallel-a.txt", content: "blocked" }),
      writer({ path: "parallel-b.txt", content: "blocked" }),
    ]);
    let caught = false;
    try {
      await writer({ path: "caught.txt", content: "blocked" });
    } catch {
      caught = true;
    }
    text(JSON.stringify({ results: results.map((result) => result.status), caught }));
  `;
  await withPiCodemodeSession({
    code,
    globalConfig: '{"write":{"**":"deny"}}',
    projectConfig: '{"codemode":{"Program":"allow"}}',
  }, async ({ cwd, nestedCalls, session }) => {
    for (const name of ["parallel-a.txt", "parallel-b.txt", "caught.txt"]) {
      assert.equal(existsSync(join(cwd, name)), false);
    }
    assert.equal(nestedCalls.length, 3);
    assert.ok(nestedCalls.every((call) => call.toolName === "write" && call.parentToolCallId));
    assert.match(codemodeResultText(session), /\[\"rejected\",\"rejected\"\].*true/s);
  });
});

for (const scenario of [
  { name: "policy deny", writeState: "deny", noUI: false },
  { name: "rejected ask", writeState: "ask", noUI: false },
  { name: "ask without a UI", writeState: "ask", noUI: true },
  { name: "rejected default ask", writeState: undefined, noUI: false },
  { name: "default ask without a UI", writeState: undefined, noUI: true },
]) {
  for (const scriptState of scenario.noUI ? ["allow"] : ["allow", "ask"]) {
    await test(`an ${scriptState === "ask" ? "approved" : "allowed"} script reports nested write ${scenario.name} to the model`, async () => {
      await withPiCodemodeSession({
        code: 'await tools.write({ path: "nested-blocked.txt", content: "blocked" });',
        globalConfig: JSON.stringify({
          ...(scenario.writeState ? { write: { "**": scenario.writeState } } : {}),
          codemode: { Program: scriptState },
        }),
        approve: scenario.noUI ? undefined : async (title) => title === "Codemode Permission Required",
      }, async ({ cwd, nestedCalls, approvals, session }) => {
        assert.equal(existsSync(join(cwd, "nested-blocked.txt")), false);
        assert.equal(nestedCalls.length, 1);
        assert.equal(nestedCalls[0]!.toolName, "write");
        assert.ok(nestedCalls[0]!.parentToolCallId);
        const scriptApprovals = scriptState === "ask" ? 1 : 0;
        const writeApprovals = scenario.writeState !== "deny" && !scenario.noUI ? 1 : 0;
        assert.equal(approvals.length, scriptApprovals + writeApprovals);
        const result = codemodeResultText(session);
        const policy = scenario.writeState
          ? `Effective policy: write["**"] = ${scenario.writeState}`
          : "Effective policy: built-in default ask (no matching rule).";
        assert.ok(result.includes(policy), result);
        assert.doesNotMatch(result, /global config|project config/);
        if (scenario.writeState === "deny") {
          assert.match(result, /Permission denied for write/);
          assert.ok(result.includes(HARD_STOP));
        } else if (scenario.noUI) {
          assert.match(result, /requires approval, but no interactive UI is available/);
          assert.ok(result.includes(NO_UI_EXPLANATION));
          assert.doesNotMatch(result, /User denied|Permission denied/);
        } else {
          assert.match(result, /User denied write/);
          assert.ok(result.includes(HARD_STOP));
          assert.ok(approvals.at(-1)!.includes(policy));
        }
        if (scriptState === "ask") {
          assert.ok(approvals[0]!.includes('- Decisive rule: selector["Program"] = ask'));
        }
        for (const approval of approvals) {
          assert.doesNotMatch(approval, /global config|project config/);
        }
      });
    });
  }
}

await test("permitted nested writes succeed", async () => {
  await withPiCodemodeSession({
    code: 'await tools.write({ path: "permitted.txt", content: "written" });',
    globalConfig: '{"write":{"**":"allow"}}',
  }, async ({ cwd, nestedCalls }) => {
    assert.equal(readFileSync(join(cwd, "permitted.txt"), "utf8"), "written");
    assert.equal(nestedCalls.length, 1);
    assert.equal(nestedCalls[0]!.toolName, "write");
  });
});
