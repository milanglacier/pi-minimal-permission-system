# Evaluate permission rules per shell command

## Goal

Allow temporary-directory cleanup without approval while asking before other forced deletions in the same bash tool call.

```bash
tmp=$(mktemp -d)
# Work inside the temporary directory.
rm -rf "${tmp}"
```

Users should be able to allow this workflow with readable regex exceptions. Adding `rm -rf ~/important` anywhere in the script should require approval under the example policy below.

Bash rules currently match the complete tool input. An unanchored cleanup exception can therefore allow unrelated commands in the same string. An anchored exception avoids that problem but cannot match cleanup inside a compound script.

Introduce shell parsing to apply rules to individual commands. Keep the existing JSONC format, regex matching, and rule order. Temporary paths and variable names belong in user configuration, not extension code. Configurable priorities and structured argument rules are outside this plan.

## Permission rules

### Resolve each command independently

Apply the existing rules to each command's source text:

- The last matching rule wins.
- No match means `ask`.
- Project rules cannot override the last matching global rule if it is `deny`.
- Within global configuration, a later matching allow can override an earlier deny.

### Combine the results

Combine the resolved decisions using `deny > ask > allow`. Any deny blocks the whole tool call. Otherwise, any ask requires one approval for the whole call. Allow only when all decisions allow.

This ordering applies across commands, not across matching rules. Analyze the input before execution; do not run approved portions separately. Preserve file-tool behavior, YOLO bypass, no-UI blocking, and cancellation handling.

## Parsing scope

Inspect shell structure without executing the input or resolving runtime values. Traverse command lists, pipelines, background jobs, groups, subshells, conditions, loops, case branches, and function bodies. Inspect all syntactically present branches without predicting which will execute.

Inspect nested commands in command substitutions, backticks, and process substitutions, including those in assignments, redirections, and expandable heredocs. Quoted separators, comments, and literal heredoc content must not create commands.

Use each simple command as a matching unit. Preserve its assignment prefixes and redirections. Assignment-only and redirection-only statements are also units; inspect their nested commands separately. For example, `tmp=$(mktemp -d)` yields the assignment and the nested `mktemp -d` command.

Do not match whole compound containers in addition to their commands. That would allow rules to span unrelated sibling commands again. A simple command containing a substitution remains a unit, but its allow decision cannot override an ask or deny from the nested command.

### Strings and runtime behavior

Parse only shell syntax present in the original input. Do not extract string arguments and parse them again as scripts, even when their contents are literal and valid shell code.

For example, `bash -c "echo hello; echo world"` is one matching unit. Its string argument does not yield separate commands. Apply the same principle to other commands that interpret strings or refer to external code; no command-specific payload analysis is needed.

Executable substitutions already represented in the original shell syntax remain in scope. For example, `bash -c "echo $(whoami)"` contains a command substitution that must be inspected, but the surrounding string is not reparsed as a script.

Match commands with dynamic values or unresolved behavior normally. They do not automatically require approval. User regex rules decide permissions, and source-text rules may match text inside arguments.

### Fallback

If top-level parsing, parser initialization, or complete command extraction fails, match the entire original bash input as one string. Use the existing rule order and global/project precedence. Replace partial extraction results with this fallback decision; do not add an automatic ask. No match still means `ask`.

Use the same fallback when extraction yields no commands, such as empty or comment-only input. Bound analysis work to avoid excessive resource use.

Whole-input fallback preserves existing behavior but does not provide per-command isolation. Document this limitation.

## Parser integration

Evaluate `sh-syntax` first. It exposes `mvdan/sh` through WASM with a JavaScript/TypeScript API. Verify Bash coverage, error reporting, source ranges, ESM compatibility, and runtime asset loading from an installed Pi extension. Consider `tree-sitter-bash` if it better meets these requirements. Handle recovery nodes and parse errors explicitly.

References:

- https://github.com/un-ts/sh-syntax
- https://github.com/mvdan/sh
- https://github.com/tree-sitter/tree-sitter-bash

Add a parser adapter in `src/shell.ts`. Return command units with source locations and explicit fallback information. Keep parser-specific types out of permission resolution.

Match trimmed slices of the original input while preserving quoting and internal whitespace. Do not pretty-print, expand commands, or reparse string arguments. Verify byte offsets versus JavaScript string offsets with Unicode tests.

## README example

