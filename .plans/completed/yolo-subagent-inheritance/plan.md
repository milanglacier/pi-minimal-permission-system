# YOLO inheritance for future subagent sessions

## Goal

Let future in-process and subprocess sessions inherit the current YOLO setting without changing Pi's official SDK or any subagent launcher. Keep each running session's effective YOLO state independent, and give explicit command-line flags precedence over the inherited environment value.

Approved implementation plan. Changes are limited to this permission extension, its documentation, and its tests.

## Confirmed scope

- Use `PI_MINIMAL_PERMISSION_SYSTEM_YOLO` as a process-wide default for newly started sessions.
- Subagents are not expected to toggle YOLO. Preserve the existing `/yolo` command; do not add subagent-specific command registration or parent detection.
- Changes affect future sessions only. Already-running subagents keep the setting they resolved at startup.
- Do not modify `pi-subagents`, Pi's SDK, or other launchers.
- Preserve all existing permission semantics, including YOLO bypass of global denials and invalid codemode policies.
- Do not add per-subagent policies, session persistence, cross-extension messaging, or a session registry.

## Current implementation

- `index.ts` declares `yoloEnabled` at module scope. The extension factory resets it to `false`, and `session_start` assigns the session's `yolo` flag value.
- In-process sessions loading the same module can therefore overwrite each other's effective YOLO state.
- The `yolo` boolean flag currently defaults to `false`, which makes an omitted flag indistinguishable from an explicitly supplied false value.
- Pi's extension API permits registering flags without defaults. `pi.getFlag()` then returns `undefined` when no value was supplied.
- The installed `createAgentSession()` API has no YOLO or parent-permission option. Extensions can read the shared Node.js `process.env` without launcher cooperation.
- Subprocesses inherit the launching process's environment unless their launcher replaces or filters it. The permission extension must also be loaded in the child for inheritance to take effect.

## Behavioral contract

### Startup precedence

Register `--no-yolo` as an explicit boolean extension flag, and remove the default from `--yolo` so absence remains distinguishable.

Resolve effective YOLO state in `session_start`, after CLI flag values are available:

1. If `--no-yolo` is enabled, disable YOLO. This conservative choice also applies when both flags are supplied.
2. Otherwise, if `pi.getFlag("yolo")` is a boolean, use that explicit value.
3. Otherwise, enable YOLO only when `PI_MINIMAL_PERMISSION_SYSTEM_YOLO` is exactly `"1"`.
4. An unset environment variable, `"0"`, or any unrecognized value leaves normal permission enforcement enabled.

Do not use string truthiness: values such as `"false"` must not enable YOLO. Document `1` and `0` as the supported environment values; do not add alternative CLI spellings such as `--yolo=false` in this change.

| Explicit flags | Environment | Effective YOLO |
| --- | --- | --- |
| None | Unset, `0`, or invalid | Off |
| None | `1` | On |
| `--yolo` | Any value | On |
| `--no-yolo` | Any value | Off |
| Both | Any value | Off |

### Publication and session isolation

- Put `yoloEnabled` inside the extension factory. Each extension instance owns its effective state.
- At `session_start`, resolve the setting once and publish the effective value as `"1"` or `"0"` in `process.env.PI_MINIMAL_PERMISSION_SYSTEM_YOLO`.
- `/yolo` toggles only the invoking session's effective state and publishes its new value for future sessions.
- Tool-call handlers consult the instance-local boolean, not the environment. Environment changes do not alter an already-running session.
- Constructing another extension instance must not reset an existing instance's boolean.
- Keep normal policy loading when YOLO resolves to off and the existing early bypass when it resolves to on.
- Do not restore or delete the environment value on session shutdown. Another session may have published a newer value, and existing subprocess environments cannot be updated by cleanup.

### Process-wide limitation

This is inheritance of the process's latest published setting, not strict parent-specific inheritance. Every session startup publishes its resolved value. An explicitly overridden in-process child can therefore change the default for subsequently started sessions, including siblings, without changing any running session's effective state.

The intended workflow is that the main session controls `/yolo` and subagents do not toggle it. No restriction on child command access is added because the extension has no reliable parent/child identity without launcher cooperation. Strict parent-specific inheritance is outside this plan.

A parent toggle cannot update a subprocess that is already running. Future descendants launched by that subprocess inherit its own environment snapshot, not a later setting from the original parent.

## Implementation steps

### 1. Update runtime state and flags

File: `index.ts`.

