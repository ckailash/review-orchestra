# Changelog

## 0.1.2

### Added
- Concurrent-run prevention via `.review-orchestra/state.lock` (PID-tracked, atomic-rename release protocol with TOCTOU re-check).
- Reviewer raw output persisted to `.review-orchestra/round-N-<reviewer>-raw.txt` immediately after spawn (preserved on parse failure as `*.raw.txt`; codex temp output renamed to `.failed` on failure for diagnosis).
- `Round.reviewerErrors` persisted in `session.json` so crash recovery from the consolidating phase surfaces original reviewer failures instead of silently reporting zero errors.
- `ReviewResult.thresholds` exposes the active `stopAt` so the skill renders threshold-band recommendations from the result rather than re-deriving them.
- Per-CLI-invocation `progress.json` for live reviewer status (running / done / error / findingsCount / elapsedMs).
- `docs/improvements.md` Windows-portability section documenting known gaps (path-separator normalization, absolute path validation) before officially supporting Windows.

### Changed
- Recovery from the `reviewing` phase no longer aborts when every remaining reviewer fails — saved findings from the original run carry the round (`runReviews(..., { tolerateAllFailure: true })`).
- Detached HEAD scope no longer leaks the literal `"HEAD"` as `baseBranch`; produces `detached@<sha7>` and a `(detached HEAD at <sha7>)` description so cross-round comparison stays stable.
- Preflight resolves the comparison-call binary from the configured Claude reviewer command (parseCommand) instead of hardcoding `claude`. Custom paths/wrapper scripts no longer trigger false missing-binary warnings.
- CLI overrides routed through `mergeConfig` for free `validateAndStripInvalid` coverage; bespoke `mergeReviewerOverrides` helper removed.
- `parse-args.ts` natural-language directives anchored with `(?<=^|\s)…(?=\s|$)` so quoted path tokens like `src/fix everything/foo.ts` no longer false-trigger directive matchers. `skip` and `only` accept hyphenated reviewer names. `isGitRef` SHA heuristic requires both letters AND digits (rejects `deadbeef`, `1234567`).
- `parseCommand` handles `\"` and `\\` inside quoted segments (regex `"(?:[^"\\]|\\.)*"` + unescape pass), so reviewer commands with embedded quotes round-trip losslessly.
- `releaseLock` PID-guarded with atomic-rename protocol; release on session expiry wrapped in `try/finally` so a `persist` failure can no longer strand the lock.
- `findings-store.backfillResolved` collapsed into a single pass (parse-once + conditional rewrite); strictly cheaper than the prior scan + rewrite when matches exist.
- `computeWorktreeHash` deferred to the non-recovery branch so crash-recovery paths skip the unused git-subprocess work.

### Fixed
- Failure-path reviewer timing now computed from a tracked `startMs` instead of reading back from the shared progress object (no silent fallback to `0`).
- CLI argv → string round-trip escapes both backslash and quote so paths like `foo\bar` survive `parseArgs`.
- `runReviews({ tolerateAllFailure: true })` only kicks in when the recovering round has saved findings to fall back on; otherwise an all-failed rerun correctly throws instead of silently producing a zero-finding success.
- `computeWorktreeHash` on a fresh repo (no HEAD) now combines `git diff --cached` AND `git diff` so unstaged edits to staged files affect the hash. Previously day-zero repos silently lost unstaged-edit detection.
- `validateAndStripInvalid` now rejects non-string `reviewers.<name>.command` and `reviewers.<name>.model` (warn + strip), preventing a typo'd config from crashing later inside `parseCommand` with a confusing "command.match is not a function" error.
- Numerous smaller correctness fixes from seven rounds of multi-model self-review (see commit history `v0.1.1..HEAD`).

### Known limitations (alpha)
See `docs/improvements.md` for the round-7 findings deliberately deferred for future work — reviewer-timing data lost on consolidating-phase recovery, dead `outputFormat` config field, `mergeConfig` argument mutation, residual `isGitRef` ambiguity, empty-untracked-file scope inconsistency, JSONL `status` duplication, stale `scope.files` on continuing sessions, and single-delimiter tracking in `tryBalancedParse`.

## 0.1.1

### Added
- Landing page at `docs/index.html`.
- Config cascade: package defaults → `~/.review-orchestra/config.json` → `.review-orchestra/config.json`.
- npm publish via OIDC trusted publishing (no token required in CI).
- GitHub Actions workflows for CI and npm publish (Node 22 LTS, Actions v5).

### Changed
- Bumped Node engines requirement to `>=22`.

## 0.1.0

### Added
- Multi-model code review orchestration (Claude + Codex in parallel)
- Supervised review loop with user-controlled fixing
- Two-axis severity classification (confidence × impact → P0-P3)
- Cross-round finding comparison via LLM semantic matching (haiku)
- Session persistence with worktree hash stale detection
- Pre-existing finding detection via diff hunk analysis
- Finding quality fields: expected/observed/evidence (optional)
- Design intent review via commit message context
- `review-orchestra setup` — first-time install and repair
- `review-orchestra doctor` — diagnose broken installs
- `review-orchestra review` — run reviewers and consolidate
- `review-orchestra stale` — check if files changed since last review
- `review-orchestra reset` — clear session state
- Cross-session finding storage (`~/.review-orchestra/findings.jsonl`)
- Real-time progress reporting (stderr + progress.json)
- Fuzzy matching for cross-reviewer finding dedup (same bug, different wording)
- Clean-code eval fixture for false-positive-rate measurement
- Multi-round eval harness with cross-round assertion coverage
- Deterministic severity-accuracy computation in eval judge
- Expanded golden fixtures for improved recall measurement
- Pluggable reviewer interface — any CLI tool can be a reviewer
- Natural-language CLI arguments — no `--flags` needed
