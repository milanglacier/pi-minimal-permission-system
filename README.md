# pi-minimal-permission-system

A minimal permission enforcement extension for the [Pi coding
agent](https://github.com/earendil-works/pi-coding-agent).

This extension adds a lightweight permission layer to Pi. Instead of running
unrestricted, built-in tool calls (`read`, `edit`, `write`, and `bash`) are
checked against a simple policy that you control. MCP tools and other
extensions are intentionally out of scope.

## Philosophy

Pi is designed to be minimal. This extension follows the same approach:

- **Built-in tools only** — `read`, `edit`, `write`, and `bash`. MCP tools and
  extension-provided tools are intentionally not covered.
- **No granular subagent permissions** — just two layers: **global** and
  **project-local**.
- **Granular tool-level control** — `read`, `edit`, and `write` are governed
  independently, so you can allow read-only access to sensitive paths while
  blocking edits.

## Installation

Install from npm with Pi:

```bash
pi install npm:pi-minimal-permission-system
```

To pin a specific release:

```bash
pi install npm:pi-minimal-permission-system@1.0.0
```

For local development, you can still clone it into `~/.pi/agent/extensions`:

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/milanglacier/pi-minimal-permission-system.git
```

## Configuration

Permissions are defined in JSONC (JSON with comments) files.

### Global config

`~/.pi/agent/permissions.jsonc`

Applies to **every** Pi session regardless of working directory.

### Project-local config

`<cwd>/.pi/agent/permissions.jsonc`

Applies only when Pi's working directory is inside that project. Project rules are layered on top of global rules.

### Format

```jsonc
{
  // "allow"   -> silently permit
  // "deny"    -> hard-block with an error
  // "ask"     -> prompt the user for confirmation (default when no rule matches)

  "read": {
    "**": "allow",
    "/etc/**": "deny",
    "**/.env*": "deny",
    "**/secrets/**": "ask",
  },

  "edit": {
    "**": "allow",
    "**/.env*": "deny",
    "**/package-lock.json": "deny",
  },

  "write": {
    "**": "allow",
    "/etc/**": "deny",
    "**/.ssh/**": "deny",
  },

  "bash": {
    ".*": "allow",
    "rm\\s+-rf\\s+/.*": "deny",
    "sudo\\b.*": "ask",
  },
}
```

### Pattern matching

| Tool                    | Pattern type                                              | Notes                                                                                                                        |
| ----------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `read`, `edit`, `write` | [picomatch](https://github.com/micromatch/picomatch) glob | Matches absolute path, relative path (from cwd), raw input, and basename. `dot: true` is enabled.                            |
| `bash`                  | JavaScript RegExp                                         | Matched against each command in the input (see [Bash command matching](#bash-command-matching)). Must be a valid regex (the pattern string is passed to `new RegExp(pattern, "u")`). |

### Precedence

1. Rules are evaluated in config order: **global first, then project-local**.
2. The **last matching rule wins**.
3. **Global `deny` is special**: if the last match is not a `deny`, the system still checks whether any global rule issues a `deny`. This means you can safely set a global hard boundary (e.g. deny `/etc/**`) that cannot be accidentally overridden by a project-local rule. Within the global config, a later matching `allow` can still override an earlier global `deny`.
4. **No match means `ask`.**

For `bash`, these rules decide each command separately, and the results are
then combined as described below.

### Bash command matching

The extension parses each bash input with
[tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash) and applies
the rules to every command in it:

1. Each command is resolved on its own with the precedence rules above.
2. The results are combined as `deny > ask > allow`. Any `deny` blocks the
   whole tool call. Otherwise, any `ask` prompts once for the whole call. The
   call runs without a prompt only when every command is allowed.

The prompt or denial message shows the complete input and the command that
decided the result, with the rule that matched it. When several commands are
equally restrictive, the first one in the input is shown. Approval always
covers the complete input; parts of a script are never run separately.

Because regexes match individual commands, `^` and `$` anchor to the start
and end of one command. For example, `^git status$` allows `git status` and
`git status; git status`, but `git status && rm x` asks because `rm x` has no
matching rule.

#### What counts as a command

Each simple command is matched as it appears in the input, including its
variable-assignment prefixes, arguments, quotes, redirections, and heredoc
bodies. For example, `FOO=1 make build > log 2>&1` is matched as one string.
Statements that consist only of assignments (`tmp=$(mktemp -d)`) or only of
redirections (`> out`) are commands too.

The parser looks inside:

- command lists and pipelines (`;`, `&&`, `||`, `|`, `&`, and newlines);
- groups `{ ...; }`, subshells `( ... )`, and `!` negation;
- `if`, `while`, `until`, `for`, `select`, and `case`, including every branch
  and loop body, whether or not it would run;
- function bodies;
- command substitutions `$(...)` and `` `...` ``, and process substitutions
  `<(...)` and `>(...)`, wherever they appear, including in assignments,
  redirections, double-quoted strings, and heredocs with an unquoted
  delimiter.

A command that contains a substitution is matched as a whole, and each command
inside the substitution is also matched separately. An `allow` for the outer
command cannot override an `ask` or `deny` for the inner one. For example,
`tmp=$(mktemp -d)` is checked as both `tmp=$(mktemp -d)` and `mktemp -d`.

Compound statements such as `if ...; fi` or `{ ...; }` are not matched as a
whole, because a rule matching the whole block could span unrelated commands
inside it.

Quoted text, comments, and the bodies of heredocs with a quoted delimiter
(`<<'EOF'`) never produce commands. String arguments are not parsed again as
scripts: `bash -c "echo hello; echo world"`, `eval "a; b"`, and `sh -c '...'`
are each one command, matched together with their string arguments. A rule
such as `rm -r` therefore still matches `bash -c "rm -rf ~"`. Substitutions
written directly in the input are still inspected, so
`bash -c "echo $(whoami)"` also checks `whoami`.

Parsing never executes the input or expands variables. Commands whose behavior
depends on runtime values, such as `$cmd --flag` or `eval "$script"`, are
matched like any other command and do not ask for approval unless a rule says
so.

#### Whole-input fallback

In the following cases, the rules are matched against the complete input as a
single string, with the same precedence rules:

- the input has a syntax error, or uses syntax the parser does not recognize;
- the parser cannot be loaded;
- the input is too large or too deeply nested to analyze within the built-in
  limits;
- the input contains no commands, for example when it is empty or contains only
  comments.

A fallback is never combined with commands that were partially extracted. No
match still means `ask`, and the prompt says that the whole input was matched.

Whole-input matching cannot isolate commands from each other: an unanchored
`allow` rule can match text belonging to a different command in the same
input. Keep broad `allow` rules in mind when writing exceptions.

#### Example: allow temporary-directory cleanup

This policy allows a script to create and remove a temporary directory while
asking before any other forced deletion in the same script:

```jsonc
{
  "bash": {
    ".*": "allow",

    "rm -r": "ask",
    "rm -f": "ask",

    // Allow a named directory directly under /tmp.
    "^rm -rf /tmp/[\\w-][\\w.-]*$": "allow",

    // Trust this quoted temporary-directory variable by name.
    "^rm -rf \"\\$tmp\"$": "allow",
    "^rm -rf \"\\$\\{tmp\\}\"$": "allow",
  },
}
```

The `rm -r` rule also matches `rm -rf`. The later, anchored exceptions allow
cleanup only when they match an entire command. With this policy:

| Input                                         | Result |
| --------------------------------------------- | ------ |
| `tmp=$(mktemp -d); rm -rf "${tmp}"`           | allow  |
| `rm -rf /tmp/tmp.ABC123`                      | allow  |
| `rm -rf "$tmp"; rm -rf ~/important`           | ask    |
| `rm -rf /tmp/test ~/important`                | ask    |
| `echo "$(rm -rf ~/important)"; rm -rf "$tmp"` | ask    |

The example has limits:

- It covers the common single-space spelling `rm -rf`, not every whitespace or
  flag variation.
- The path exception covers a named direct child of `/tmp`. It does not cover
  `/tmp` itself, `.` or `..`, nested paths, or extra operands.
- The exceptions allow `rm -rf` only; `rm -f` still asks.
- The variable exceptions trust `$tmp` by name. The extension does not check
  its value or whether it came from `mktemp`.

Parsing and regex matching are not a shell sandbox and do not guarantee
filesystem safety.

#### Upgrading from 1.x

Before 2.0.0, bash rules matched the complete tool input as one string. Now
they match each command when the input parses successfully. The JSONC format is
unchanged, but review rules that were written against whole scripts:

- A rule that spans several statements or pipeline stages, such as
  `cd .* && git push`, no longer matches. Rewrite it to match a single
  command, such as `^git push`. This includes global `deny` rules.
- `^` and `$` now anchor to one command, so an anchored `allow` such as
  `^npm test$` also allows `npm test` when it appears inside a longer script
  with other allowed commands.

### YOLO mode

Start Pi with `--yolo` or run `/yolo` during an interactive session to bypass
all permission checks enforced by this extension. `/yolo` is a toggle; running
it again restores normal permission enforcement.

When YOLO mode is enabled, `bash`, `read`, `edit`, and `write` tool calls are
allowed without loading policy, checking rules, prompting, or honoring global
`deny` rules.

## Example workflows

### Read-only mode for sensitive directories

```jsonc
{
  "read": {
    "**": "allow",
  },
  "edit": {
    "**/.ssh/**": "deny",
    "**/.gnupg/**": "deny",
    "**": "allow",
  },
  "write": {
    "**/.ssh/**": "deny",
    "**/.gnupg/**": "deny",
    "**": "allow",
  },
}
```

### Interactive gate for destructive commands

```jsonc
{
  "bash": {
    ".*": "allow",
    "rm\\s+-rf\\s+/.*": "deny",
    "dropdb\\b.*": "ask",
    "sudo\\b.*": "ask",
  },
}
```

### Per-project override

Global `~/.pi/agent/permissions.jsonc`:

```jsonc
{
  "edit": {
    "**": "allow",
  },
}
```

Project `my-app/.pi/agent/permissions.jsonc`:

```jsonc
{
  "edit": {
    "**/package.json": "ask",
    "**": "allow",
  },
}
```

Editing `package.json` inside `my-app` will prompt for confirmation; everywhere else it is allowed.

## Comparison with `pi-permission-system`

| Feature                         | `pi-minimal-permission-system` (this project)       | [`pi-permission-system`](https://github.com/MasuRii/pi-permission-system) |
| ------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| **Philosophy**                  | Minimal, aligned with Pi's design                   | More feature-rich                                                         |
| **Permission layers**           | Global + project-local only                         | Global + project-local + granular subagent permissions                    |
| **Subagent permissions**        | ❌ Not supported (intentionally)                    | ✅ Supported                                                              |
| **Filesystem tool granularity** | ✅ `read`, `edit`, `write` controlled independently | ❌ Not currently supported                                                |
| **Command filtering**           | ✅ Regex-based bash rules                           | ✅ Supported                                                              |
| **MCP / extension tools**       | ❌ Not supported (intentionally)                    | ✅ Supported                                                              |
| **Config format**               | JSONC                                               | JSONC/YAML                                                                |

**When to choose this extension:**

- You want a **minimal** permission system that stays out of your way.
- You do **not** need per-subagent or MCP tool permission overrides.
- You want **granular filesystem control** — for example, allowing the agent to `read` secrets but never `edit` or `write` them.

**When to choose `pi-permission-system`:**

- You need **subagent-level permission granularity** (e.g. different policies for different agent roles or chains).

## Development

```bash
# Type-check
npm run typecheck

# Run tests
npm run test

# Both
npm run check
```