Use a small example that readers can adapt:

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
    "^rm -rf \"\\$\\{tmp\\}\"$": "allow"
  }
}
```

The `rm -r` rule also matches `rm -rf`. Later anchored exceptions allow cleanup only for the matching command.

Explain the example's limits:

- It covers common single-space spellings, not every whitespace or flag variation.
- The path exception covers a named direct child of `/tmp`, not the directory itself, `.` or `..`, nested paths, or extra operands.
- The exceptions allow `rm -rf`; `rm -f` still asks.
- The variable exceptions trust `$tmp` by name. Parsing does not verify its value or whether it came from `mktemp`.

Parsing and regex matching are not a shell sandbox or a guarantee of filesystem safety.

## Implementation steps

1. **Validate the parser.** Test syntax coverage, source ranges, and packaged runtime assets. Select the dependency and update the lockfile.
2. **Extract commands.** Implement `src/shell.ts` with typed results, explicit traversal of the original syntax tree, and bounded analysis. Keep string arguments intact. Use `unknown` and narrowing at external boundaries.
3. **Resolve and combine decisions.** Reuse `resolveRuleMatch` from `index.ts` and matching in `src/matcher.ts`. Evaluate units separately before combining results. Passing all units to one `findLastMatch` call would incorrectly let one matching rule decide for unrelated commands.
4. **Integrate the bash check.** Replace the bash branch of `checkPermission` in `index.ts`. Support asynchronous parsing if needed, initialize lazily, and reuse the parser. Keep YOLO bypass ahead of initialization.
5. **Explain decisions.** Extend `PermissionCheckResult` in `src/types.ts` to retain the original input, decisive command, matched rule and layer, and fallback details where relevant. Prompt once. Use source order to choose a stable explanation among equally restrictive decisions.
6. **Document the behavior.** Update `README.md` with the example, precedence, parsing coverage, fallback, and migration notes. Do not modify the user's live configuration.
7. **Verify the integration.** Run `npm run check` and test parser loading from an installed package.

## Compatibility

The JSONC schema remains unchanged. On successful extraction, regexes match individual commands rather than the complete script. Anchors refer to a command unit. Rules spanning multiple statements or pipeline stages need migration, including global deny rules written that way.

Do not add a whole-script allow pass after successful per-command evaluation. Document the behavior change and choose an appropriate release version. Preserve file-tool matching and policy cache behavior.

## Acceptance tests

### Temporary cleanup

Under the README policy:

| Input | Result |
| --- | --- |
| `rm -rf /tmp/tmp.ABC123` | allow |
| `rm -rf "$tmp"` | allow |
| `rm -rf "${tmp}"` | allow |
| `tmp=$(mktemp -d); rm -rf "${tmp}"` | allow |
| `rm -rf ~/important` | ask |
| `rm -f /tmp/test` | ask |
| `rm -rf "$tmp"; rm -rf ~/important` | ask |
| `rm -rf ~/important; rm -rf "$tmp"` | ask |
| `rm -rf /tmp/test ~/important` | ask |
| `rm -rf /tmp` or `rm -rf /tmp/..` | ask |
| `echo "$(rm -rf ~/important)"; rm -rf "$tmp"` | ask |

### Parsing and string arguments

- Command separators, compound structures, and nested execution are traversed correctly.
- Quotes, comments, and heredocs do not create phantom commands; expandable heredoc substitutions are inspected.
- Unicode offsets preserve command text.
- Script strings are not reparsed. `bash -c "echo hello; echo world"` remains one matching unit.
- Rules match the complete invocation, including its string arguments.
- Executable substitutions in the original syntax tree are inspected even when they appear inside a script string argument.
- Commands that cannot be interpreted further retain normal allow, ask, and deny matching. Unresolved behavior alone never adds an ask.
- Inspection does not execute user input to recover code.

### Fallback and enforcement

- Top-level failures and empty extraction use the complete original input and existing precedence. Test allow, ask, deny, and no-match outcomes.
- Partial extraction results do not override a whole-input fallback decision.
- After successful extraction, a deny in any unit blocks the call regardless of later cleanup allows.
- Global/project precedence remains unchanged within each unit.
- One prompt covers the complete input and explains the decisive match, including fallback when applicable.
- No-UI blocking, cancellation, YOLO, file-tool rules, and cache invalidation retain their existing behavior.

## Completion criteria

The documented policy allows the temporary-cleanup workflow while asking before an unrelated forced deletion in the same successfully parsed script. Commands in the original shell syntax are inspected; string arguments are not reparsed. Unresolved commands use ordinary regex matching, and parsing failures use whole-input matching. Tests and `npm run check` pass, and the installed extension loads the parser successfully.
