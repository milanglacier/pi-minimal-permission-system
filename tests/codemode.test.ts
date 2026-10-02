import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveCachedPolicy } from "../src/config.js";
import { checkCodemodeScript } from "../src/codemode.js";

const tests: Array<{ name: string; run: () => void }> = [];

function test(name: string, run: () => void): void {
  tests.push({ name, run });
}

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pi-codemode-permissions-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeConfig(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

test("comments and strings do not match call-expression selectors", () => {
  withTempDir((dir) => {
    const path = join(dir, "permissions.jsonc");
    writeConfig(path, '{"codemode":{"CallExpression[callee.name=\\"eval\\"]":"deny"}}');
    const policy = resolveCachedPolicy(path, null);

    const result = checkCodemodeScript(
      { code: `// eval("comment")\nconst text = 'eval("string")';` },
      policy.codemodeRules,
      policy.codemodeDiagnostics,
    );

    assert.deepEqual(result, { kind: "decision", state: "allow", matches: [] });
  });
});

test("missing and empty codemode policies allow without requiring a script input", () => {
  withTempDir((dir) => {
    const missing = resolveCachedPolicy(join(dir, "missing.jsonc"), null);
    assert.deepEqual(checkCodemodeScript(null, missing.codemodeRules, missing.codemodeDiagnostics), {
      kind: "decision", state: "allow", matches: [],
    });

    const path = join(dir, "permissions.jsonc");
    writeConfig(path, '{"codemode":{}}');
    const empty = resolveCachedPolicy(path, null);
    assert.deepEqual(checkCodemodeScript({}, empty.codemodeRules, empty.codemodeDiagnostics), {
      kind: "decision", state: "allow", matches: [],
    });
  });
});

test("codemode keeps global and project rules separate and global deny wins over project allow", () => {
  withTempDir((dir) => {
    const globalPath = join(dir, "global.jsonc");
    const projectPath = join(dir, "project.jsonc");
    writeConfig(globalPath, '{"codemode":{"DebuggerStatement":"deny"}}');
    writeConfig(projectPath, '{"codemode":{"DebuggerStatement":"allow"}}');
    const policy = resolveCachedPolicy(globalPath, projectPath);

    const result = checkCodemodeScript({ code: "debugger;" }, policy.codemodeRules, policy.codemodeDiagnostics);
    assert.equal(policy.codemodeRules.length, 2);
    assert.deepEqual(policy.codemodeRules.map((rule) => rule.layer), ["global", "project"]);
    assert.equal(result.kind, "decision");
    if (result.kind === "decision") assert.equal(result.state, "deny");
  });
});

test("project deny overrides a matching global allow", () => {
  withTempDir((dir) => {
    const globalPath = join(dir, "global.jsonc");
    const projectPath = join(dir, "project.jsonc");
    writeConfig(globalPath, '{"codemode":{"DebuggerStatement":"allow"}}');
    writeConfig(projectPath, '{"codemode":{"DebuggerStatement":"deny"}}');
    const policy = resolveCachedPolicy(globalPath, projectPath);
    const result = checkCodemodeScript({ code: "debugger;" }, policy.codemodeRules, policy.codemodeDiagnostics);

    assert.equal(result.kind, "decision");
    if (result.kind === "decision") assert.equal(result.state, "deny");
  });
});

test("an identical global Program ask remains effective over project Program allow", () => {
  withTempDir((dir) => {
    const globalPath = join(dir, "global.jsonc");
    const projectPath = join(dir, "project.jsonc");
    writeConfig(globalPath, '{"codemode":{"Program":"ask"}}');
    writeConfig(projectPath, '{"codemode":{"Program":"allow"}}');
    const policy = resolveCachedPolicy(globalPath, projectPath);
    const result = checkCodemodeScript({ code: "return 1;" }, policy.codemodeRules, policy.codemodeDiagnostics);

    assert.equal(result.kind, "decision");
    if (result.kind === "decision") {
      assert.equal(result.state, "ask");
      assert.deepEqual(result.matches.map((rule) => [rule.layer, rule.selector, rule.state]), [
        ["global", "Program", "ask"],
        ["project", "Program", "allow"],
      ]);
    }
  });
});

test("ask takes precedence over allow in either declaration order", () => {
  withTempDir((dir) => {
    for (const selectors of [
      { Program: "ask", DebuggerStatement: "allow" },
      { DebuggerStatement: "allow", Program: "ask" },
    ]) {
      const path = join(dir, "permissions.jsonc");
      writeConfig(path, JSON.stringify({ codemode: selectors }));
      const policy = resolveCachedPolicy(path, null);
      const result = checkCodemodeScript({ code: "debugger;" }, policy.codemodeRules, policy.codemodeDiagnostics);
      assert.equal(result.kind, "decision");
      if (result.kind === "decision") assert.equal(result.state, "ask");
    }
  });
});

test("deny, ask, and allow precedence holds for all six declaration permutations", () => {
  withTempDir((dir) => {
    const deny = ["DebuggerStatement", "deny"] as const;
    const ask = ["Program", "ask"] as const;
    const allow = ["*", "allow"] as const;
    const permutations = [
      [deny, ask, allow],
      [deny, allow, ask],
      [ask, deny, allow],
      [ask, allow, deny],
      [allow, deny, ask],
      [allow, ask, deny],
    ];

    for (const [index, entries] of permutations.entries()) {
      const path = join(dir, `permissions-${index}.jsonc`);
      writeConfig(path, JSON.stringify({ codemode: Object.fromEntries(entries) }));
      const policy = resolveCachedPolicy(path, null);
      const result = checkCodemodeScript({ code: "debugger;" }, policy.codemodeRules, policy.codemodeDiagnostics);
      assert.equal(result.kind, "decision");
      if (result.kind === "decision") assert.equal(result.state, "deny");
    }
  });
});

test("invalid codemode sections, states, top-level shapes, malformed JSONC, and read failures block", () => {
  withTempDir((dir) => {
    const invalidDocuments = [
      "null",
      "[]",
      "false",
      "42",
      '"not-a-config-object"',
      '{"codemode":null}',
      '{"codemode":[]}',
      '{"codemode":false}',
      '{"codemode":0}',
      '{"codemode":"not-an-object"}',
      '{"codemode":{"DebuggerStatement":"sometimes"}}',
      '{"codemode":{"":"ask"}}',
      '{"codemode":{"DebuggerStatement":"deny"',
    ];

    for (const [index, document] of invalidDocuments.entries()) {
      const path = join(dir, `invalid-${index}.jsonc`);
      writeConfig(path, document);
      const policy = resolveCachedPolicy(path, null);
      assert.ok(policy.codemodeDiagnostics.length > 0, `Expected '${document}' to be rejected`);
      const result = checkCodemodeScript({ code: "debugger;" }, policy.codemodeRules, policy.codemodeDiagnostics);
      assert.equal(result.kind, "block");
    }

    const directory = join(dir, "unreadable.jsonc");
    mkdirSync(directory);
    const unreadable = resolveCachedPolicy(directory, null);
    assert.equal(unreadable.codemodeDiagnostics.length, 1);
    assert.equal(checkCodemodeScript({}, unreadable.codemodeRules, unreadable.codemodeDiagnostics).kind, "block");
  });
});

test("invalid codemode policy does not discard valid bash and read rules", () => {
  withTempDir((dir) => {
    const path = join(dir, "permissions.jsonc");
    for (const codemode of [{ Program: "invalid" }, { "Identifier:unknown": "deny" }]) {
      writeConfig(path, JSON.stringify({
        bash: { "^echo": "allow" },
        read: { "**": "deny" },
        codemode,
      }));

      const policy = resolveCachedPolicy(path, null);

      assert.deepEqual(policy.rules, [
        { toolName: "bash", pattern: "^echo", state: "allow", layer: "global" },
        { toolName: "read", pattern: "**", state: "deny", layer: "global" },
      ]);
      assert.ok(policy.codemodeDiagnostics.length > 0);
    }
  });
});

test("documented direct-call, member-call, and loop selectors match once per rule", () => {
  withTempDir((dir) => {
    const path = join(dir, "permissions.jsonc");
    writeConfig(path, JSON.stringify({ codemode: {
      "CallExpression[callee.name='eval']": "deny",
      "ForStatement, ForInStatement, ForOfStatement, WhileStatement, DoWhileStatement": "ask",
      "CallExpression[callee.type='MemberExpression'][callee.computed=false][callee.object.name='models'][callee.property.name='classify']": "ask",
    } }));
    const policy = resolveCachedPolicy(path, null);
    const result = checkCodemodeScript({
      code: 'eval("1"); eval("2"); models.classify({}); for (;;) { break; } while (false) {}',
    }, policy.codemodeRules, policy.codemodeDiagnostics);

    assert.equal(result.kind, "decision");
    if (result.kind === "decision") {
      assert.equal(result.state, "deny");
      assert.equal(result.matches.length, 3);
      assert.deepEqual(result.matches.map((rule) => rule.state), ["deny", "ask", "ask"]);
    }
  });
});

test("JSONC-escaped quotes remain part of string-valued AST attribute selectors", () => {
  withTempDir((dir) => {
    const path = join(dir, "permissions.jsonc");
    writeConfig(path, JSON.stringify({ codemode: { 'Literal[value="secret"]': "deny" } }));
    const policy = resolveCachedPolicy(path, null);
    const result = checkCodemodeScript({ code: 'const value = "secret";' }, policy.codemodeRules, policy.codemodeDiagnostics);

    assert.equal(result.kind, "decision");
    if (result.kind === "decision") assert.equal(result.state, "deny");
  });
});

test("direct-call selectors do not resolve aliases or computed access", () => {
  withTempDir((dir) => {
    const path = join(dir, "permissions.jsonc");
    writeConfig(path, '{"codemode":{"CallExpression[callee.name=\\"eval\\"]":"deny"}}');
    const policy = resolveCachedPolicy(path, null);

    for (const code of ['eval("x")', 'const run = eval; run("x")', 'globalThis["eval"]("x")']) {
      const result = checkCodemodeScript({ code }, policy.codemodeRules, policy.codemodeDiagnostics);
      assert.equal(result.kind, "decision");
      if (result.kind === "decision") {
        assert.equal(result.state, code.startsWith("eval(") ? "deny" : "allow");
      }
    }
  });
});

test("direct-call and parent selectors inspect executable dynamic-import options", () => {
  withTempDir((dir) => {
    const path = join(dir, "permissions.jsonc");
    const code = 'await import("missing", { with: { type: eval("json") } });';
    for (const [selector, state] of [
      ["CallExpression[callee.name='eval']", "deny"],
      ["ImportExpression:has(CallExpression[callee.name='eval'])", "deny"],
      ["ImportExpression > ObjectExpression", "ask"],
    ] as const) {
      writeConfig(path, JSON.stringify({ codemode: { [selector]: state } }));
      const policy = resolveCachedPolicy(path, null);
      const result = checkCodemodeScript({ code }, policy.codemodeRules, policy.codemodeDiagnostics);
      assert.equal(result.kind, "decision");
      if (result.kind === "decision") {
        assert.equal(result.state, state);
        assert.deepEqual(result.matches.map((rule) => rule.selector), [selector]);
      }
      assert.deepEqual(checkCodemodeScript(
        { code: 'await import("missing");' }, policy.codemodeRules, policy.codemodeDiagnostics,
      ), { kind: "decision", state: "allow", matches: [] });
    }
  });
});

test("Program selectors match the submitted root without a synthetic function node", () => {
  withTempDir((dir) => {
    const path = join(dir, "permissions.jsonc");
    writeConfig(path, '{"codemode":{"Program":"ask","FunctionExpression":"deny"}}');
    const policy = resolveCachedPolicy(path, null);

    for (const code of [
      "",
      `// @options: {"timeout_ms": 1000}\nreturn await Promise.resolve(1);`,
      "async function work() { await Promise.resolve(); }",
      "const value = maybe?.nested;",
    ]) {
      const result = checkCodemodeScript({ code }, policy.codemodeRules, policy.codemodeDiagnostics);
      assert.equal(result.kind, "decision");
      if (result.kind === "decision") {
        assert.equal(result.state, "ask");
        assert.deepEqual(result.matches.map((rule) => rule.selector), ["Program"]);
      }
    }
  });
});

test("unknown pseudo-classes invalidate policy even when no script node would match", () => {
  withTempDir((dir) => {
    const path = join(dir, "permissions.jsonc");
    const selector = "Identifier:unknown";
    writeConfig(path, JSON.stringify({ codemode: { [selector]: "deny" } }));
    const policy = resolveCachedPolicy(path, null);

    assert.equal(policy.codemodeDiagnostics.length, 1);
    assert.equal(policy.codemodeDiagnostics[0]!.configPath, path);
    assert.equal(policy.codemodeDiagnostics[0]!.selector, selector);
    assert.match(policy.codemodeDiagnostics[0]!.message, /Unknown class name: unknown/);

    for (const input of [{ code: "return 1;" }, { code: "const a = 1;" }, {}]) {
      const result = checkCodemodeScript(input, policy.codemodeRules, policy.codemodeDiagnostics);
      assert.equal(result.kind, "block");
      if (result.kind === "block") {
        assert.match(result.reason, /Identifier:unknown/);
        assert.match(result.reason, /permissions\.jsonc/);
      }
    }
  });
});

test("unknown pseudo-classes are rejected inside nested and combined selectors", () => {
  withTempDir((dir) => {
    const path = join(dir, "permissions.jsonc");
    for (const selector of [
      "Program:unknown",
      "Program:has(Identifier:unknown)",
      "Program:not(Identifier:unknown)",
      "Program:matches(Identifier:unknown, Literal)",
      "Program > Identifier:unknown",
      "Identifier:unknown Program",
      "Identifier:unknown + Literal",
      "Literal ~ Identifier:unknown",
      "Identifier:unknown, Program",
    ]) {
      writeConfig(path, JSON.stringify({ codemode: { [selector]: "allow" } }));
      const policy = resolveCachedPolicy(path, null);
      assert.equal(policy.codemodeDiagnostics.length, 1, selector);
      assert.equal(policy.codemodeDiagnostics[0]!.selector, selector);
      assert.match(policy.codemodeDiagnostics[0]!.message, /Unknown class name: unknown/);
      assert.equal(checkCodemodeScript(
        { code: "return 1;" }, policy.codemodeRules, policy.codemodeDiagnostics,
      ).kind, "block");
    }
  });
});

test("supported pseudo-classes remain valid and match their syntax", () => {
  withTempDir((dir) => {
    const path = join(dir, "permissions.jsonc");
    for (const [selector, code] of [
      [":statement", "return 1;"],
      [":declaration", "const value = 1;"],
      [":pattern", "const [value] = [1];"],
      [":expression", "1;"],
      [":function", "() => 1;"],
      [":FUNCTION", "() => 1;"],
      ["Program:has(:expression)", "1;"],
      ["Literal[value=':unknown']", "':unknown';"],
    ]) {
      writeConfig(path, JSON.stringify({ codemode: { [selector]: "deny" } }));
      const policy = resolveCachedPolicy(path, null);
      assert.deepEqual(policy.codemodeDiagnostics, [], selector);
      const result = checkCodemodeScript({ code }, policy.codemodeRules, policy.codemodeDiagnostics);
      assert.equal(result.kind, "decision");
      if (result.kind === "decision") assert.equal(result.state, "deny", selector);
    }
  });
});

test("unsupported modules and malformed configured scripts block instead of allowing", () => {
  withTempDir((dir) => {
    const path = join(dir, "permissions.jsonc");
    writeConfig(path, '{"codemode":{"DebuggerStatement":"deny"}}');
    const policy = resolveCachedPolicy(path, null);

    for (const input of [{ code: "export default 1;" }, { code: "function (" }, {}, { code: 4 }]) {
      const result = checkCodemodeScript(input, policy.codemodeRules, policy.codemodeDiagnostics);
      assert.equal(result.kind, "block");
      if (result.kind === "block") assert.match(result.reason, /codemode/i);
    }
  });
});

test("an invalid codemode selector blocks policy loading with its file and selector", () => {
  withTempDir((dir) => {
    const path = join(dir, "permissions.jsonc");
    writeConfig(path, '{"codemode":{"CallExpression[":"deny"}}');

    const policy = resolveCachedPolicy(path, null);

    assert.equal(policy.codemodeDiagnostics.length, 1);
    assert.match(policy.codemodeDiagnostics[0]!.message, /permissions\.jsonc/);
    assert.match(policy.codemodeDiagnostics[0]!.message, /CallExpression\[/);
  });
});

for (const { name, run } of tests) {
  run();
  console.log(`ok - ${name}`);
}
