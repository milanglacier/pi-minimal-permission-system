## Findings

### [P1] Align the faux provider dependency with the Pi runtime

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-minimal-permission-system/package.json:54-54`

The checked-in lockfile installs `pi-coding-agent@1.0.0` with `pi-ai@1.0.0`, but this dependency pins the integration fixture to `pi-ai@0.99.1`. Consequently, `npm run check` fails with TS2345 at `tests/codemode-integration.test.ts:108`: the faux provider's `stream` signature uses a different branded `TranscriptContext` from the runtime's expected type. Align the development dependencies so the fixture and runtime use the same `pi-ai` version, and regenerate the lockfile. This blocks the required check documented in `AGENTS.md:36-38`.

## Overall assessment

**Verdict:** Patch is incorrect.

**Explanation:** The permission implementation and behavioral coverage are coherent; `npm test` and a file-based Pi extension-loading smoke test pass. However, the dependency mismatch prevents the required `npm run check` from passing.

## Fix summary

### [P1] Align the faux provider dependency with the Pi runtime

- Updated the development dependency `@earendil-works/pi-ai` to `1.0.0` in `package.json` and regenerated `package-lock.json`. The integration fixture and Pi runtime now use the same version and compatible provider types.
- Validation: `npm run check` passes, including strict TypeScript checking, behavior tests, and real Pi codemode integration tests.
- The original review above is preserved unchanged.

# Second round of review

## Findings

### [P1] Traverse dynamic-import options when matching selectors

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-minimal-permission-system/src/codemode.ts:70-71`

Acorn stores dynamic-import options in `ImportExpression.options`, but esquery's default visitor keys traverse only `source`. With `CallExpression[callee.name='eval']` denied, `try { await import("missing", { with: { type: eval('text("bypassed"); "json"') } }); } catch {}` is therefore allowed with no matches, and Pi's actual QuickJS sandbox executes the direct `eval` and outputs `bypassed`. This bypasses a matching syntax restriction without aliases or computed access. Provide visitor keys that include the options subtree so executable descendants receive the matching-rule precedence required by `AGENTS.md:22-24`.

### [P2] Validate pseudo-classes before accepting policy selectors

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-minimal-permission-system/src/config.ts:142-149`

`esquery.parse` accepts unknown pseudo-classes, and matcher short-circuiting can hide their evaluation errors. For `{"codemode":{"Identifier:unknown":"deny"}}`, loading records no diagnostic and `return 1;` is allowed, while `const a = 1;` blocks with `Unknown class name: unknown`. Thus an invalid rule blocks only some scripts, contrary to the fail-closed requirement in `AGENTS.md:25-26`; the existing `Program:unknown` test misses this because `Program` always matches. Validate supported pseudo-classes during loading instead of relying on source-dependent matcher errors.

### [P2] Preserve JSONC prototype keys during codemode validation

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-minimal-permission-system/src/config.ts:124-133`

`jsonc-parser` assigns members onto ordinary objects, so a `__proto__` member can change the parsed object's prototype instead of appearing in `Object.entries`. Consequently, `{"codemode":{"__proto__":{"Program":"deny"}}}` loads with zero rules and zero diagnostics, and scripts are allowed even though its object-valued permission state is invalid. This violates the invalid-rule blocking requirement in `AGENTS.md:25-26`. Preserve JSONC member names during validation, or explicitly reject prototype keys before they can disappear from the parsed rule map.

## Overall assessment

**Verdict:** Patch is incorrect.

**Explanation:** The first-round dependency issue is resolved, and `npm run check` and the file-based Pi loading smoke test pass. However, targeted reproductions expose a syntax-policy bypass and two fail-open configuration-validation cases that require correction.

## User decision

- Withdraw the second-round finding "[P2] Preserve JSONC prototype keys during codemode validation" from the actionable findings. Its constructed input has no identified normal configuration use, and permission files are trusted configuration. Treat it as optional hardening, not a merge blocker; no code change is requested for it.
- Fix the two retained findings: dynamic-import options traversal and pseudo-class validation during policy loading.
- Preserve the original reviews and assessments above as the historical record.

## Second-round fix summaries

### [P1] Traverse dynamic-import options when matching selectors

- Added esquery visitor keys for both `ImportExpression.source` and `ImportExpression.options` in `src/codemode.ts`. Direct-call, parent, and `:has(...)` selectors now inspect executable expressions in the options argument.
- Added matcher regression tests and a real Pi integration test. The integration test confirms that the sample executes without syntax rules, then verifies that the direct-eval deny prevents execution and its output when configured.

### [P2] Validate pseudo-classes before accepting policy selectors

- Validate node-category pseudo-classes throughout the parsed selector tree before accepting a rule in `src/config.ts`. Unknown classes produce a policy diagnostic naming the file and selector, even inside combined or nested selectors and when no script node would match.
- Added tests for source-independent blocking, nested selectors, all five supported classes, case-insensitive matching, and preservation of ordinary bash/read rules. A real Pi integration test verifies that an invalid global rule blocks scripts with and without identifiers despite a project allow.
- Updated `docs/codemode-permissions.md` to document supported classes, loading-time validation, and dynamic-import options traversal.

### Validation

- Both retained findings were reproduced with failing regression tests before their respective fixes.
- `npm run check` passes, including strict TypeScript checking, behavior tests, and real Pi codemode integration tests.
- A file-based Pi/jiti extension-loading smoke test verifies both fixes through the registered `tool_call` handler.
- `git diff --check` passes. The withdrawn prototype-key finding is not included in the code changes, and the original review text remains unchanged.

# Third round of review

## Findings

No findings.

## Overall assessment

**Verdict:** Patch is correct.

**Explanation:** Reviewed the current branch against the merge base with `main` (`25ce8d1d5cbef51d879e75dc27cdcabe9633cf03`). Both retained second-round findings are resolved, and no additional actionable issues were found. `npm run check`, `git diff --check`, and a file-based Pi extension-loading smoke test pass.
