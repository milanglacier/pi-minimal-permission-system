# Review: fix/abort-permission-waits (extension side of the joint change)

Reviewed on 2026-09-07 together with the matching `fix/abort-permission-waits` branch in
Tau. The Tau-side review lives in that repository's
`.plans/active/debug-session-hang-and-unaborteable/review.md`.

## Verdict

Correct, minimal, and well tested. Ready to merge. No blocking findings.

## Does the plan solve the bug?

Yes. The diagnosis matches the Pi 0.85.1 sources:

- `ctx.ui.confirm` in RPC mode is implemented by `createDialogPromise`, which resolves only on
  an `extension_ui_response`, an explicit `timeout`, or an abort of `opts.signal`. The old
  call passed neither a timeout nor a signal, so the `tool_call` hook could wait forever.
- `ctx.signal` is the agent's per-run abort signal, which RPC `abort` triggers before waiting
  for idle. Passing it is the supported way to make the hook cancellable, and it is what the
  interactive TUI dialogs already honour.
- Pi resolves an aborted confirm to `false` and deletes its pending record without emitting
  anything to the RPC client. That is why the Tau side still needs its own dialog registry and
  cancellation replies for the browser, even though the extension fix alone releases the hook.

The plan is right not to add an approval deadline or auto-enable YOLO. An unanswered request
staying open while the turn is alive is the intended behaviour.

## Does the implementation make sense?

Yes. The change to `index.ts` is twelve lines and does three things, all needed:

- Returns a blocking result immediately if the signal is already aborted, so a hook entered
  after Abort never opens a dialog.
- Passes `{ signal }` to `ctx.ui.confirm`.
- Re-checks `signal.aborted` after the await. In RPC mode an aborted confirm already resolves
  to `false`, so this check mostly matters for the distinct reason text and for the genuine
  race where an approval response arrives and Abort fires before the handler resumes. That
  race is real: Pi processes stdin lines in order and the continuation runs as a microtask,
  so the re-check is the only thing that keeps "approve then abort in the same tick" from
  executing the tool.

The cancellation reason is deliberately different from the denial reason and does not carry
the "Hard stop" wording, so the model is not told the user refused when the user actually
stopped the turn. Policy matching, no-UI behaviour and YOLO semantics are untouched.

## Do the tests make sense?

Yes.

- `createDeferredConfirm` honours the supplied signal, including an already-aborted one, and
  exposes a `started` promise so the tests know the dialog is actually open before aborting.
  This is what makes the abort tests deterministic instead of timing-based.
- Each of the four supported tools gets an abort-while-waiting case, since they share the
  ask path.
- The race test resolves approval and then aborts synchronously before yielding. Without the
  post-await re-check that test returns `{}` and fails, so it is a real regression test, not
  a tautology.
- The "keeps waiting" test asserts both that no `timeout` option was passed and that the
  handler stays pending while the turn is alive, which guards the "no arbitrary deadline"
  requirement.
- YOLO before preflight and YOLO toggled while a request is pending are both covered, and
  the latter confirms a later toggle does not approve the request that was already open.

`npm run check` passes locally: strict typecheck plus 25 behaviour tests.

The real-Pi runtime regression lives in Tau's `test/permission-rpc.test.ts` and loads this
checkout's `index.ts` directly. I ran it against a throwaway worktree of `master` (with
`node_modules` linked, since a bare worktree has no `jsonc-parser`) and the two
abort-related scenarios fail there with "Timed out after 5000ms waiting for abort
acknowledgement" while the execution sentinel stays absent. Against this branch all six pass.

## Minor notes

- The `cancelled` result object is rebuilt on every ask. A module-level constant would be
  marginally tidier, but it is not worth a follow-up on its own.
- The checkout's development dependency is still Pi `0.83.0` while the runtime target is
  `0.85.1`. Typechecking passes, so `ctx.signal` and the confirm `signal` option exist in
  both, but bumping the dev dependency would remove the mismatch the plan calls out.
- Existing Pi processes still have the old extension loaded. Adoption needs a user-approved
  reload of those sessions, as the plan says.

---

# Fix summary (appended after the review above, same day)

Both minor notes above were addressed. The original review text is unchanged. All changes
are in the working tree and uncommitted.

## Cancellation result hoisted to a constant

`index.ts` now defines a module-level `CANCELLED_BY_ABORT` result, typed as
`ToolCallEventResult`, with a comment stating that it is deliberately not a denial. The
`tool_call` handler returns it from both the pre-check and the post-await re-check. Behaviour
and the reason text are unchanged.

## Pi development dependency aligned with the runtime target

