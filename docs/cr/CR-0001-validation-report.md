# CR-0001 Validation Report

Validator: CR-Validator (documentation-only audit)
Date: 2026-07-11
Branch: `dev/claude-agent-sdk` | Branch base: `origin/main` @ `5c4142a` | HEAD: `bbbb9e0`
Diff basis: `git diff 5c4142a...HEAD`

## Summary

Requirements: 15/15 | Acceptance Criteria: 1/11 | Tests: 0/12 | Gaps: 12

Source implementation is complete and traces cleanly to changed-file hunks; the
full check pipeline (build, typecheck, lint, 176 tests) is green. However, the
CR's entire Test Strategy is unimplemented: none of the 10 specified new tests
exist and neither of the 2 specified test modifications was made. No changed
file under `test/` exists on this branch, and grep for every CR term
(`anthropic-claude`, `CLAUDE_CODE_OAUTH_TOKEN`, `ChatClaudeAgentSdk`,
`claude-agent-sdk`) across `test/` returns zero matches. Consequently every
acceptance criterion with observable runtime behavior has only "file:line
exists" evidence and is downgraded to PARTIAL per the behavioral-verification
rule. The Quality Standards checkboxes in the CR that claim "All new tests pass"
and "Test coverage meets project requirements for changed code" are not
substantiated by the diff.

## Requirement Verification

| Req # | Description | Status | Evidence (file:line / test name) |
| --- | --- | --- | --- |
| FR-1 | Register `anthropic-claude` in union, `PROVIDER_CONFIGS`, `SELECTABLE_OPENWIKI_PROVIDERS` | PASS | `src/constants.ts:64` (union), `:126` (selectable), `:183-193` (config); token key `src/constants.ts:24` |
| FR-2 | Route inference through Agent SDK, never `ChatAnthropic`; expose LangChain model | PASS | `src/agent/index.ts:544-551` (branch returns `ChatClaudeAgentSdkModel`, before the `anthropic`/`ChatAnthropic` branch); `src/agent/claude-agent-sdk.ts:370,528` (`query()`), no `ChatAnthropic` reference in adapter |
| FR-3 | Offer Sonnet/Opus/Haiku/Fable, Sonnet default, accept `OPENWIKI_MODEL_ID` | PASS | `src/constants.ts:188-191` (options, Sonnet first → default via `getDefaultModelId`); custom id via existing `isValidModelId` machinery |
| FR-4 | Authenticate with `CLAUDE_CODE_OAUTH_TOKEN`, not `ANTHROPIC_API_KEY` | PASS | `src/constants.ts:184` (`apiKeyEnvKey: CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY`); `src/agent/claude-agent-sdk.ts:426-433` (token read) |
| FR-5 | Auto-select on token only, at lowest precedence; no change to existing users | PASS | `src/constants.ts:328-331` (`anthropic-claude` inserted immediately before `DEFAULT_PROVIDER`, after all existing key checks) |
| FR-6 | Scrub `ANTHROPIC_API_KEY` from SDK env and warn | PASS | `src/agent/claude-agent-sdk.ts:443-447` (`buildSdkEnv` deletes key); `src/agent/index.ts:413-430` (`warnOnAnthropicApiKeyFootgun` emits warning event) |
| FR-7 | Missing token fails fast naming var and `claude setup-token` | PASS | `src/agent/index.ts:392-395` (`ensureProviderKey` special-case); adapter fallback `src/agent/claude-agent-sdk.ts:426-433` |
| FR-8 | Guidance on SDK rejection and raw-`anthropic` categorical 429 | PASS | `src/agent/claude-agent-sdk.ts:147-181` (`SDK_ERROR_GUIDANCE`, `buildSdkGuidanceError`); `src/agent/index.ts:445-475` (`translateAnthropicCategorical429`), wired at `:146` |
| FR-9 | Never print token; masked diagnostics, length-only debug, `0600` persistence | PASS | `src/agent/index.ts:1421` (`formatDebugValue` length-only); `src/env.ts:87` (managed → diagnostics), `src/env.ts:267-275` (`isNonSecretDiagnosticKey` excludes token → masked); `src/env.ts:200-204` (`0600`) |
| FR-10 | UI lists provider + 4 models + `claude setup-token` guidance | PASS | `src/credentials.tsx:2263-2286` (guidance branch); `src/cli.tsx:1771-1783` (notice/label); provider/models auto-surface from `SELECTABLE_OPENWIKI_PROVIDERS` |
| FR-11 | Leave `anthropic` and all other providers unchanged | PASS | `anthropic` branch untouched (`src/agent/index.ts` `anthropic` branch retained after new branch); additive changes only; 176 existing tests pass |
| NFR-1 | Stream tokens incrementally | PASS | `src/agent/claude-agent-sdk.ts:514-557,578-591` (partial `stream_event` text deltas yielded as chunks). No test exercises streaming. |
| NFR-2 | Token secret at rest (`0600`) and in transit; never committed/logged | PASS | `src/env.ts:200-204` (`0600`); FR-9 masking; token not present in repo |
| NFR-3 | Honor `OPENWIKI_PROVIDER_RETRY_ATTEMPTS` | PASS | `src/agent/index.ts:548-550` passes `maxRetries` into adapter; `src/agent/claude-agent-sdk.ts:383,549-555` retry loop. No test exercises retry parity. |
| NFR-4 | Node >= 20 ESM | PASS | ESM imports throughout adapter; no engine violation; build/typecheck green |

