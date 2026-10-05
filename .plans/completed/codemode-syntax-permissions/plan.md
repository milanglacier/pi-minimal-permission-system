# Codemode syntax permissions

Status: Draft. Planning only; no implementation changes are included.

## Goal

Add optional, user-configurable syntax rules for Pi's `codemode` tool using
Acorn and esquery. Users store esquery selectors in the existing global and
project `permissions.jsonc` files. A matching selector applies a permission to
the whole script before execution.

This feature supplements the existing runtime permissions for `bash`, `read`,
`edit`, and `write`. Pi 0.99.1 routes nested calls from builtin codemode through
`tool_call`, so those operations already receive their normal permission checks.

## Agreed semantics

- Codemode rules use `deny > ask > allow`, independent of declaration order.
- Combine matching codemode rules from both global and project configuration
  using that same precedence. A project rule cannot weaken a matching global
  `deny` or `ask` rule.
- Codemode defaults to `allow` when no codemode rules are configured.
- A valid codemode policy with no matching selector also resolves to `allow`.
- An empty `codemode` object behaves like an absent section.
- Existing tools retain their current default of `ask`, matching rules, and
  global/project resolution semantics.
- Approving or allowing a codemode script never approves its nested tool calls.
- Existing YOLO mode bypasses codemode checks, including policy validation, as
  it does for the other protected tools.

## Configuration

Use an object mapping esquery selector strings to permission states:

```jsonc
{
  "codemode": {
    "DebuggerStatement": "deny",
    "CallExpression[callee.name='eval']": "deny",
    "ForStatement, ForInStatement, ForOfStatement, WhileStatement, DoWhileStatement": "ask",
    "CallExpression[callee.type='MemberExpression'][callee.computed=false][callee.object.name='models'][callee.property.name='classify']": "ask"
  },
  "bash": {
    ".*": "ask"
  }
}
```

A selector matches if it selects at least one AST node. Multiple matching nodes
for the same rule do not produce multiple prompts. Combine matching rules and
make one permission decision per script.

Users can request approval for every script with `"Program": "ask"`. Since
`ask` outranks `allow`, adding an allow selector cannot create an exception to
that catch-all. Likewise, an allow rule cannot exempt code from a deny rule.
Explain this explicitly in the documentation.

The selector syntax is esquery's CSS-like AST query language, not a Tree-sitter
query and not Scheme. JSONC strings still require escaped double quotes and
newlines. Do not introduce a separate query-file format in this feature.

## Security scope

These rules restrict source syntax, not all equivalent runtime behavior.
For example, matching direct `eval(...)` calls does not catch every alias of
eval, and matching `models.classify(...)` does not catch every computed or
aliased invocation. Loop restrictions do not prevent recursion.

Do not describe this feature as a sandbox, JavaScript behavior verifier, or
comprehensive capability filter. Runtime checks remain authoritative for the
four existing protected tools.

Non-goals:

- Data-flow analysis, alias resolution, or evaluating script code during checks.
- Model-based classification or automatic risk scoring.
- Redundant codemode-specific command/path policies for nested protected tools.
- Permission coverage for MCP tools, arbitrary extension tools, classifier
  helpers, or codemode storage helpers.
- Native parsers, Tree-sitter, a Scheme interpreter, or a custom selector language.
- Execution-time quotas or guaranteed protection against expensive selectors.

Treat policy files as trusted configuration. Selectors, including regex
predicates, can consume CPU; this feature does not make hostile policy files
safe to load.

## Implementation design

### Dependencies

Add `acorn` and `esquery` as runtime dependencies and any required type-only
packages as development dependencies. Update the lockfile through npm.

Both parsers run in JavaScript without native addons. Initial registry inspection
suggests approximately 1.6 MiB unpacked for these two packages, plus esquery's
small traversal dependency. Do not add `acorn-walk` unless implementation needs
justify it; esquery provides traversal for matching.

Verify ESM/CJS interoperability under the project's TypeScript setup and Pi's
extension loader. Keep dependency loading and selector compilation out of the
per-nested-call hot path where practical.

### Policy types and loading

Target files: `src/types.ts`, `src/config.ts`.

