# Manual Testing Matrix

Tests that require real LLM calls and can't be covered by unit tests.
Each test verifies pipeline mechanics AND review quality together.

## Axes

| Axis | Values |
|------|--------|
| **Scope mode** | uncommitted, commit ref (`HEAD~1`), branch vs main |
| **Reviewers** | claude only, codex only, both |
| **Rounds** | max 1 (no loop), default (max 5, stop at P1) |
| **Entry point** | CLI (`review-orchestra`), skill (`/review-orchestra`) |

## Core test matrix

Priority order — test top to bottom, stop when confident.

### P0: Must work

| # | Scope | Reviewers | Rounds | Entry | What it proves | Status |
|---|-------|-----------|--------|-------|----------------|--------|
| 1 | uncommitted | claude | max 1 | skill | Basic pipeline + skill discovery | PASS — 3 findings in json-utils, fixer applied correct fixes |
| 2 | commit ref | both | max 1 | skill | Parallel reviewers, commit ref scope | PASS — claude 0, codex 18. See notes below |
| 3 | uncommitted | both | default | skill | Full loop: fix → re-review → stop condition | PASS — 27→7→6→2→2 over 5 rounds. Converges. See notes below |
| 4 | uncommitted | both | max 1 | CLI | Both reviewers on stripped fixtures via `src/` path | PASS — claude 14, codex 14, consolidated 28 |
| 5 | commit ref | both | default | CLI | Multi-round with commit ref scope | PASS — 27→7→4→2→1 over 5 rounds. Converges. |

### P1: Should work

| # | Scope | Reviewers | Rounds | Entry | What it proves | Status |
|---|-------|-----------|--------|-------|----------------|--------|
| 6 | uncommitted | codex | max 1 | CLI | Codex adapter in isolation | PASS — 11 findings, all legitimate |
| 7 | branch | claude | max 1 | CLI | Branch vs main scope detection | PASS — correct scope "Branch test/pipeline-check vs main", 15 findings |
| 8 | commit ref | both | max 1 | CLI | Commit ref, both reviewers via CLI | PASS — claude 15, codex 11, consolidated 26 |
| 9 | uncommitted | both | default | skill | Full loop via skill entry point | PASS — 26→9→5→4→6. Fixer got creative, see notes |

### P2: Nice to have

| # | Scope | Reviewers | Rounds | Entry | What it proves | Status |
|---|-------|-----------|--------|-------|----------------|--------|
| 10 | uncommitted | both | max 1 | CLI | Dry run mode (`dry run`) | PASS — correct config output, no LLM calls |
| 11 | uncommitted | claude | max 1 | CLI | Path filtering (`src/uploads.ts`) | PASS — 1 file scoped, 6 upload-specific findings |
| 12 | uncommitted | claude | max 1 | CLI | Extended threshold (`fix quality issues too`) | PASS — stopAt=p2, 14 findings incl P2 quality issue |
| 13 | uncommitted | claude | max 1 | CLI | Model override (`use sonnet for claude`) | PASS — sonnet model passed through, 14 findings |

## Test results log

### Test 1 — 2026-03-14
**Config**: uncommitted scope, claude only, max 1 round, skill entry
**Scope detected**: Uncommitted changes on main (15 files)
**Findings**: Claude found 3 issues in `src/json-utils.ts`:
- P1: `extractJson` lost balanced-brace walker from old fixer.ts (regression)
- P2: `unwrapCliEnvelope` doesn't handle non-string result objects
- P2: Missing test coverage for trailing-text regression
**Fixer**: Applied correct fixes — added brace walker, object-result branch, test cases
**Post-fix**: 145 tests pass, lint clean
**Bugs found in review-orchestra itself**: 3 (all real, all fixed by fixer)

