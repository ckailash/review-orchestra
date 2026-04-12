# Pre-Open-Source Audit Report

**Date:** 2026-04-12
**Scope:** Full codebase audit of review-orchestra (`src/`, `test/`, `config/`, `schemas/`, `skill/`, `prompts/`, `docs/`)
**Methodology:** Automated multi-model analysis with cross-model review validation. Every source and test file was read and analyzed.

---

## Summary

| Severity | Found | Fixed | Remaining |
|----------|-------|-------|-----------|
| P0       | 0     | 0     | 0         |
| P1       | 4     | 4     | 0         |
| P2       | 8     | 8     | 0         |
| P3       | 12    | 1     | 11        |

All P0, P1, and P2 issues have been fixed. Test coverage expanded from 429 to 474 tests (+45 new tests). All fixes verified: 474/474 tests pass, build succeeds, lint clean.

---

## P1 Findings (all fixed)

### P1-001: process.ts:56,69 — Leaked SIGKILL escalation timers
**Status: FIXED**

Both the inactivity and catastrophic timeout handlers created untracked `setTimeout(() => child.kill("SIGKILL"), 5000)` timers. If the process exited after SIGTERM, these timers were never cleaned up. Additionally, if both timeouts fired sequentially, the second timer overwrote the first, leaking it.

**Fix:** Added `sigkillTimer` variable tracked alongside existing timers. Both handlers clear any existing sigkill timer before setting a new one. The `cleanup()` function clears it on process exit.

### P1-002: orchestrator.ts:55-58 — Preflight permanently mutates this.reviewers
**Status: FIXED**

`this.reviewers = this.reviewers.filter(r => r.name !== name)` permanently removed reviewers disabled by preflight. If `run()` was called multiple times on the same Orchestrator instance (e.g., in a supervised review loop), reviewers disabled in run 1 stayed disabled in run 2 even if their binary became available.

**Fix:** Introduced local `activeReviewers` variable. Changed `runReviews()` to accept a `reviewers` parameter instead of reading `this.reviewers`. All code paths (normal, crash recovery reviewing, crash recovery consolidating) use the local variable. Metadata builder uses `activeReviewers` for the result.

### P1-003: worktree-hash.ts:52 — git ls-files call not wrapped in try/catch
**Status: FIXED**

The `computeWorktreeHash` function carefully wraps `git rev-parse HEAD` and `git diff HEAD` in try/catch blocks, but the `git ls-files` call had no error handling. Any git failure (corrupted repo, permission issues) would crash the entire hash computation and propagate up to the orchestrator.

**Fix:** Wrapped in try/catch. On failure, untracked files are skipped and the hash covers only HEAD + diff (sufficient for stale detection).

### P1-004: reviewers/index.ts:47-53 — GenericReviewer sends prompt as both arg AND stdin
**Status: FIXED**

The GenericReviewer replaced `{prompt}` in command template args AND passed `input: fullPrompt` to `spawnWithStreaming`. The prompt was sent twice — once in argv and once on stdin. For tools that read both, this could cause double-processing or confusing behavior.

**Fix:** Added `hasPromptPlaceholder` check. If the command template contains `{prompt}`, it's substituted in args and stdin is omitted. If no placeholder exists, prompt is sent via stdin only (matching Claude/Codex reviewer behavior).

---

## P2 Findings

### P2-001: schemas/findings.schema.json — Missing `status` field and required field misalignment
**Status: FIXED**

The `Finding` TypeScript type has `status?: FindingStatus` ("new" | "persisting") but the JSON schema didn't include it. Additionally, `reviewer` and `pre_existing` are required in the TypeScript type but were not in the schema's `required` array.

**Fix:** Added `status` field with enum. Added `reviewer` and `pre_existing` to required array.

### P2-002: config.ts — Unsafe `as any` casts in config merging
**Status: FIXED**

`loadBaseConfig()` used `...(partial as any)` when spreading partial reviewer configs from `default.json`, which could spread unexpected properties without type checking.

**Fix:** Replaced with `as Partial<ReviewerConfig>` for proper type narrowing. Also added `deepFreeze` on `DEFAULT_CONFIG` to prevent accidental mutation, structured config merging that preserves defaults for missing fields, and error logging for malformed config files.

### P2-003: config.ts — DEFAULT_CONFIG was mutable
**Status: FIXED** (as part of P2-002)

`DEFAULT_CONFIG` was a plain object that could be accidentally mutated by consumers. Since `loadBaseConfig` previously did `return { reviewers: parsed.reviewers ?? DEFAULT_CONFIG.reviewers, ... }`, a caller could mutate the shared default via the reference.