## Acceptance Criteria Verification

Behavioral-verification rule applied: ACs with observable runtime behavior
require either a passing project test or a manual verification step enumerated in
the Test Strategy. The Test Strategy enumerates only automated tests (none
implemented) and no manual steps, so implemented-but-untested behavioral ACs are
downgraded to PARTIAL.

| AC # | Description | Status | Evidence |
| --- | --- | --- | --- |
| AC-1 | Provider registered and selectable, 4 models | PARTIAL | Impl `src/constants.ts:64,126,183-193,330`. Specified test `registers anthropic-claude provider` (test/constants.test.ts) MISSING |
| AC-2 | Inference routed through Agent SDK, not `ChatAnthropic` | PARTIAL | Impl `src/agent/index.ts:544-551`. Specified test `createModel returns SDK adapter` MISSING |
| AC-3 | Full lineup, Sonnet default, accepts opus/fable/haiku | PARTIAL | Impl `src/constants.ts:188-191`. Specified test `defaults anthropic-claude to Sonnet` MISSING |
| AC-4 | Auth via token without `ANTHROPIC_API_KEY` | PARTIAL | Impl `src/constants.ts:184`, `src/agent/claude-agent-sdk.ts:426-447`. No test / no live SDK verification |
| AC-5 | Backward-compatible auto-detection precedence | PARTIAL | Impl `src/constants.ts:328-331`. Specified test `auto-detects token only as lowest precedence` MISSING |
| AC-6 | `ANTHROPIC_API_KEY` absent from SDK env + warning | PARTIAL | Impl `src/agent/claude-agent-sdk.ts:443-447`, `src/agent/index.ts:413-430`. Specified test `scrubs ANTHROPIC_API_KEY from SDK env` MISSING |
| AC-7 | Missing token fails fast with var + `claude setup-token` | PARTIAL | Impl `src/agent/index.ts:392-395`. Specified test `missing token throws actionable error` MISSING |
| AC-8 | Unsupported-path guidance (SDK auth/429 and raw 429) | PARTIAL | Impl `src/agent/claude-agent-sdk.ts:147-181`, `src/agent/index.ts:445-475`. Specified test `maps auth 429 to guidance error` MISSING |
| AC-9 | Secret hygiene: masked diagnostics, length-only debug, `0600` | PARTIAL | Impl `src/agent/index.ts:1421`, `src/env.ts:267-275`, `:200-204`. Specified test `redacts CLAUDE_CODE_OAUTH_TOKEN in debug` MISSING |
| AC-10 | UI surfaces provider, 4 models, guidance | PARTIAL | Impl `src/credentials.tsx:2263-2286`, `src/cli.tsx:1771-1783`. Specified modify of test/credentials.test.ts NOT done |
| AC-11 | Existing raw `anthropic` path unchanged | PASS | `anthropic` branch retained unmodified; additive-only diff; 176 existing tests pass (test/env.test.ts, test/constants.test.ts, test/credentials.test.ts et al.) provide non-regression evidence |

## Test Strategy Verification