Keep codemode selector rules distinct from the existing regex/glob rules. Do not
simply add codemode to a list that sends every non-bash rule through picomatch.
Preserve selector text, state, configuration path, and layer for diagnostics.

Validate a present codemode section strictly:

- It must be an object, not null, an array, or a primitive.
- Each value must be `allow`, `ask`, or `deny`.
- Each selector must be nonempty and accepted by esquery's selector parser.

Preserve global and project rules separately until resolution; merging objects
by selector string would let project entries overwrite global restrictions.

Distinguish missing policy files from failed policy loads. Existing loading
collapses parse/read failures to null, which must not silently trigger
codemode's default allow. For codemode:

- Missing files are normal and do not block execution.
- Unreadable files, malformed JSONC, or an invalid top-level configuration
  shape block codemode because the intended policy cannot be determined.
- Invalid codemode sections, states, or selectors block codemode.
- Include the failing file and selector, where applicable, in diagnostics.
- Preserve existing behavior for the four original tools; do not silently change
  their handling of invalid configurations as part of this feature.

Carry explicit load/validation diagnostics in cached policy data rather than
converting an invalid codemode policy to an empty rule list. Reuse the existing
cwd/config-stamp invalidation mechanism and test recovery when configuration is
fixed, replaced, or removed. Do not cache user approvals or script decisions.

### Script parsing and selector matching

Proposed new file: `src/codemode.ts`.

Compile selectors when policy loads, then parse each checked script once. Pass
compiled selector ASTs to esquery rather than reparsing selectors for each call.

When there are no codemode rules and no configuration errors, allow without
parsing the script. Pi remains responsible for script syntax validation in this
case.

When rules exist:

1. Validate that the tool input contains a string `code` field.
2. Parse that string without executing it.
3. Evaluate compiled selectors against the resulting ESTree-compatible AST.
4. Aggregate matching states with `deny > ask > allow`.
5. Return the decision and the rules responsible for it.

Match Pi's async-function-body execution context: codemode supports top-level
`await` and `return`. Its `// @options:` line is a comment and must not cause a
false parse failure. Reject modules or unsupported syntax rather than falling
back to regex or silently allowing them.

During implementation, verify Acorn's options for parsing this context. Prefer
a user-source Program AST so `Program` selectors work naturally and source
locations refer to the submitted script. If an async-function wrapper is needed,
exclude every synthetic wrapper node from matching and normalize source
locations. Test parser behavior against Pi's actual execution wrapper, including
empty scripts, comments, async constructs, and unsupported syntax.

A script parse error or selector evaluation error blocks execution with an
explanation. Parser/QuickJS syntax differences may cause conservative rejection;
document that configured syntax checking can reject syntax the runtime accepts.

### Runtime enforcement

Target file: `index.ts`.

Add a separate codemode branch to the `tool_call` handler. Leave the existing
command/path matching and resolution code unchanged.

- `deny`: return a policy block before codemode executes.
- `ask`: show one confirmation identifying the matching selectors/layers and a
  bounded, clearly labeled script preview. State if the preview is truncated.
- `allow`: let Pi execute codemode normally.
- No UI for `ask`: block execution.
- Abort before or during confirmation: use the existing cancellation behavior.
- Approval racing with abort: cancellation wins.
- User refusal: return the existing style of explicit-denial message.

The decision concerns the script only. Nested `tool_call` events continue through
the ordinary permission checks. Do not add an approval cache or a temporary
bypass around the script's descendants.

Do not require codemode-only Pi APIs in the production handler if the generic
`tool_call` event and input narrowing suffice. Confirm compatibility with the
existing peer range; the integration tests specifically require Pi 0.99.1 or a
compatible version with builtin codemode.

## Implementation sequence

1. Add tests for codemode configuration parsing and distinct error states.
2. Extend policy types/loading while preserving original-tool behavior.
3. Add Acorn/esquery dependencies and implement parser/matcher behavior with
   focused tests.
4. Add the codemode event-handler branch and confirmation/cancellation tests.
5. Add isolated integration tests using Pi's real codemode and nested dispatch.
6. Add `docs/codemode-permissions.md` for detailed selector documentation. Keep
   README changes succinct, with one simple example and a link to that guide.
   Update local contributor instructions for the different defaults/precedence.
