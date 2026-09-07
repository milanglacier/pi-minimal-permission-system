# Goal
Make an unanswered permission confirmation cancellable when the user aborts a Pi turn, without ever executing the unapproved tool. Apply the fix in this source repository: `/home/milanglacier/Desktop/personal-projects/pi-minimal-permission-system`.

Implementation is now complete in this source checkout; validation results are recorded below. Pi configuration and live session state remain unchanged.

## Related Tau work
The incident investigation and coordinated Tau fix plan are at `/home/milanglacier/Desktop/personal-projects/tau/.plans/active/debug-session-hang-and-unaborteable/plan.md`.

This plan owns the permission-extension change and its tests. Tau separately owns server-retained dialogs, reconnect recovery, cancellation replies for extensions that omit signals, and honest Abort status. The extension fix must work through Pi's native cancellation support without depending on those Tau changes or requiring a Pi fork.

## Findings and scope
- Before this fix, this checkout's `index.ts` awaited `ctx.ui.confirm("Permission Required", formatAskPrompt(result))` without passing a cancellation signal.
- Permission checking happens before tool execution. A bash execution timeout therefore does not bound an unanswered approval wait.
- The original investigation found that Pi 0.85.1 exposes `ctx.signal` and accepts a signal in confirmation options. Its RPC Abort aborts the agent and waits for idle, but a confirmation without a signal can leave the permission hook waiting indefinitely.
- The historical Tau session ended with an unanswered bash tool call that matches the current permission policy's ask rule. This is consistent with the mechanism, not proof of the historical cause. Whether YOLO was enabled in the original process remains unknown.
- Preserve the extension's existing scope (`bash`, `read`, `edit`, and `write`), policy precedence, explicit denials, and default-ask behavior. Do not change command matching or permission configuration to work around the hang.

## Local source loading
- This machine loads the extension through `~/.pi/agent/extensions/pi-minimal-permission-system`, a symlink to `/home/milanglacier/Desktop/personal-projects/pi-minimal-permission-system` (verified during implementation), rather than an npm download.
- Target the latest Pi behavior only, as requested during implementation. The global Pi CLI, Tau's integration-test dependency, and npm's latest release are all `0.85.1`; no legacy Pi compatibility paths were added. This checkout's pre-existing development dependency remains `0.83.0`; it was not reinstalled, and runtime acceptance is validated against Tau's current `0.85.1` dependency. The current API explicitly types `ctx.signal` as `AbortSignal | undefined`, so optional access follows the current contract rather than supporting older versions.
- Treat this checkout as the implementation and local deployment target. Do not patch `~/.pi/agent/npm/node_modules/pi-minimal-permission-system` or other installed copies.
- `package.json` points both the package entry point and Pi extension entry to `./index.ts`; this fix belongs in source, not generated `dist/` files.
- No npm publication or installation is required to use the fix locally. Before runtime validation, verify that the disposable process resolves the symlink to this checkout and does not also load an npm copy. Do not change the user's loading configuration without permission.
- Already-running processes may retain old extension code. Arrange a safe reload/restart with the user after validation; never restart live sessions automatically. Publishing a release is optional separate work.

## Implementation plan

### 1. Add bounded regression coverage before changing enforcement
Work from this repository. Extend `tests/permission-system.test.ts`, which is the current `npm test` entry point, using the existing isolated configuration and extension-handler test setup.

- Reproduce an ask-policy tool call whose confirmation stays unanswered, then abort its active turn signal. Before the fix, a bounded test must expose that the handler does not settle; after the fix, it must settle as blocked.
- Make the confirmation test double honor the supplied signal, including an already-aborted signal, rather than returning an immediate denial regardless of cancellation. Use explicit synchronization to know the confirmation is waiting, bounded deadlines, and cleanup of pending waits/listeners.
- Cover already-aborted signals, ordinary approval, explicit denial, absent UI, and YOLO enabled before preflight. Exercise cancellation for all four supported tools, since they share the ask path.
- Verify that an unanswered confirmation may continue waiting while the turn is not aborted. Do not introduce an arbitrary approval deadline.
- Cover cancellation racing with approval: if the turn signal is already aborted when the permission handler resumes, it must not return permission to execute the tool.
- Preserve the distinction between YOLO bypass before a hook starts and toggling YOLO after a confirmation is already pending. A later toggle must not implicitly approve that pending request.

### 2. Connect permission confirmation to turn cancellation
File: `index.ts`, in the ask-policy branch of the `tool_call` handler.

