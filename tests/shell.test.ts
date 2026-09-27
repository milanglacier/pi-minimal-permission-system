import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeShellCommand, type ShellAnalysis } from "../src/shell.js";

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

function expectCommands(analysis: ShellAnalysis): string[] {
  assert.equal(analysis.kind, "commands", `Expected commands, got ${JSON.stringify(analysis)}`);
  return analysis.kind === "commands" ? analysis.units.map((unit) => unit.text) : [];
}

async function commandsOf(input: string): Promise<string[]> {
  return expectCommands(await analyzeShellCommand(input));
}

async function fallbackReasonOf(input: string): Promise<string> {
  const analysis = await analyzeShellCommand(input);
  assert.equal(analysis.kind, "fallback", `Expected fallback, got ${JSON.stringify(analysis)}`);
  return analysis.kind === "fallback" ? analysis.reason : "";
}

await runTest("command lists, pipelines, and background jobs yield one unit per command", async () => {
  assert.deepEqual(await commandsOf("cd /tmp && ls -la | head -5 & echo done; false || true"), [
    "cd /tmp",
    "ls -la",
    "head -5",
    "echo done",
    "false",
    "true",
  ]);
  assert.deepEqual(await commandsOf("a \\\n  b\nc &&\n  d"), ["a \\\n  b", "c", "d"]);
});

