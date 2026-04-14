# Future Improvements

## Eval Harness

### Statistical confidence (`--runs N`)
Run each fixture N times and report aggregate stats (mean, stddev, min/max) for precision, recall, and severity accuracy. LLM reviewers are non-deterministic — single-run point estimates don't tell you if 60% recall is typical or an outlier. A `--runs N` flag on `npm run eval` with aggregate reporting would close this gap.

### Larger synthetic repos
All current fixtures are small (12-50 lines per file, ~200 lines total). Real reviews cover diffs spanning hundreds of lines across dozens of files. Reviewer performance on trivial code doesn't predict production performance. Add at least one fixture with a realistic-sized codebase (500+ lines, 10+ files).

### Cross-file data flow fixtures
Current fixtures have bugs self-contained within single files. Add a fixture where the vulnerability requires tracing data from one file through another to a third — e.g., user input accepted in a controller, passed through a service layer, and used unsafely in a data access layer. This tests reviewer capability, not the harness, but having the fixture measures it.

### Broader bug categories
Current coverage is heavy on SQL injection and data exposure. Missing categories: ReDoS, prototype pollution, SSRF, auth/authz logic errors, async race conditions, type coercion bugs, null reference chains. Each new category is just a fixture + golden file — the harness is category-agnostic.

## Consolidator

### Semantic dedup for wide line gaps
The fuzzy dedup uses a 5-line proximity threshold. When two reviewers point at different parts of the same function (e.g., one at the query, one at the return statement 8 lines later), the same finding can survive dedup. Widening the threshold causes false merges in dense code. Options: function-aware grouping (needs a parser), or LLM-based dedup as a third pass after heuristic dedup.

## Reviewers

### Diff-in-prompt mode
Current approach sends file lists and reviewers read from disk. A future mode could inline the diff in the prompt for "dumb pipe" reviewers with no file access. See architecture.md "Future: Diff-in-prompt mode" for details.

## Platform support

### Windows portability
The CLI is currently developed and tested on macOS/Linux only. A self-review surfaced two specific gaps to address before claiming Windows support:

- **Path filter normalization** (`src/scope.ts`): `validatePaths` runs `path.normalize` which produces `\` separators on Windows, but git always emits `/` separators. Filters that pass validation can then match nothing in `filterByPaths`. Fix: normalize filter paths to POSIX (`\` → `/`) before comparison and apply consistently to the file paths returned by git.
- **Absolute path validation** (`src/scope.ts`): the validator rejects only Unix-style absolute paths (`startsWith("/")`) and traversal markers. Windows absolute forms (drive-letter `C:\…` and UNC `\\server\share\…`) slip through despite the error message claiming absolute paths are disallowed. Fix: extend rejection to `^[a-zA-Z]:[\\/]` and `^\\\\`.

Beyond these, a Windows pass should also audit subprocess invocations (`spawn`/`execFileSync` for the reviewer CLIs and git), shell-quoting in any command string round-trips, and lock-file behaviour around `process.kill(pid, 0)` semantics. Until Windows is officially supported, neither finding is a release blocker — they're tracked here so they're not lost.

## Known limitations (alpha — accepted for now)

These came out of the round-7 self-review. Each is real but low-impact at current usage; deferred so the alpha doesn't stay in a fix-then-find loop forever. Severity tags are the original reviewer's P-level — most of these are nits or cosmetic; the P1s are technically functional but cosmetic in practice.

- **[P1 — cosmetic]** **Reviewer-timing data lost on consolidating-phase recovery** (`src/orchestrator.ts:91`). When recovery resumes from `phase: "consolidating"`, `timings` is initialised empty and the `ReviewResult` reports no per-reviewer `elapsedMs`. Doesn't affect findings, only the timing field in the result. Fix: persist per-reviewer timings on `Round` and restore them alongside `reviewerErrors`.
- **[P1 — pre-existing, dead config]** **`outputFormat` config field is dead** (`src/reviewers/index.ts:16`). Validated and accepted in config but no reviewer reads it. Either wire each reviewer to honour it, or drop the field from the schema.
- **[P2 — footgun, no current impact]** **`mergeConfig` mutates its `parsed` argument** (`src/config.ts:132`). `validateAndStripInvalid` strips invalid fields in-place. Now that the CLI calls this with the override object it just built, the caller's overrides get silently sanitised. Harmless today (CLI doesn't reuse the object) but a footgun. Fix: clone before validating.
- **[P2 — heuristic edge case]** **`isGitRef` SHA heuristic still ambiguous** (`src/parse-args.ts:48`). Tightened to require both letters and digits, which catches `deadbeef` and `1234567`. But `abcdef1234567` (and similar mixed hex names) still classify as refs. Fix is `git rev-parse --verify` against the repo, but that adds I/O to a currently-pure parser — deferred.
- **[P2 — edge case]** **Uncommitted scope: empty diff with non-empty file list** (`src/scope.ts:220`). When the only uncommitted change is an empty new file, the file appears in `scope.files` but contributes nothing to `scope.diff`. Reviewers see "review this file" with no diff content. Fix: include zero-byte untracked files via `--diff-filter` or filter empty files out of `scope.files` for consistency.
- **[P2 — divergence risk]** **JSONL entries duplicate `status`** (`src/findings-store.ts:62`). Each JSONL record stores `status` both at the top level and inside `finding.status`. Append-only file so no current divergence, but two writes could drift. Fix: pick one location and always derive the other on read.
- **[P2 — cosmetic in persisted state]** **Continuing sessions retain stale `scope.files`** (`src/state.ts:145`). `startOrContinue` only writes the resolved scope on new sessions. If the user fixes a file between rounds, `scope.files` from round 1 still contains it. The orchestrator computes a fresh diff each round so reviewers don't actually see stale files, but the persisted `scope` object lies. Fix: refresh `scope.files` and `scope.diff` on every continue.
- **[P3 — nit]** **`tryBalancedParse` only tracks one delimiter type** (`src/json-utils.ts:28`). The walker tracks `{}` *or* `[]` but not nested mixes — relies on `JSON.parse` for actual validation. The current usage (extracting JSON from noisy LLM stdout) survives this because `JSON.parse` is the ultimate gate. Fix: track both delimiters via a stack if we ever extend the walker's responsibility.