### Test 2 — 2026-03-14
**Config**: HEAD~1 scope, both reviewers, max 1 round, skill entry
**Scope detected**: Changes in HEAD~1..HEAD (15 files)
**Findings**:
- Claude: 0 findings — recognized fixture `BUG` comments as intentional test data
- Codex: 18 findings — found all 12+1 entangled bugs, 3 dogfood bugs, 1 json-utils bug, 1 extra path traversal
**Fixer**: Applied correct fixes to all 18
**Post-fix**: Fixtures restored via `git checkout evals/repos/`
**Bugs found in review-orchestra itself**:
- `onReviewerError` callback was missing — codex failures were silently swallowed (fixed)
- `extractJson` misparses bracket-prefixed prose `prefix [1] {"findings":...}` (fixed by codex's fixer)
- Entangled golden file was missing `saveUploadExclusive` path traversal (updated)
**Key insight**: Claude ignores code with `BUG` comments; codex treats all code literally. Stripped all hint comments from fixtures.

### Test 3 — 2026-03-14
**Config**: uncommitted scope, both reviewers, default rounds (max 5, stop at P1), skill entry
**Setup**: copied entangled fixture to `src/services/` for realistic path
**Scope detected**: Uncommitted changes on main (4 files)
**Round progression**:
| Round | Claude | Codex | Actionable | Pre-existing |
|-------|--------|-------|-----------|-------------|
| 1 | 15 | 12 | 27 | 0 |
| 2 | 7 | 4 | 7 | 4 |
| 3 | 5 | 5 | 6 | 4 |
| 4 | 0 | 5 | 2 | 3 |
| 5 | 0 | 4 | 2 | 2 |
**Result**: 44 fixed, 2 remaining (P1 filename length edge case, P2 query efficiency nit), 2 pre-existing correctly tagged
**Bugs found in review-orchestra itself**:
- Multi-round staleness: original approach sent the same diff every round. Reviewers kept finding already-fixed bugs. Fixed by switching to file-list prompt (reviewers read current files from disk).
- First attempt: 5 rounds, never converged (27→23→23→22→23). After fix: 27→7→6→2→2.
**Key insight**: File-list prompt is strictly better than inline diff for reviewers with file access. Eliminates staleness, avoids token limits, lets reviewers explore context naturally.

### Test 9 — 2026-03-14
**Config**: uncommitted scope, both reviewers, default rounds (max 5, stop at P1), skill entry
**Round progression**: 26→9→5→4→6
**Result**: Did not converge — round 5 went UP from 4 to 6. Hit max rounds.
**Root cause**: Fixer got creative in later rounds — added connection pooling, extension blocklists, session immutability. Each improvement introduced new edge cases that reviewers flagged. Original P0 security bugs were fixed by round 2.
**Fix applied**: Tightened fix prompt with instruction #8: "Do NOT add new features, patterns, abstractions, or architectural improvements beyond what is needed to fix each specific finding."
**Also found**: Fixer modified files outside scope (moved PLAN.md). Added instruction #7 to restrict edits to finding files only.
**Also found**: Multiple model override parsing bug — `use opus for claude use o4 for codex` only parsed the first model. Fixed with loop. Added unit test.

## Test procedure

### Setup for uncommitted scope tests (preferred)
```bash
# Copy entangled fixture into working tree under a realistic path
mkdir -p src/services
cp evals/repos/entangled/src/*.ts src/services/

# Run the test
review-orchestra "max 1 round"

# Cleanup — restore fixture files too in case fixer modified the originals via evals/ path
rm -rf src/services/
git checkout evals/repos/
```

### Setup for commit ref tests
```bash
# Create a commit with buggy code under a realistic path
mkdir -p src/services
cp evals/repos/entangled/src/*.ts src/services/
git add src/services/
git commit -m "test: add service layer"

# Run against that commit
review-orchestra "HEAD~1 max 1 round"

# Cleanup
git reset --soft HEAD~1
rm -rf src/services/
git checkout .
```

### Setup for branch tests
```bash
git checkout -b test/pipeline-check
mkdir -p src/services
cp evals/repos/entangled/src/*.ts src/services/
git add src/services/
git commit -m "test: add service layer"

# Run
review-orchestra "max 1 round"

# Cleanup
git checkout main
git branch -D test/pipeline-check
```

## What to verify in each test

1. **Scope detection** — stderr shows correct file list and scope mode
2. **Reviewer output** — findings are parsed (not empty), envelope unwrapping works
3. **Consolidation** — dedup works (when using both reviewers), P-levels computed
4. **Stop condition** — loop stops when expected (P0/P1 findings resolved, or max rounds hit)
5. **Fixer** — files actually modified, fix report parsed correctly
6. **Re-review** — round 2+ reviewers see post-fix code, find new/remaining issues
7. **Summary** — final JSON has correct round count, fixed/remaining/pre-existing counts

## Known edge cases to watch

- **CLAUDECODE env var**: must be stripped for nested `claude -p` calls (reviewer + fixer)
- **CLI envelope**: `claude -p --output-format json` wraps in `{"type":"result","result":"..."}` — both reviewer parser and fixer must unwrap
- **Codex envelope**: codex output format may differ — untested
- **Untracked files**: `git diff` misses new files — scope detection must also run `git ls-files --others --exclude-standard`
- **Empty diff**: no changes → should exit cleanly with "nothing to review"
- **Large diff**: many files → may hit token limits on reviewer prompt
- **Fixture comments**: fixture source files must NOT contain `BUG`/hint comments — Claude recognizes them as intentional test data and returns 0 findings
- **Fixture paths**: copy fixtures to `src/services/` (not `evals/repos/`) so reviewers treat them as production code

## Automating these tests

These tests can be automated as integration tests once the pipeline is stable.
See the section below.

### What can be automated with mocked LLM calls

Pipeline mechanics — does the orchestrator call the right things in the right order:
- Scope detection picks correct mode
- Reviewers are spawned with correct commands
- Consolidator receives reviewer output
- Stop condition evaluated correctly
- Fixer spawned when needed
- Loop increments round counter
- Summary generated at end

**How**: Replace `execSync` calls with a mock that returns canned reviewer/fixer output.
The orchestrator test (`test/orchestrator.test.ts`) already does this for basic flow.
Extend it with canned multi-round scenarios.

### What requires real LLM calls (eval harness)

Review quality — do the models actually find the bugs:
- Precision: are reported findings real issues?
- Recall: are planted bugs detected?
- Severity accuracy: correct confidence × impact classification?
- Fix quality: does the fixer produce correct code?
- Multi-round: does re-review catch fixer regressions?

**How**: `npm run eval` against fixtures in `evals/repos/`. LLM-as-judge compares
findings to golden files. This is already scaffolded — needs the eval runner
to support multi-round scenarios (currently single-round only).

### Recommended automation path

1. **Now**: Manual testing through the matrix above to build confidence
2. **Next**: Extend `test/orchestrator.test.ts` with canned multi-round mock scenarios
3. **Then**: Extend eval harness (`npm run eval`) to run full pipeline against fixtures
   and score with LLM-as-judge — this replaces manual tests 1–4
4. **Later**: CI integration — run mock-based tests on every commit, eval harness on release