| Test File | Test Name | Specified | Exists | Matches Spec |
| --- | --- | --- | --- | --- |
| test/constants.test.ts | registers anthropic-claude provider | Yes | No | GAP |
| test/constants.test.ts | defaults anthropic-claude to Sonnet | Yes | No | GAP |
| test/constants.test.ts | auto-detects token only as lowest precedence | Yes | No | GAP |
| test/env.test.ts | token is a managed masked secret | Yes | No | GAP |
| test/claude-agent-provider.test.ts | createModel returns SDK adapter | Yes | No (file absent) | GAP |
| test/claude-agent-provider.test.ts | missing token throws actionable error | Yes | No (file absent) | GAP |
| test/claude-agent-provider.test.ts | scrubs ANTHROPIC_API_KEY from SDK env | Yes | No (file absent) | GAP |
| test/claude-agent-sdk.test.ts | bridges messages and tool calls | Yes | No (file absent) | GAP |
| test/claude-agent-sdk.test.ts | maps auth 429 to guidance error | Yes | No (file absent) | GAP |
| test/redaction.test.ts | redacts CLAUDE_CODE_OAUTH_TOKEN in debug | Yes | No | GAP |
| test/env.test.ts (modify) | env managed-keys snapshot/order | Yes | Not modified for token | GAP |
| test/credentials.test.ts (modify) | provider-list rendering | Yes | Not modified for provider | GAP |

Check pipeline (no Makefile; pnpm is the project's documented workflow per CR
Verification Commands): `pnpm run build` PASS, `pnpm run typecheck` PASS (exit 0),
`pnpm run lint:check` PASS (exit 0), `pnpm test` PASS (17 files, 176 tests, exit 0).
None of the 176 passing tests are CR-specified tests.

## Diff Coverage

| File | +/- | Mapped Requirements |
| --- | --- | --- |
| src/constants.ts | +24/-1 (approx) | FR-1, FR-3, FR-4, FR-5 |
| src/env.ts | +2 | FR-9 (persistence/diagnostics derivation), NFR-2 |
| src/agent/claude-agent-sdk.ts | +689 (new) | FR-2, FR-4, FR-6, FR-7(fallback), FR-8, NFR-1, NFR-3 |
| src/agent/index.ts | +138/- | FR-2, FR-6, FR-7, FR-8, FR-9, NFR-3 |
| src/cli.tsx | +11/-2 | FR-10 |
| src/credentials.tsx | +25 | FR-10 |
| package.json | +1 | FR-2 (SDK dependency) |
| pnpm-lock.yaml | +769 | FR-2 (lockfile companion to package.json) |
| README.md | +29/-1 | Phase 6 docs |
| .deepwiki | +8 (new) | Phase 3/6 (created, per CR note it did not exist) |
| docs/cr/CR-0001-claude-agent-sdk-provider.md | +743 (new) | The CR itself |

### Unmapped changed files

None. All 11 changed files fall within the CR's declared Affected Components.
`pnpm-lock.yaml` is the lockfile companion to the `package.json` dependency
addition; the CR markdown is the CR itself. No stray files outside scope.

## Gaps

1. **Test Strategy entirely unimplemented (10 new tests, GAP).** The CR
   specifies 10 tests to add across `test/constants.test.ts`,
   `test/env.test.ts`, `test/claude-agent-provider.test.ts` (new),
   `test/claude-agent-sdk.test.ts` (new), and `test/redaction.test.ts`. None
   exist on the branch; `test/claude-agent-provider.test.ts` and
   `test/claude-agent-sdk.test.ts` are absent files. No `test/` file appears in
   the branch diff. Suggested minimal fix: author the 10 specified tests as
   described (provider registration, Sonnet default, precedence, managed masked
   secret, `createModel` adapter type, missing-token error, `ANTHROPIC_API_KEY`
   scrub + warning, tool-call bridging with mocked `query()`, 429→guidance
   mapping, debug redaction). The tool-bridge test (Risk 1 mitigation) and the
   scrub test (Risk 2 mitigation) are the highest value.

2. **Specified test modifications not done (2, GAP).** `test/env.test.ts`
   managed-keys snapshot/order was not updated to include
   `CLAUDE_CODE_OAUTH_TOKEN`, and `test/credentials.test.ts` provider-list
   rendering was not updated to include `anthropic-claude` and its models.
   Suggested minimal fix: extend both existing tests to assert the new key and
   provider entry.

3. **Behavioral ACs lack runtime evidence (AC-1..AC-10, PARTIAL).** Every
   observable-behavior AC is verified only by "file:line exists" because the
   backing tests are absent and the Test Strategy enumerates no manual
   verification steps. Implementing gap 1 and 2 resolves this; each specified
   test maps directly to an AC.

Note: no requirement is FAIL. Every FR and NFR has concrete changed-file hunk
evidence and the source implementation is complete and coherent. The deficiency
is exclusively the missing verification layer, which the CR itself mandates as
part of its Test Strategy and Quality Standards.