7. Run `npm run check` and review the diff for unintended changes to existing
   permissions.

## Verification matrix

### Configuration and resolution

- Absent codemode sections and empty objects allow by default.
- Valid rules with no matches allow by default.
- A selector matching several nodes produces one rule match/decision.
- Deny beats ask and allow in every declaration order.
- Ask beats allow in every declaration order.
- Global deny/project allow, global ask/project allow, and global allow/project
  deny resolve correctly, including identical selector strings across layers.
- Original-tool defaults, last-match behavior, and deny precedence are unchanged.
- Malformed sections, unknown states, invalid selectors, malformed JSONC, and
  read failures block codemode; missing files do not.
- Policy cache invalidation handles changes, removal, cwd changes, and recovery
  from configuration errors.

### Parsing and matching

- Direct-call selectors match the documented examples.
- Comments and strings containing matching-looking source do not match call
  selectors.
- Aliases/computed access are not claimed to match selectors for direct calls.
- Top-level await/return, options comments, optional chaining, async functions,
  and empty scripts have tested behavior.
- `Program` matches exactly the user-script root; synthetic wrapper syntax never
  triggers a rule.
- Invalid script input and unsupported syntax fail closed when rules exist.

### Runtime behavior

- Denied codemode scripts never begin execution.
- Ask produces a single prompt with useful rule diagnostics.
- User approval, refusal, unavailable UI, pre-aborted turns, pending aborts, and
  approval/abort races behave consistently with existing tools.
- YOLO skips codemode rules and prompts; toggling it restores enforcement.
- An allowed or approved script still cannot execute a denied nested operation.

### Pi integration

Use temporary project/global configuration, in-memory sessions, no user
credentials, and deterministic execution without external model requests. Load
this extension and Pi's actual builtin codemode. Use a deterministic assistant
fixture or test provider so calls exercise the real tool pipeline rather than a
handwritten imitation.

Verify both levels of enforcement:

- A source-policy denial prevents even otherwise-allowed nested writes.
- A source-policy allow/approval still honors global nested tool denials for
  computed names and parallel calls.
- Catching a nested permission error does not execute the blocked operation.
- Nested ask without UI fails closed, and permitted nested operations succeed.

Keep temporary files and environment overrides isolated and cleaned up. Smoke
test extension loading in the installed Pi runtime as well as Node-based tests.
If integration tests need a separate command, include it in `npm run check` for
supported development environments and document the Pi version requirement.

## Documentation and acceptance criteria

### README: succinct user-facing overview

Keep `README.md` short. Describe only the essential differences:

- Codemode defaults to `allow` when rules are absent or no selector matches;
  the other protected tools default to `ask`.
- Codemode uses `deny > ask > allow` across matching rules, rather than the
  other tools' last-match resolution with global-deny protection.

Use plain language for the short explanation: "Codemode calls other tools, and
those calls still go through their usual permission checks. Allowing codemode by
default avoids asking twice. You can add rules to restrict the script itself."

Include just one very simple configuration example, such as
`"codemode": { "DebuggerStatement": "deny" }`, and link to
`docs/codemode-permissions.md`. Do not put detailed parser rules, selector
reference material, or complex examples in README.

### Detailed guide

Add `docs/codemode-permissions.md` covering:

- How Acorn parses scripts and esquery matches their AST nodes.
- The selector syntax users can write in JSONC, including node types,
  attributes, combinations, escaping, and tested examples.
- Aggregate precedence across global/project rules and why allow rules cannot
  create exceptions to matching ask/deny rules.
- Default behavior, strict error handling, approval/cancellation, and YOLO.
- Nested-tool independence and the limits of syntactic checks, including aliases
  and computed access.
- Supported script syntax, parser/runtime differences, and troubleshooting.

Keep detailed examples in this guide and validate them with tests. Include the
`docs` directory in `package.json`'s published files so the README link also
works in installed packages.

Update `AGENTS.md` to describe codemode as the explicit default-allow exception
to the original tools' default-ask behavior.

The feature is ready when the verification matrix passes, `npm run check`
succeeds, no native dependencies are introduced, and users without codemode
rules retain normal codemode operation with valid existing configuration.