- Pass the active `ctx.signal` in the options to `ctx.ui.confirm` using the supported Pi API.
- Keep the result fail-closed. A cancelled or already-aborted confirmation must return a blocking result, not permission to execute the tool. Check the active signal when handling the confirmation result so a concurrent approval does not override cancellation already observed by the handler.
- Distinguish cancellation from an explicit user denial where practical. Do not describe an aborted turn as a policy denial or imply that the user approved anything.
- Preserve normal approval, denial, no-UI behavior, and existing YOLO semantics. Do not automatically enable YOLO, change its persistence, add approval deadlines, or alter policy matching.
- Keep the change small and use Pi's existing cancellation support. Do not introduce a replacement dialog lifecycle or unrelated agent behavior in the extension.

### 3. Validate the real Pi cancellation path
Unit tests alone do not establish that RPC Abort releases a real turn. Coordinate the runtime regression with the Tau plan's real Pi session/RPC coverage rather than duplicating a large integration harness unnecessarily.

- Use a disposable session with isolated settings/policy and a fake streaming provider plus a harmless execution sentinel. Load this checkout's extension explicitly, without duplicate global/npm loading.
- Leave a permission request unanswered and verify that the tool has not started. A short bash timeout must not be mistaken for a deadline on the preflight approval wait.
- Send native RPC Abort without relying on Tau's fallback cancellation replies. Assert that the turn reaches idle within a bounded deadline, no unapproved tool executes, and a subsequent instruction can run.
- Verify normal approval/denial and that ordinary running-tool cancellation still works. YOLO enabled before preflight must skip confirmation; it must not be used as the recovery mechanism.
- Keep the real-Pi regression reproducible and record where it lives and how it was run. If it lives in Tau's test suite, ensure it loads this source checkout rather than an npm copy.
- Never replay the incident's Docker/Nix command, alter the supplied session JSONL, or use a live user session as the test fixture.

### 4. Run checks and validate local adoption
- Run `npm run check` in `/home/milanglacier/Desktop/personal-projects/pi-minimal-permission-system` (strict TypeScript checking and the behavior tests).
- Run the bounded real-Pi regression described above and report any runtime/API compatibility limitations rather than substituting a mocked Abort acknowledgement.
- Confirm source loading through the existing symlink in a disposable process. Report that existing sessions require an approved safe reload/restart to adopt the change; do not perform it automatically.
- Do not publish, install an npm package, modify Pi configuration, or change the symlink as part of this fix unless separately requested.

## Implementation and validation results
- `index.ts` now captures the active turn signal, blocks already-aborted asks, passes the signal to confirmation, and checks it again before accepting approval. Cancellation has a distinct blocking reason.
- `tests/permission-system.test.ts` covers cancellation across all supported tools, the approval/abort race, already-aborted signals, indefinite non-aborted waiting, explicit approve/deny, absent UI, and YOLO before and during preflight.
- `npm run check` passes in this repository (25 behavior tests plus strict TypeScript checking).
- Real Pi RPC coverage lives in Tau's `test/permission-rpc.test.ts` with `test/fixtures/permission-rpc-provider.ts`. Run `node --test test/permission-rpc.test.ts` from the Tau repository; it also runs in `npm test`. All six scenarios pass against this source checkout: unanswered approval beyond the bash timeout followed by native Abort and a subsequent prompt; approval; denial; YOLO before preflight; YOLO toggled during an existing request; and aborting an approved running bash command.
- The runtime regression failed against a disposable copy of pre-fix Git revision `6fd96a4`: native Abort did not acknowledge within five seconds, while the execution sentinel remained absent. All six tests pass against the fixed source, including repeated runs.
- The runtime tests use disposable directories and the real Pi 0.85.1 CLI, without Tau cancellation replies, network/model calls, npm installation, or changes to live sessions. Existing loaded processes still need a user-approved safe reload/restart to adopt the fix.

## Acceptance criteria
- An unanswered permission request remains a valid wait for explicit approval, but aborting the turn reliably releases it through Pi's native signal support.
- Cancellation, including an already-aborted signal and an approval/cancellation race observed by the handler, never authorizes an unapproved tool.
- After native Abort, the disposable real Pi session becomes idle and accepts another instruction without requiring Tau's dialog-cancellation fallback.
- Existing approve/deny/no-UI behavior, policy precedence, and YOLO semantics remain intact; all supported tools retain permission enforcement.
- `npm run check` passes, and runtime validation uses this source checkout rather than a stale npm installation.
- Tau-specific reconnect recovery and truthful stop reporting remain tracked in the linked Tau plan; this extension fix alone does not claim to solve those UI/server problems.
