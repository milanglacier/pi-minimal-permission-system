# Treat approval prompts as unavailable when a host says no person is present

## Goal

Let a host that runs Pi without a person tell this extension so, and have
`ask` rules block with the existing no-UI reason instead of opening a dialog.

The motivating host is the subagent runner in `pi-subagent-skill`. It runs
each subagent as `pi --mode rpc` and answers every dialog request with
`cancelled: true`, because nobody can answer it. A cancelled `confirm`
returns `false`, so the extension reports "User denied ... Hard stop" to the
model. That reason is wrong: no person saw the request. The subagent then
tells its caller that the user refused the operation.

Draft plan; not yet approved.

## Confirmed scope

- Add one environment variable, `PI_MINIMAL_PERMISSION_SYSTEM_NONINTERACTIVE`.
  The value `1` means that no person can answer approval prompts.
- Change only how `ask` decisions are resolved. `allow`, `deny`, policy
  loading, rule matching, codemode syntax checks and YOLO stay as they are.
- Do not detect the host from `ctx.mode`. `pi --mode rpc` is also used by
  hosts that forward dialogs to a person, such as pi-tau-web-server.
- Do not add a CLI flag. Pi exits with "Unknown option" for a flag that no
  loaded extension registers, so a host could not pass the flag
  unconditionally. An environment
  variable is ignored when the extension is missing.
- Do not publish or rewrite the variable in `process.env`. Unlike YOLO, it
  describes the host process, which sets it for its child.

## Current implementation

- Pi 1.0.4 binds a UI context in RPC mode unconditionally
  (`modes/rpc/rpc-mode.js`, `rebindSession`), and `ctx.hasUI` only checks
  whether that context is the no-op one (`core/extensions/runner.js`). An RPC
  host has no way to make `ctx.hasUI` false.
- `index.ts` has two approval paths:
  - Covered tools (`bash`, `read`, `edit`, `write`): the `tool_call` handler
    checks `!ctx.hasUI` and returns `formatUnavailableReason(result)`;
    otherwise it calls `ctx.ui.confirm("Permission Required", ...)` and
    returns `formatUserDeniedReason(result)` when the answer is `false`.
  - Codemode: `enforceCodemode` checks `!ctx.hasUI` and returns the codemode
    no-UI reason; otherwise it calls `ctx.ui.confirm("Codemode Permission
    Required", ...)` and returns "User denied codemode script" on `false`.
- `loadPolicy` also uses `ctx.hasUI`, to decide whether to show policy
  warnings with `ctx.ui.notify`. Notifications are not approvals and need no
  answer.

## Behavioral contract

- At `session_start`, read the variable once into an instance-local boolean,
  next to `yoloEnabled`. It is on only when the value is exactly `"1"`.
  Unset, `"0"` and any other value leave it off.
- Approval is available when `ctx.hasUI` is true and the boolean is off.
  Both approval paths use this one check in place of `ctx.hasUI`.
- When approval is unavailable for either reason, the result is the existing
  no-UI block, with the existing reason text, and no dialog is opened.
- YOLO is evaluated first, as today. With YOLO on, the variable has no effect.
- `loadPolicy` warnings keep using `ctx.hasUI`.
- A running session keeps the value it read at startup.

| `ctx.hasUI` | Variable | `ask` result |
| --- | --- | --- |
| false | any | No-UI block |
| true | unset, `0`, invalid | Dialog |
| true | `1` | No-UI block, no dialog |

## Implementation steps

### 1. Runtime

File: `index.ts`.

- Add a constant for the variable name beside `YOLO_ENV_VAR`.
- Add the instance-local boolean inside `minimalPermissionExtension` and set
  it in `session_start`.
- Add a small helper that answers whether approval can be requested, and use
  it at both `!ctx.hasUI` checks. `enforceCodemode` receives the boolean or
  the helper as an argument, since it is a module-level function.

### 2. Behavior tests

File: `tests/permission-system.test.ts`.

- Save and restore the variable in the harness, as it does for the YOLO
  variable, and start ordinary tests with it unset.
- With `hasUI: true` and the variable `1`: an `ask` rule for each covered tool
  blocks with the no-UI reason and `confirm` is never called.
- The same for an `ask` codemode policy.
- With the variable unset, `0` or `true`: the dialog opens as before.
- `allow` and `deny` rules give the same results with the variable `1`.
- YOLO on with the variable `1`: calls pass.
- Changing the variable after `session_start` does not change the running
  session.

### 3. Documentation

File: `README.md`.

- Next to the sentence that says approval requests are blocked without an
  interactive UI, document `PI_MINIMAL_PERMISSION_SYSTEM_NONINTERACTIVE=1`:
  what it does, that it is meant for hosts that run Pi without a person (for
  example an RPC host that cannot show dialogs), and that it never weakens a
  policy.

### 4. Verification

- `npm run check` from this submodule.
- Review the diff for changes to `allow`/`deny` handling, matching, abort
  handling and YOLO.
- Do not commit, release or bump the parent gitlink as part of this plan.

## Acceptance criteria

- With the variable `1`, no `ask` rule opens a dialog, and the block reason
  says that no interactive UI is available.
- Without it, behavior is unchanged.
- The variable never turns an `ask` or `deny` into an allow.
- `npm run check` passes.