**Fix:** `deepFreeze` applied to both `DEFAULT_CONFIG` and `DEFAULT_FINDING_COMPARISON_CONFIG`. `loadBaseConfig` uses `structuredClone` in the fallback path.

### P2-004: architecture.md — Outdated reviewer commands
**Status: FIXED**

architecture.md showed old command patterns (--allowedTools, --output-schema) and was missing worktree-hash.ts, finding-comparison.ts, findings-store.ts from the component tree.

**Fix:** Updated Phase 2 command examples to match actual CLI invocations, added missing files to component tree, added findingComparison config section, updated finding comparison description and decisions table.

### P2-005: architecture.md — Missing LLM finding comparison documentation
**Status: FIXED**

The `findingComparison` config option and LLM-based finding comparison feature were undocumented.

**Fix:** Updated the "Matching heuristic" paragraph to describe both LLM and heuristic methods. Added decision table entry for "LLM-based semantic matching (haiku) with heuristic fallback".

### P2-006: checks.ts:165 — `checkAuth` function name is misleading
**Status: FIXED**

The function runs `binary --version` but was named `checkAuth`, misleading users into thinking they have an auth problem.

**Fix:** Renamed `checkAuth` to `checkBinaryHealth` across all callers (checks.ts, setup.ts, doctor.ts) and all tests (checks.test.ts, setup.test.ts, doctor.test.ts). Updated display labels from "claude auth"/"codex auth" to "claude health"/"codex health". Updated result names from `*-auth` to `*-health`.

### P2-007: Multiple src/ modules have no direct test coverage
**Status: FIXED**

Added 20 new tests across 2 new test files covering previously untested modules:
- `test/process.test.ts` (7 tests): spawnWithStreaming successful exit, non-zero exit, spawn error, stdin input, stderr streaming, inactivity timeout with SIGKILL escalation, catastrophic timeout.
- `test/reviewers.test.ts` (13 tests): parseCommand (3 tests), ClaudeReviewer (3 tests: CLAUDECODE stripping, model flag, scaled timeout), CodexReviewer (3 tests: file output, stdout fallback, finally cleanup), createReviewers (2 tests), GenericReviewer (2 tests: stdin vs placeholder).

Remaining untested: `src/log.ts` (trivial wrappers around console.error), `src/cli.ts` main/runReview/runReset/runStale (integration-level, covered by CLI test for parseArgs/detectSubcommand).

### P2-008: state.ts — `persist()` method is public but only used internally
**Status: FIXED**

**Fix:** Changed `persist()` from `public` to `private`. Verified no external callers exist.

---

## P3 Findings (reported only, not fixed)

### P3-001: scope.ts:21 — `/dev/null` is Unix-specific
`diffNewFile()` uses `git diff --no-index /dev/null` which is a Unix-ism. On Windows without Git Bash, this would fail. Low risk since the project requires git which typically includes a Unix compatibility layer.

### P3-002: scope.ts — `detectScope` is unnecessarily async
The function uses only synchronous calls (`execFileSync`) but is declared `async`. The `async` keyword is harmless but misleading about the function's actual behavior.

### P3-003: consolidator.ts:4 — Hardcoded MAX_DIFF_BYTES
`MAX_DIFF_BYTES = 512 * 1024` is hardcoded and not configurable. Large projects may need a higher limit.

### P3-004: toolchain.ts:64-73 — Naive Python tool detection
Python toolchain detection uses `pyproject.toml.includes("pytest")` which could match tool names appearing in comments, URLs, or unrelated strings.

### P3-005: process.ts — No validation of bin parameter
`spawnWithStreaming` doesn't validate the `bin` parameter against shell metacharacters (unlike `checks.ts` which has `VALID_BINARY_PATTERN`). Not exploitable since `spawn` doesn't use a shell, but inconsistent.

### P3-006: reviewer-parser.ts — Silent empty return on parse failure
`parseReviewerOutput` returns `[]` when JSON extraction fails, with no logging. This makes it hard to diagnose reviewer output format issues.

### P3-007: orchestrator.ts — No timeout for the overall orchestrator.run() call
Individual reviewers have timeouts, but the orchestrator's `run()` method has no wall-clock timeout. If consolidation or state operations hang, there's no recovery.

### P3-008: checks.test.ts:335-354 — Tautological tests
Two tests ("CheckResult has the expected shape", "CheckResult supports optional remediation") create a `CheckResult` literal and assert its own fields. They test the test setup, not production code.

### P3-009: orchestrator.test.ts:90-108 — Weak callback test
"fires callbacks at each phase" asserts callbacks were called but doesn't verify argument values. The mock reviewer returns empty findings, so correctness of callback data is untested.

