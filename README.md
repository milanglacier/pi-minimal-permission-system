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
| `bash`                  | JavaScript RegExp                                         | Matched against the full command string. Must be a valid regex (the pattern string is passed to `new RegExp(pattern, "u")`). |

### Precedence

1. Rules are evaluated in config order: **global first, then project-local**.
2. The **last matching rule wins**.
3. **Global `deny` is special**: if the last match is not a `deny`, the system still checks whether any global rule issues a `deny`. This means you can safely set a global hard boundary (e.g. deny `/etc/**`) that cannot be accidentally overridden by a project-local rule.

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
