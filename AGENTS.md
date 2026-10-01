# Project Focus

This package is a Pi coding agent extension that enforces minimal permissions
for `bash`, `read`, `edit`, and `write` tool calls, with optional syntax-based
policies for codemode scripts. Preserve that narrow scope: changes should
improve policy loading, matching, or enforcement without adding unrelated
agent behavior.

Pi extension documentation is available at
`https://pi.dev/docs/latest/extensions`.

# Permission Semantics

Read global policies from `$PI_CODING_AGENT_DIR/permissions.jsonc`, or
`~/.pi/agent/permissions.jsonc` when that variable is unset. Read project
policies from `<cwd>/.pi/agent/permissions.jsonc`. Treat these rules as
security-sensitive:

- `bash`, `read`, `edit`, and `write` default to `ask`. Evaluate global rules
  before project rules; the last matching rule wins, except that a `deny` from
  the last matching global rule cannot be weakened by project rules.
- Codemode defaults to `allow` when its policy is valid and no selector matches,
  including when no selectors are configured. Combine all matching selectors
  across both layers with `deny > ask > allow`, regardless of declaration order.
- Invalid policy files or codemode rules block codemode. Preserve the existing
  error handling for `bash`, `read`, `edit`, and `write`.
- Allowing or approving a codemode script does not approve its nested tool calls.
  Syntax checks supplement runtime permissions; they are not a sandbox.
- YOLO mode bypasses permission checks, including codemode policy validation.

When changing matching logic, consider command strings, absolute paths,
relative paths, and normalized path candidates.

# Development Commands

- `npm run typecheck` verifies strict TypeScript compatibility.
- `npm test` runs behavior tests and real Pi codemode integration tests.
- `npm run check` runs both checks and must pass before a commit or pull request.

The integration tests require Pi 0.99.1 or a compatible release with builtin
codemode and nested `tool_call` events. Use isolated configuration, in-memory
sessions, and a deterministic provider without user credentials or network
requests.

# Coding Conventions

Prefer `unknown` plus narrowing helpers over broad casts. Keep functions small
and keep security decisions readable; this code is easier to review when policy
resolution, rule matching, and runtime enforcement stay separated.

# Testing Expectations

Add tests for behavior, not implementation details. Important coverage areas
include JSONC parsing, invalid configuration, global and project precedence,
path normalization, command matching, codemode selectors and script parsing,
approval and cancellation, nested tool enforcement, and cache invalidation.

Use readable test names that describe the expected behavior. Keep temporary
filesystem and environment-variable changes isolated and cleaned up.

# Commit & Pull Request Guidelines

Use Conventional Commits with a lowercase type prefix, such as `fix: ...`,
`chore: ...`, `docs: ...`, or `release: ...`.

Pull requests should summarize the behavior change, explain security or
compatibility implications, link relevant issues, and include the
`npm run check` result.
