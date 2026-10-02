# Codemode permissions

Codemode permissions inspect a script's JavaScript syntax before Pi runs it. They supplement the existing `bash`, `read`, `edit`, and `write` policies; they do not replace those runtime checks.

Codemode is available in Pi 0.99.1 and later. Configure syntax rules in the same global and project files used by the other permissions:

- Global: `~/.pi/agent/permissions.jsonc`, or `$PI_CODING_AGENT_DIR/permissions.jsonc` when that variable is set.
- Project: `<project>/.pi/agent/permissions.jsonc`.

## Add selector rules

The `codemode` section maps [esquery](https://github.com/estools/esquery) selectors to `allow`, `ask`, or `deny` states:

```jsonc
{
  "codemode": {
    "DebuggerStatement": "deny",
    "CallExpression[callee.name='eval']": "deny",
    "ForStatement, ForInStatement, ForOfStatement, WhileStatement, DoWhileStatement": "ask",
    "CallExpression[callee.type='MemberExpression'][callee.computed=false][callee.object.name='models'][callee.property.name='classify']": "ask"
  }
}
```

A selector matches when it selects at least one node in the script's AST. Each matching rule is counted once, even when its selector matches multiple nodes.

### Selector syntax

Acorn parses the script into an ESTree-compatible JavaScript AST, and esquery evaluates selectors against that tree. Use JavaScript AST node names such as `Program`, `DebuggerStatement`, `CallExpression`, `Identifier`, or `ForStatement`.

Selectors support:

- `*` to select any node.
- Attributes such as `[callee.name='eval']`, including equality and numeric comparisons.
- Multiple attributes on one selector to require all of them, as in `[callee.type='MemberExpression'][callee.computed=false]`.
- Comma-separated selectors to match any listed node type, as in the loop rule above.
- CSS-like relationships and pseudo-classes supported by esquery, including descendant, child, `:not(...)`, and `:has(...)` selectors.
- Case-insensitive node-category pseudo-classes: `:statement`, `:declaration`, `:pattern`, `:expression`, and `:function`.

Unknown node-category pseudo-classes invalidate the policy when it loads, including inside combined or nested selectors. This blocks codemode even when no script node would match the invalid selector.

Selector strings are JSONC strings. Single quotes inside a selector avoid additional escaping. If a selector needs double quotes, escape them for JSONC. This rule matches string literals whose value is `secret`:

```jsonc
{
  "codemode": {
    "Literal[value=\"secret\"]": "deny"
  }
}
```

Matching inspects executable expressions in both arguments of dynamic `import(...)`, including the options argument.

The parser and selectors work on syntax, not source text. A comment or string containing `eval("x")` is not a `CallExpression`. The direct-call selector `CallExpression[callee.name='eval']` matches `eval("x")`; it does not resolve aliases such as `const run = eval; run("x")`, nor computed access such as `globalThis["eval"]("x")`.

### Tested examples

The following selectors are covered by the test suite:

```jsonc
{
  "codemode": {
    "DebuggerStatement": "deny",
    "CallExpression[callee.name='eval']": "deny",
    "ForStatement, ForInStatement, ForOfStatement, WhileStatement, DoWhileStatement": "ask",
    "CallExpression[callee.type='MemberExpression'][callee.computed=false][callee.object.name='models'][callee.property.name='classify']": "ask",
    "Program": "ask"
  }
}
```

`Program` selects the submitted script root. It can be used to ask for approval for every script:

```jsonc
{
  "codemode": {
    "Program": "ask"
  }
}
```

## Defaults and precedence

When no `codemode` rules are configured, scripts are allowed without syntax parsing by this extension. A valid policy with rules also allows a script when none of its selectors match. An empty `codemode` object has the same default.

All matching codemode rules from both configuration layers are combined with this precedence:

1. `deny` blocks the script.
2. Otherwise, `ask` requires approval.
3. Otherwise, `allow` permits the script.

Declaration order does not change this order. Global and project rules remain separate, including rules with the same selector. A project `allow` cannot weaken a matching global `deny` or `ask`. An `allow` selector is not an exception to a matching `ask` or `deny`; for example, `Program: ask` asks about every script even if another selector says `allow`.

This differs from the original protected tools. `bash`, `read`, `edit`, and `write` default to `ask` and use their existing last-matching-rule behavior, while a matching global `deny` remains protected from project overrides.

## Approval and nested tools

A matching `deny` blocks before codemode executes. A matching `ask` opens one confirmation with the matching selectors, their states and configuration layers, and a labeled script preview. The preview is limited to 1,000 characters and identifies when it was truncated. If interactive UI is unavailable, the script is blocked. Refusal blocks the script, and cancellation or turn abort wins over a racing approval.

Approval applies only to the codemode script. Codemode calls tools through Pi's normal nested tool pipeline, so every `bash`, `read`, `edit`, or `write` operation is checked against its ordinary policy. A script allowed by default, matched by `allow`, or approved by the user receives no permission bypass for those calls. Nested ask rules also fail closed when Pi has no interactive UI.

YOLO mode bypasses codemode checks, including policy validation and approval prompts, just as it bypasses the original protected-tool checks.

## Validation and supported syntax

Selectors are parsed when policies load and reused for script checks. When at least one codemode selector exists, the extension requires a string `code` field, parses the script once, and evaluates its selectors. It supports top-level `return` and `await`, which Pi's codemode execution context accepts. An initial `// @options:` line is an ordinary JavaScript comment for this check. `Program` selectors refer to the submitted source directly; the extension does not add a synthetic wrapper to the AST.

Invalid codemode sections, unknown permission states, empty or invalid selectors, malformed JSONC, unreadable policy files, and non-object top-level configuration block codemode because the intended policy cannot be determined. A missing policy file is normal. Diagnostics name the configuration file and selector when available. Fixing, replacing, or removing a file reloads the policy through the normal configuration cache.

With configured rules, malformed scripts, module syntax such as static `import` or `export`, or selector evaluation errors block execution. Without codemode rules or policy errors, the extension skips parsing and lets Pi validate the script. Acorn and Pi's QuickJS runtime have different syntax implementations, so a configured check can reject syntax QuickJS accepts. Pi remains responsible for its own execution-time syntax validation.

### Troubleshooting

- **A selector is rejected:** Check the error for the selector and file path. Use an ESTree node name and esquery syntax, not a Tree-sitter or Scheme query.
- **JSONC parsing fails:** Escape double quotes inside selector strings as `\"`, or use single quotes for selector attribute values.
- **A script is blocked for syntax:** Check module syntax and recent JavaScript features. Configured syntax policies fail closed when Acorn cannot parse the source.
- **A selector does not match:** Confirm the AST shape and remember that aliases, computed access, and equivalent runtime behavior are not resolved.
- **A nested operation is blocked:** Adjust the matching `bash`, `read`, `edit`, or `write` policy. Codemode approval does not approve nested operations.

## Security scope

These rules restrict selected syntax; they are not a sandbox, behavior verifier, or comprehensive capability filter. Direct-call selectors do not catch aliases or every computed invocation. Loop selectors do not prevent recursion. Syntax selectors cannot determine whether a tool call is safe from data flow or runtime values. The ordinary runtime policies remain authoritative for `bash`, `read`, `edit`, and `write`.

Treat permission files as trusted configuration. esquery supports regular-expression predicates that can consume CPU, and this feature does not impose selector execution quotas or protect against hostile policy files.

## Development tests

`npm run check` runs the policy and matcher tests plus integration tests that load Pi's real codemode extension in an in-memory session with a deterministic faux provider. The tests use no user credentials or external model requests. The integration fixture requires Pi 0.99.1 or a compatible release that includes builtin codemode and nested `tool_call` dispatch.