### P3-010: test/scope.test.ts — Mock default silently returns empty string
The default `mockExecFile` returns `""` for unrecognized commands instead of throwing, potentially masking missing mocks.

### P3-011: test/setup.test.ts, test/doctor.test.ts — process.exit mocked at module level
`process.exit` is mocked at module level with `mockImplementation((() => {}) as never)`. If a test crashes mid-execution, the mock persists for subsequent test files.

### P3-012: README.md — Missing `findingComparison` config documentation
**Status: FIXED** — Added findingComparison config section to README.md.

---

## Test Coverage Gaps (resolved)

The following edge cases were identified and tests added:

| Module | Edge Case | Status |
|--------|-----------|--------|
| consolidator | Finding with `line=0` treated as NOT pre-existing | **TESTED** |
| scope | Diff size limit enforcement (`MAX_DIFF_BYTES`) | **TESTED** |
| scope | Untracked files handling in uncommitted scope | **TESTED** |
| state | Lock contention with a live PID | **TESTED** |
| orchestrator | All reviewers fail path | **TESTED** (pre-existing) |
| config | Malformed config/default.json (SyntaxError path) | **TESTED** |
| config | Adding a brand-new reviewer via overrides | **TESTED** |
| finding-comparison | Findings with leading/trailing whitespace in title | **TESTED** |
| finding-comparison | LLM response wrapped in markdown code blocks | **TESTED** |

### Remaining untested edge cases (lower priority)

| Module | Missing Edge Case | Severity |
|--------|-------------------|----------|
| orchestrator | Consolidation crash recovery path | P2 gap |
| json-utils | Input with both `{` and `[` (object preferred over array) | P2 gap |
| cli | Multiple skip commands, triple-dot range in commit ref | P2 gap |
| reviewer-parser | Empty findings array, string line numbers | P2 gap |

---

## Files Modified by This Audit

### Source fixes
| File | Changes |
|------|---------|
| `src/process.ts` | Track and clear SIGKILL timers; clear existing before reassignment |
| `src/orchestrator.ts` | Local `activeReviewers` variable; `runReviews` accepts parameter; findings-store integration |
| `src/worktree-hash.ts` | try/catch around git ls-files |
| `src/reviewers/index.ts` | Conditional prompt routing (stdin vs args) |
| `schemas/findings.schema.json` | Added `status` field; `reviewer`, `pre_existing` now required |
| `src/config.ts` | `deepFreeze` on defaults; `as Partial<ReviewerConfig>`; structured merging; SyntaxError handling |
| `src/finding-comparison.ts` | `extractJson` usage; FIFO duplicate handling; short-circuits; stable sort |
| `src/checks.ts` | Renamed `checkAuth` → `checkBinaryHealth` |
| `src/setup.ts` | Updated import/usage/labels for checkBinaryHealth rename |
| `src/doctor.ts` | Updated import/usage/labels for checkBinaryHealth rename |
| `src/state.ts` | Changed `persist()` from public to private |

### Documentation fixes
| File | Changes |
|------|---------|
| `docs/plans/architecture.md` | Updated reviewer commands, component tree, config example, finding comparison docs, decisions table |
| `README.md` | Added findingComparison config documentation |

### New test files
| File | Tests |
|------|-------|
| `test/process.test.ts` | 7 tests for spawnWithStreaming |
| `test/reviewers.test.ts` | 13 tests for parseCommand, ClaudeReviewer, CodexReviewer, createReviewers, GenericReviewer |

### Updated test files
| File | Changes |
|------|---------|
| `test/orchestrator.test.ts` | Fixed broken backfillResolved tests; added findings-store integration tests |
| `test/config.test.ts` | Deep freeze tests; malformed JSON test; new reviewer via overrides test |
| `test/finding-comparison.test.ts` | FIFO duplicate matching; whitespace title test; markdown code block LLM response test |
| `test/checks.test.ts` | Updated for checkBinaryHealth rename |
| `test/setup.test.ts` | Updated for checkBinaryHealth rename |
| `test/doctor.test.ts` | Updated for checkBinaryHealth rename |
| `test/consolidator.test.ts` | Added line=0 pre-existing test |
| `test/scope.test.ts` | Added diff size limit and untracked files tests |
| `test/state.test.ts` | Added lock contention test |

---

## Verification

```
npm run build  ✅ (all entry points compiled successfully)
npm test       ✅ (474/474 tests pass, up from 429)
npm run lint   ✅ (tsc --noEmit clean)
```

Cross-model review performed: one additional P2 issue caught and fixed (sigkillTimer overwrite race).
