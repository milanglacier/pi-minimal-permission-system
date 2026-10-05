# Goal

When a tool call is blocked by a permission policy or an approval is denied, let the agent learn the specific reason from the existing tool error: which kind of block occurred, and which matching rule produced that outcome. Cover `bash/read/edit/write`, codemode script checks, and protected tool calls nested inside codemode. Plan only; do not modify implementation code.

## Confirmed scope

- Show only the matching rule and status, not the rule source (global/project layer) or the source config file path. Do not add a custom `reason`, and do not change the JSONC config format.
- Return the tool or operation target, the block type, and the effective rule's pattern/selector with its `ask/deny` status; do not show global/project layer markers and do not add a file-source field.
- When an ordinary tool matches no rule, state explicitly that the built-in default `ask` applies; do not fabricate a matching rule.
- When an ask has no UI, both show the specific rule that caused the approval request and explain that the current non-interactive run has no interactive UI available, so the approval request cannot be presented for the user to review or approve, and the operation is therefore blocked.
- Use the existing `tool_call` return `{ block: true, reason }`; do not send a separate chat message and do not add cross-call denial records or aggregation mechanisms.
- Pass details for nested calls through the existing exception path. Uncaught exceptions, or exceptions a script explicitly surfaces, let the agent see the details; when a script catches them itself or hides them via `allSettled`, do not force an additional report.
- A turn abort still explicitly means cancellation, not disguised as user denial or policy deny; keep the cancellation wording and race handling.
- This change does not add rule-source display, and removes the existing global/project layer text from denial wording and approval prompts. File paths in existing config load/validation errors are pre-existing diagnostics and stay unchanged; the tool operation target path is still kept.
- Do not update `README.md` or `docs/`; the exact error wording is an implementation detail.

## Basis of the current implementation

- `index.ts`: `formatDenyReason` for ordinary tools already shows the pattern but includes `from global/project config` layer text; `formatUserDeniedReason` and `formatUnavailableReason` have no rule information. `formatAskPrompt` has a match summary.
- `PermissionCheckResult` and `RuleMatch` already include the status, `matchedPattern`, and `matchedLayer`, enough to explain the effective rule for ordinary tools; `matchedLayer` stays in the match result but is not used for display in this change.
- codemode's `formatCodemodeMatches` already shows the selector, status, and layer; when an approval is denied, no matching rule is attached. This change drops the layer from display.
- `src/codemode.ts` returns all matching selectors and decides the outcome with `deny > ask > allow`; a failed check has a separate `kind: block` diagnostic.
- Pi's `ToolCallEventResult` supports `reason`. Both top-level and nested calls go through the `tool_call` interception path; the existing real codemode integration tests can inspect the model-facing tool result.
- No need to modify `src/types.ts`, `src/config.ts`, or `src/matcher.ts`, and no need to add `configPath` or `matchedConfigPath`; the `matchedLayer` field stays for existing logic and is only removed from the display layer.

## Behavioral contract

1. **Explicit deny**: state that the policy prohibits it, show the matching rule that actually decided the outcome and its `deny` status; keep the existing hard-stop guidance.
2. **Ask denied by the user**: state that the user did not approve this operation, show the matching rule that triggered the approval request and its `ask` status, or the built-in default ask. Do not write the rule as deny; keep the existing hard-stop guidance.
3. **Ask with no UI**: show the specific matching rule and status that led to the final ask, and explain that a non-interactive run has no UI, so the approval request cannot be presented for user review or approval, and the operation is blocked. Do not write it as user denial or policy deny. When no rule matched, show the built-in default ask.
4. **abort**: keep the existing cancellation result; do not add a hard-stop and do not change the priority between approval and abort.
5. **codemode check failure**: keep returning the existing config, selector, parse, or evaluation error diagnostics; do not fabricate a matched deny rule.

Display uses the existing English error style. Rule strings use explicit labels and JSON-style escaping to prevent newlines and control characters in patterns/selectors from confusing field boundaries. Do not show the source layer or source config file, do not dump the full config, and do not add script content output. Rule explanations everywhere show only the pattern/selector, status, and default ask, without distinguishing global/project.

Example result for an ordinary tool approval denied:

```text
User denied read on '/workspace/project/.env'.
Effective policy: read["**/.env*"] = ask
<existing hard-stop instruction>
```

When no rule matched:

```text
Effective policy: built-in default ask (no matching rule).
```

Example ask result with no UI:

```text
Read on '/workspace/project/.env' requires approval, but no interactive UI is available.
This non-interactive session cannot present the approval request for user review or approval. The operation is blocked.
Effective policy: read["**/.env*"] = ask
```

codemode shows the final status and matching rules, each keeping its selector and status, without layer and without adding file paths. Explicitly mark the matching rule with the same status as the final status as the decisive rule, and other matches as context; do not make an allow look like a denial reason.

## Implementation steps

### 1. Unify policy explanation for ordinary tools

File: `index.ts`.

