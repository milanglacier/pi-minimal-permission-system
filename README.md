# pi-minimal-permission-system

A minimal permission enforcement extension for the [Pi coding
agent](https://github.com/earendil-works/pi-coding-agent).

This extension checks `read`, `edit`, `write`, and `bash` calls against rules
you configure. These tools require approval when no rule matches. You can also
restrict JavaScript syntax in Pi's `codemode` tool (Pi 0.99.1+).

Codemode calls other tools, and those calls still go through their usual
permission checks. Allowing codemode by default avoids asking twice. You can
add rules to restrict the script itself.

## Philosophy

- Policies cover `read`, `edit`, `write`, and `bash` calls, plus optional
  codemode syntax checks. They do not cover MCP tools or other extension tools.
- Rules have two layers: global and project-local. There are no separate
  subagent policies.
- File tools have independent rules, so you can allow reads while blocking
  edits and writes.

## Installation

Install from npm with Pi:

```bash
pi install npm:pi-minimal-permission-system
```

To pin a specific release:

```bash
pi install npm:pi-minimal-permission-system@1.0.0
```

For local development, clone the repository and install its dependencies:

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/milanglacier/pi-minimal-permission-system.git
cd pi-minimal-permission-system
npm install
```

## Configuration

Define permissions in JSONC files (JSON with comments). Use `allow` to permit a
call, `deny` to block it, or `ask` to request approval. Calls that require
approval are blocked when no interactive UI is available.

### Global config

`~/.pi/agent/permissions.jsonc`

Applies to every Pi session. If `PI_CODING_AGENT_DIR` is set, the global file
is `$PI_CODING_AGENT_DIR/permissions.jsonc`.

### Project-local config

`<cwd>/.pi/agent/permissions.jsonc`

Pi reads this file relative to its current working directory. It does not
search parent directories for project policies. Project rules are combined
with global rules using the precedence described below.

### Format

```jsonc
{
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

  "codemode": {
    "DebuggerStatement": "deny",
  },
}
```

### Pattern matching

| Tool                    | Pattern type                                              | Notes                                                                                                                        |
| ----------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `read`, `edit`, `write` | [picomatch](https://github.com/micromatch/picomatch) glob | Matches absolute path, relative path (from cwd), raw input, and basename. `dot: true` is enabled.                            |
| `bash`                  | JavaScript RegExp                                         | Matched against the full command string. Must be a valid regex (the pattern string is passed to `new RegExp(pattern, "u")`). |
| `codemode`              | [esquery](https://github.com/estools/esquery) AST selector | Matched against the submitted JavaScript parsed with Acorn. Matching is syntactic; aliases and runtime behavior are not resolved. |

### Precedence

For `bash`, `read`, `edit`, and `write`:

1. Evaluate rules in declaration order, global first and then project-local.
2. Use the last matching rule. If none matches, require approval (`ask`).
3. If the last matching global rule is `deny`, block the call regardless of
   project rules. A later global rule can override an earlier global rule.

For codemode, combine all matching selectors from both layers with
**`deny > ask > allow`**, regardless of declaration order. A valid policy allows
scripts when rules are absent or no selector matches. An `allow` rule cannot
create an exception to a matching `ask` or `deny` rule.

See the [Codemode permissions guide](docs/codemode-permissions.md) for syntax
selectors, validation errors, and limitations. Syntax checks are not a sandbox.

### YOLO mode

Start Pi with `--yolo` or run `/yolo` during an interactive session to bypass
all permission checks enforced by this extension. `/yolo` is a toggle; running
it again restores normal permission enforcement.

YOLO bypasses policy loading, rule checks, and approval prompts for all covered
tools, including codemode. It also bypasses global denials and codemode policy
validation.

Set `PI_MINIMAL_PERMISSION_SYSTEM_YOLO=1` to enable YOLO by default, or `=0`
to enforce permissions.

Explicit flags override the environment: `--yolo` enables YOLO, and
`--no-yolo` disables it. If both flags are supplied, `--no-yolo` wins.

## Example workflows

### Read-only mode for sensitive directories

```jsonc
{
  "read": {
    "**": "allow",
  },
  "edit": {
    "**": "allow",
    "**/.ssh/**": "deny",
    "**/.gnupg/**": "deny",
  },
  "write": {
    "**": "allow",
    "**/.ssh/**": "deny",
    "**/.gnupg/**": "deny",
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

### Allow `rm -r`/`rm -f` in temp paths, ask elsewhere

Bash rules inspect the command string, not the shell's parsed arguments or
expanded variables. This example asks about `rm` flags, allows matching temp
paths, then asks again for extra targets or `..`:

```jsonc
{
  "bash": {
    ".*": "allow",
    // Ask for any rm with -r/-R/-f style flags.
    "rm\\s+-[rRf]+": "ask",
    // Allow it on a single temp target: /tmp/<name>, or a shell variable whose
    // name contains tmp/temp, e.g. "$tmp" or "${tempdir}".
    "rm\\s+-[rRf]+\\s+(\"?/tmp/[\\w.-][\\w./-]*\"?|\"?\\$\\{?\\w*(tmp|TMP|temp|TEMP)\\w*\\}?\"?)": "allow",
    // Ask again if such an rm has a target that is not a single temp path.
    "rm\\s+-[rRf]+\\s+(?!(\"?/tmp/[\\w.-][\\w./-]*\"?|\"?\\$\\{?\\w*(tmp|TMP|temp|TEMP)\\w*\\}?\"?)\\s*([;&|)'\\n]|$))": "ask",
    // Ask ".." targets, even under /tmp.
    "rm\\s+-[rRf]+\\s+.*\\.\\.": "ask",
    // Allow: xxx=$(mktemp -d); rm -r "$xxx"
    "^([A-Za-z_]\\w*)=\"?\\$\\(mktemp -d[^)]*\\)[\\s\\S]*rm\\s+(-[rRf]+\\s+)?\"\\$(\\1|\\{\\1\\})\"": "allow",
  },
}
```

`rm -rf /tmp/build`, `rm -f /tmp/x.log`, and `rm -rf "$tmp"` run without
prompting. `rm -rf ./build`, `rm -rf /tmp/a /tmp/b`, and `rm -rf /tmp/../etc`
ask for confirmation. These regexes cannot cover every scenario.

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
    "**": "allow",
    "**/package.json": "ask",
  },
}
```

With `my-app` as Pi's working directory, edits to `package.json` require
approval. Other edits are allowed.

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

Run `npm run check` to type-check the code and run all tests. Use
`npm run typecheck` or `npm test` to run either check separately.

Integration tests use Pi's real codemode tool with isolated configuration and a
deterministic provider. They require Pi 0.99.1 or a compatible release and make
no external model requests.