await runTest("groups, subshells, conditions, loops, case branches, and function bodies are traversed", async () => {
  assert.deepEqual(await commandsOf("{ a; b; }; (c; d); ! e"), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(await commandsOf("if a; then b; elif c; then d; else e; fi"), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(await commandsOf("while a; do b; done; until c; do d; done"), ["a", "b", "c", "d"]);
  assert.deepEqual(await commandsOf("for x in 1 2; do a \"$x\"; done; for ((i=0; i<3; i++)); do b; done"), [
    "a \"$x\"",
    "b",
  ]);
  assert.deepEqual(await commandsOf("case $x in a) b;; c|d) e;& *) f;; esac"), ["b", "e", "f"]);
  assert.deepEqual(await commandsOf("f() { rm -rf /; }; function g { h; }"), ["rm -rf /", "h"]);
  assert.deepEqual(await commandsOf("[ -f x ] && [[ -d y ]]"), ["[ -f x ]", "[[ -d y ]]"]);
});

await runTest("command substitutions, backticks, and process substitutions yield nested commands", async () => {
  assert.deepEqual(await commandsOf("echo \"$(whoami)\" `id` <(ls) >(wc -l)"), [
    "echo \"$(whoami)\" `id` <(ls) >(wc -l)",
    "whoami",
    "id",
    "ls",
    "wc -l",
  ]);
  assert.deepEqual(await commandsOf("echo ${x:-$(a)} $((1 + $(b)))"), ["echo ${x:-$(a)} $((1 + $(b)))", "a", "b"]);
  assert.deepEqual(await commandsOf("x=$(a $(b))"), ["x=$(a $(b))", "a $(b)", "b"]);
});

await runTest("substitutions in assignments and redirections are inspected", async () => {
  assert.deepEqual(await commandsOf("tmp=$(mktemp -d); rm -rf \"${tmp}\""), [
    "tmp=$(mktemp -d)",
    "mktemp -d",
    "rm -rf \"${tmp}\"",
  ]);
  assert.deepEqual(await commandsOf("export A=$(a) B=2; arr[$(b)]=1"), ["export A=$(a) B=2", "a", "arr[$(b)]=1", "b"]);
  assert.deepEqual(await commandsOf("cat > \"$(a)\"; read -r x <<< \"$(b)\""), [
    "cat > \"$(a)\"",
    "a",
    "read -r x <<< \"$(b)\"",
    "b",
  ]);
  assert.deepEqual(await commandsOf("while read l; do echo \"$l\"; done < <(ls) > out"), [
    "read l",
    "echo \"$l\"",
    "< <(ls) > out",
    "ls",
  ]);
});

await runTest("simple commands keep assignment prefixes and redirections", async () => {
  assert.deepEqual(await commandsOf("FOO=1 cmd  a >out 2>&1"), ["FOO=1 cmd  a >out 2>&1"]);
  assert.deepEqual(await commandsOf(">out cmd; npm test 2>&1 | tail -20"), [">out cmd", "npm test 2>&1", "tail -20"]);
  assert.deepEqual(await commandsOf("a=1; a=1 b=2; > out"), ["a=1", "a=1 b=2", "> out"]);
});

await runTest("quoted separators and comments do not create commands", async () => {
  assert.deepEqual(await commandsOf("echo 'a; rm -rf /' \"b && c\" $'d | e' f\\;g"), [
    "echo 'a; rm -rf /' \"b && c\" $'d | e' f\\;g",
  ]);
  assert.deepEqual(await commandsOf("echo a # rm -rf /\n# rm -rf ~\necho b"), ["echo a", "echo b"]);
});

await runTest("literal heredoc content does not create commands while expandable heredocs are inspected", async () => {
  assert.deepEqual(await commandsOf("cat > f.sh <<'EOF'\nrm -rf /\n$(whoami)\nEOF\nchmod +x f.sh"), [
    "cat > f.sh <<'EOF'\nrm -rf /\n$(whoami)\nEOF",
    "chmod +x f.sh",
  ]);
  assert.deepEqual(await commandsOf("cat <<EOF\nrm -rf /\n$(whoami) ${USER}\nEOF"), [
    "cat <<EOF\nrm -rf /\n$(whoami) ${USER}\nEOF",
    "whoami",
  ]);
});

await runTest("substitutions the parser leaves unrecognized fall back to whole-input matching", async () => {
  // tree-sitter-bash keeps these as literal text although bash executes them.
  assert.match(await fallbackReasonOf("cat <<EOF\n`id`\nEOF"), /unsupported shell syntax/);
  assert.match(await fallbackReasonOf("echo ${x:-`id`}"), /unsupported shell syntax/);
  assert.deepEqual(await commandsOf("echo \\`id\\` '`id` $(x)' \"a \\` b\""), ["echo \\`id\\` '`id` $(x)' \"a \\` b\""]);
});

await runTest("commands after a heredoc marker are separate from the heredoc command", async () => {
  assert.deepEqual(await commandsOf("cat <<'EOF' | rm -rf ~/important\nbody\nEOF\necho after"), [
    "cat <<'EOF'\nbody\nEOF",
    "rm -rf ~/important",
    "echo after",
  ]);
});

await runTest("heredocs inside substitutions are inspected", async () => {
  assert.deepEqual(await commandsOf("git commit -m \"$(cat <<'EOF'\nfix: x; rm -rf /\nEOF\n)\""), [
    "git commit -m \"$(cat <<'EOF'\nfix: x; rm -rf /\nEOF\n)\"",
    "cat <<'EOF'\nfix: x; rm -rf /\nEOF",
  ]);
});

await runTest("script strings are not reparsed as commands", async () => {
  assert.deepEqual(await commandsOf("bash -c \"echo hello; echo world\""), ["bash -c \"echo hello; echo world\""]);
  assert.deepEqual(await commandsOf("sh -c 'rm -rf /' && eval \"a; b\""), ["sh -c 'rm -rf /'", "eval \"a; b\""]);
});

await runTest("substitutions inside script strings are inspected without reparsing the string", async () => {
  assert.deepEqual(await commandsOf("bash -c \"echo $(whoami); echo world\""), [
    "bash -c \"echo $(whoami); echo world\"",
    "whoami",
  ]);
});

await runTest("unit offsets are JavaScript string offsets that preserve Unicode text", async () => {
  const input = "echo 中文 😀 && rm \"é x\" | cat -A; printf '%s' \"$(echo ✓)\"";
  const analysis = await analyzeShellCommand(input);
  assert.deepEqual(expectCommands(analysis), [
    "echo 中文 😀",
    "rm \"é x\"",
    "cat -A",
    "printf '%s' \"$(echo ✓)\"",
    "echo ✓",
  ]);
  if (analysis.kind === "commands") {
    for (const unit of analysis.units) {
      assert.equal(input.slice(unit.start, unit.start + unit.text.length), unit.text);
    }
  }
});

await runTest("parse errors fall back to whole-input matching", async () => {
  assert.match(await fallbackReasonOf("echo $("), /could not be parsed/);
  assert.match(await fallbackReasonOf("echo ok; if"), /could not be parsed/);
  assert.match(await fallbackReasonOf("echo \"unterminated"), /could not be parsed/);
});

await runTest("empty and comment-only input fall back to whole-input matching", async () => {
  assert.match(await fallbackReasonOf(""), /no commands/);
  assert.match(await fallbackReasonOf("# rm -rf /\n"), /no commands/);
});

await runTest("oversized and deeply nested input fall back instead of exhausting resources", async () => {
  assert.match(await fallbackReasonOf(`echo ${"x".repeat(200_000)}`), /limits/);
  assert.match(await fallbackReasonOf(`${"echo $(".repeat(300)}x${")".repeat(300)}`), /limits/);
  assert.deepEqual(await commandsOf("echo ok"), ["echo ok"], "The parser remains usable after a fallback");
});

await runTest("analysis never executes the input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-minimal-permission-system-shell-"));
  try {
    const direct = join(dir, "direct");
    const nested = join(dir, "nested");
    await analyzeShellCommand(`touch '${direct}'; echo "$(touch '${nested}')" <(touch '${nested}')`);

    assert.equal(existsSync(direct), false);
    assert.equal(existsSync(nested), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