- Extract a unified small policy summary formatter that outputs the tool, pattern, and status; when there is no match, output the built-in default ask description; do not output the global/project layer.
- Remove the `from global/project config` layer text from the existing `formatMatchSuffix` and approval prompts, keeping the pattern reference.
- Reuse the summary in `formatDenyReason`, `formatUserDeniedReason`, and `formatUnavailableReason`, keeping the different block types and operation targets.
- `formatUnavailableReason` also explains the rule that caused the ask, and why a non-interactive run cannot present the approval request for user review or approval.
- The ordinary approval prompt reuses the same rule summary, so the basis for approval shown to the user matches the error the agent receives.
- Only explain the existing decision; do not re-match or re-load, and do not modify match order, path candidates, or the global deny protection logic.
- Keep allow and successful approval returning `{}`; do not add an approval cache or permission bypass.

### 2. Complete codemode denial details

File: `index.ts`; do not change the decision algorithm in `src/codemode.ts`.

- Adjust `formatCodemodeMatches` to show only the selector and status, make clear the final status and the decisive match, and do not output the layer or `configPath`.
- Attach rule details consistently in the three codemode branches: policy deny, denied ask, and no UI.
- The codemode no-UI branch shows the selector that caused the final ask and explains that a non-interactive run cannot present the approval request for user review or approval, so the script is blocked.
- Approval prompts use the same rule explanation, keeping the existing 1,000-character script preview and control-character escaping.
- Keep the existing separate error explanations for config diagnostics, script parsing, and selector evaluation failures, including file paths in existing diagnostics.
- Preserve all abort branches and race protection.
- Nested ordinary tool calls automatically use the details from step 1; do not add `tool_result` interception or chat messages.

### 3. Verify the behavior added or adjusted in this change

Primary files: `tests/permission-system.test.ts`, `tests/codemode-integration.test.ts`.

Add or adjust tests only for the error explanations and propagation behavior actually implemented in this change; do not add "feature does not exist" assertions for features that are not implemented or not planned. Unchanged behaviors such as config loading, matching, cancellation, and YOLO are covered by existing test regressions; do not expand the test matrix for them. Existing cases that assert `global config` / `project config` layer text should be changed to assert the effective pattern/selector and status.

Ordinary tool error explanation tests:

- deny, denied ask, and no-UI scenarios show the correct effective pattern and status and contain no global/project layer text; cover bash and file tools by tool branch, and use the necessary parameterized cases to verify the summary for all four ordinary tools.
- User-denied and no-UI scenarios with no matched rule show the built-in default ask.
- The no-UI error explicitly expresses the effective ask rule, the non-interactive run, the absence of an interactive UI, and that the approval request cannot be presented for user review or approval.
- Use cases with competing matching rules to verify that the summary corresponds to the rule that actually took effect: project override and global deny protection; assert only the effective pattern and status, without rewriting the matching algorithm tests.
- Add actual behavior tests for JSON-style escaping of rule strings, covering quotes, newlines, and control characters.

codemode error explanation tests:

- deny, denied ask, and no-UI scenarios show the selector and status and contain no layer text.
- The no-UI result shows the selector that caused the ask, plus the explanation that a non-interactive run cannot present the approval request for user review or approval.
- The match summary for multiple rules (possibly across layers) accurately distinguishes the decisive rule from context rules.

Real Pi integration tests:

- Using the existing faux provider, isolated config, and in-memory session fixture, assert that the final codemode tool result contains the block reason and the specific rule, not just the handler's `reason`.
- Cover codemode's own deny, denied ask, and no UI, and, after an allowed/approved script, nested write's deny, denied ask, no UI, and default ask.
- Nested calls use uncaught exceptions, or explicitly output the caught error message, to verify that the new details reach the agent through the existing error path.
- Keep the existing write-block assertions and isolation cleanup; do not add dedicated tests for unchanged behavior such as no supplementary report after a script swallows an exception.

The existing `tests/codemode.test.ts` and permission tests continue to run with `npm run check`, to verify existing matching, config diagnostics, approval, cancellation, YOLO, and other behavior.

### 4. Final checks

- Confirm that `README.md` and `docs/` are not modified; the error wording is an implementation detail.
- Run `npm run check` in this submodule's cwd; require typecheck, behavior tests, and real Pi codemode integration tests to all pass.
- Check the git diff to ensure there are no unintended changes to rule loading, match semantics, config format, YOLO, or cancellation semantics.
- This plan does not include release or commit.

## Acceptance criteria

- From the existing error path, the agent can identify the matching rule and status that actually caused the block/approval, without needing the rule source (global/project layer or config file path).
- Default ask, user denial, no UI, policy deny, and check failure are not confused with one another.
- Ask-without-UI answers both "which rule requires approval" and "why it cannot be reviewed/approved this time": the specific ask rule or the built-in default ask, plus the explanation of non-interactive, no UI, and inability to present the approval request.
- Both codemode itself and nested protected tool calls can explain the effective rule, but do not force a supplementary report for exceptions swallowed by the script.
- Error wording does not distinguish global/project, showing only the block/approval type, effective pattern/selector, and status.
- Existing permission, security, config diagnostics, and cancellation semantics stay unchanged, and `npm run check` fully passes.

## Status

The plan has been updated per the latest requirements: use only existing match results to complete the error explanations; error wording does not show the global/project layer; README and docs are not updated; new tests only verify behavior actually added or adjusted in this change, and no missing-feature assertions are added for features that are not implemented or not planned. Implementation code has not been modified yet, and the verification checks for this implementation have not been run yet.