- Add a constant for the environment variable name.
- Move only `yoloEnabled` into `minimalPermissionExtension`; leave policy cache behavior unchanged.
- Register `yolo` without a default and register the boolean `no-yolo` flag.
- Implement the startup precedence above with explicit boolean checks and an exact environment-value comparison.
- Publish the resolved state at startup and after `/yolo` toggles.
- Keep publication logic small and local; do not introduce a generic configuration abstraction.
- Preserve approval, cancellation, matching, and codemode enforcement paths.

### 2. Add behavior tests

Primary file: `tests/permission-system.test.ts`.

- Extend the harness to represent omitted flags, explicit boolean values, and `no-yolo` independently.
- Save and restore the YOLO environment variable alongside existing filesystem and environment cleanup. Ordinary permission tests must start with an isolated YOLO environment; inheritance tests must explicitly opt into sharing the published value.
- Restore nested harnesses in reverse creation order so cleanup does not leave stale environment values.
- Verify the startup precedence table, including invalid environment values and both flags together.
- Verify that `--yolo` publishes `1`, `/yolo` publishes both `1` and `0`, and `--no-yolo` overrides inherited `1`.
- Start multiple extension instances from the same imported module. Verify that a child inherits startup YOLO without disabling the parent.
- Toggle the parent off after starting an enabled child. Verify that the existing child stays enabled while a later child enforces permissions.
- Also cover enabling the parent after starting a normal child: the existing child remains normal while a later child inherits YOLO.
- Verify that a child's explicit off override leaves the already-running parent's effective state unchanged and publishes the documented process-wide default.
- Exercise protected tool calls rather than inspecting private state. Reuse existing deny policies and YOLO tests for covered tools and codemode validation bypass.

### 3. Verify real Pi session and subprocess behavior

Use the existing deterministic-provider and isolated-session conventions in `tests/codemode-integration.test.ts`, or a focused test file if that keeps the fixture simpler.

- Create real in-memory Pi sessions loading the same permission extension, with isolated configuration and no user credentials or network requests.
- Verify inherited YOLO permits an otherwise denied nested tool call, and that changing the published default does not change an existing session's enforcement.
- Create another real session after the default changes and verify normal enforcement resumes.
- Add a minimal Node subprocess fixture that loads the extension through Pi's SDK and attempts a policy-denied operation. Verify inherited `1` permits it and inherited `0` blocks it.
- Ensure subprocess setup merges the existing environment rather than unintentionally discarding required runtime variables. Use temporary configuration and guaranteed process/filesystem cleanup.
- Do not depend on `pi-subagents` or modify its code to run these tests.
- If a new test entry point is needed, add it to this package's `npm test` command.

### 4. Document the user-facing contract

File: `README.md`, under YOLO mode.

- Document `PI_MINIMAL_PERMISSION_SYSTEM_YOLO=1` and `=0`.
- Explain explicit flag precedence, `--no-yolo`, and the conservative outcome when both flags are supplied.
- Explain that startup and `/yolo` publish a default for future sessions, while active sessions keep independent effective settings.
- State that in-process inheritance is process-wide, not parent-specific, and that subprocess launchers must preserve the environment and load the extension.
- Keep the distinction between YOLO inheritance and per-subagent permission policies clear.

### 5. Final verification

- Run `npm run check` from this submodule.
- Review the diff for unintended changes to policy loading, precedence, matching, cancellation, or nested tool enforcement.
- Confirm no other submodule or Pi SDK code changed.
- Do not commit, release, or update the parent repository's gitlink as part of this plan.

## Acceptance criteria

- Future in-process sessions and environment-inheriting subprocess sessions can enable YOLO without an explicit `--yolo` flag.
- Explicit on/off flags override the inherited setting.
- Session initialization and parent toggles cannot overwrite another running session's effective YOLO state.
- Parent toggles publish the default used by subsequently started sessions.
- Unset or invalid environment values do not enable YOLO.
- Existing permission behavior remains intact when YOLO is off, and existing bypass behavior remains intact when it is on.
- Tests isolate environment changes, and `npm run check` passes.

## Status

Implemented and verified.

- YOLO state is local to each extension instance. Startup and `/yolo` publish the process-wide default for future sessions.
- Explicit `--yolo` and `--no-yolo` flags override the environment; `--no-yolo` wins when both are supplied.
- Behavior tests cover flag precedence, invalid environment values, publication, and active-session isolation in both toggle directions.
- Real Pi integration tests cover inherited nested writes, explicit flag overrides, and subprocess inheritance with YOLO on and off.
- `npm run check` passed both normally and with ambient `PI_MINIMAL_PERMISSION_SYSTEM_YOLO=1`. `git diff --check` passed.
- No SDK or launcher changes, commits, releases, or gitlink updates were made.
