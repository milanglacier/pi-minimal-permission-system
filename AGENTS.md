# Project Focus

This package is a Pi coding agent extension that enforces minimal permissions
for `bash`, `read`, `edit`, and `write` tool calls. Preserve that narrow scope:
changes should improve policy loading, matching, or enforcement without adding
unrelated agent behavior.

Pi extension documentation is available at
`https://pi.dev/docs/latest/extensions`.

# Permission Semantics

Permission policies are read from `.pi/agent/permissions.jsonc` at both the
global Pi agent directory and the current project. Treat precedence rules as
security-sensitive:

- Default behavior is `ask` when no rule matches.
- Global `deny` rules should remain hard to bypass.
- Project rules may refine behavior, but should not accidentally weaken global protections.
- JSONC parsing should warn and fail closed where practical.

When changing matching logic, consider command strings, absolute paths,
relative paths, and normalized path candidates.

# Development Commands

- `npm run typecheck` verifies strict TypeScript compatibility.
- `npm test` runs the permission-system behavior tests.
- `npm run check` runs both and should pass before commit or PR.

# Coding Conventions

Prefer `unknown` plus narrowing helpers over broad casts. Keep functions small
and keep security decisions readable; this code is easier to review when policy
resolution, rule matching, and runtime enforcement stay separated.

# Testing Expectations

Add tests for behavior, not implementation details. Important coverage areas
include JSONC parsing, invalid configs, global/project rule resolution, deny
precedence, path normalization, command matching, UI confirmation behavior, and
cache invalidation.

Use readable test names that describe the expected behavior. Keep temporary
filesystem and environment-variable changes isolated and cleaned up.

# Commit & Pull Request Guidelines

Use concise commit messages consistent with the existing history, such as `fix:
...`, `chore: ...`, `doc: ...`, or `release: ...`.

PRs should summarize the behavior change, call out security or compatibility
implications, link relevant issues, and include the `npm run check` result.