`package.json` now declares `@earendil-works/pi-coding-agent@^0.85.1` under
`devDependencies`, and `package-lock.json` was regenerated by `npm install`, so strict
typechecking and the behaviour tests run against the same Pi line as the real-Pi validation
in Tau. The `peerDependencies` range stays `*` on purpose: the signal API this fix relies on
also exists in earlier releases, so consumers on 0.83 are not pushed to upgrade. The plan's
"Local source loading" section was updated to say this instead of describing the old 0.83.0
install.

## Verification after the fixes

| Check | Result |
|---|---|
| `npm run check` (typecheck against Pi 0.85.1 plus behaviour tests) | 25/25 pass |
| Tau `node --test test/permission-rpc.test.ts` against this checkout | 6/6 pass |
| `git diff --check` | clean |

Running Pi sessions still hold the old extension code and need a user-approved reload to
adopt the fix; nothing was restarted.

---

# Second round of review (extension side)

Reviewed the branch again after the first round's fixes landed, as the extension half of the
joint change with Tau's `fix/abort-permission-waits`. The Tau-side second round is in that
repository's `.plans/active/debug-session-hang-and-unaborteable/review.md`.

`npm run check` passes here (strict typecheck plus 25 behaviour tests), and Tau's full suite
passes 223/223 with nothing skipped, which includes the six real-Pi RPC scenarios that load
this checkout's `index.ts`.

## Verdict

Still correct, still minimal, and I would still merge it. The plan describes the real
mechanism, the twelve-line change is the right fix for it, and the tests genuinely fail
without it. This round I went looking specifically for ways the change could fail open or
could behave differently outside RPC mode, and found none.

## What this round re-verified

- Capturing `const signal = ctx.signal` **before** the await is load-bearing, not incidental
  style. Pi types `ctx.signal` as `AbortSignal | undefined` and documents it as undefined when
  the agent is not streaming, so re-reading `ctx.signal` after the confirmation resolved could
  silently hand back `undefined` and lose the abort. The current code reads it once and
  re-checks that same captured signal, which is the correct shape.
- Neither Pi UI implementation rejects on abort, so the fix does not depend on catching
  anything. RPC's `createDialogPromise` resolves the confirm to its default `false` and deletes
  its pending record; the interactive mode routes `confirm` through `showExtensionSelector` and
  maps a non-"Yes" result to `false`. In both modes the raw result is indistinguishable from a
  user pressing No, which is exactly why the post-await `signal?.aborted` re-check is what
  keeps an aborted turn from being reported to the model as a user denial. Both the pre-check
  and the re-check are needed and neither is redundant.
- Pi's `emitToolCall` does not wrap `tool_call` handlers in try/catch the way `emitUserBash`
  does, so it matters that this handler always returns a result rather than throwing. It does.
- The "approve then abort in the same tick" test is a real regression test rather than a
  tautology, and it matches the real ordering: Pi's stdin reader dispatches each line with
  `void handleInputLine(line)`, so when an approval and an abort arrive in the same chunk the
  abort's synchronous `session.abort()` runs before the extension's continuation microtask and
  the re-check sees the aborted signal.

## Findings

1. Low — `index.ts`, the ask branch of the `tool_call` handler. When `ctx.signal` is
   `undefined`, the extension passes `{ signal: undefined }` and the confirmation is unbounded
   again, which is precisely the pre-fix behaviour. Nothing in `tests/permission-system.test.ts`
   covers that path: every cancellation test supplies a controller. In practice a `tool_call`
   hook only fires inside an agent run, so the signal should always be present, and Tau's
   dialog registry would be the fallback — but this plan explicitly says the extension fix must
   work without depending on Tau. A single test asserting what happens with no signal, or a
   comment stating that the unbounded wait is knowingly accepted there, would make the
   assumption visible instead of implicit.

2. Nit — the cancellation reason text ("Permission request cancelled because the agent turn
   was aborted.") is asserted in the tests only through the regex `/cancelled.*aborted/i` plus
   the negative `/denied|policy-enforced|Hard stop/i`. That is the right thing to pin, since the
   distinction from a denial is the point, but the wording itself is now part of what the model
   sees on an aborted turn and no test pins it exactly. Worth a single equality assertion if the
   exact phrasing is meant to be stable.

## Nothing outstanding from round one

Both minor notes from the first round were addressed as described: the cancellation result is
a module-level `CANCELLED_BY_ABORT` constant typed as `ToolCallEventResult`, and the Pi
development dependency is now `^0.85.1`, matching the line the runtime validation runs against
while `peerDependencies` stays `*` on purpose.

As before, no Pi configuration, symlink, session file, or live process was touched; running
sessions still hold the old extension code and need a user-approved reload to adopt the fix.
