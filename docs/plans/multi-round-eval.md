# Plan: Multi-Round Eval

## Context

The eval harness only tests single-round review. Multi-round review (fix-and-re-review) is a core capability — the orchestrator tracks rounds, compares findings across rounds (new/persisting/resolved), and preserves finding IDs. None of this is validated by evals. We need a multi-round eval fixture that tests cross-round orchestration plumbing: state continuity, finding status transitions, ID preservation, and resolved detection.

**Non-goal:** This eval does not test semantic (LLM/fuzzy) matching quality. The heuristic matcher is already covered by unit tests (`test/finding-comparison.test.ts`). The fixture is designed so the heuristic path handles all matches; the eval validates that the orchestration correctly wires comparison results through the full pipeline.

**Key principle — exact lineage, not lineage existence:** The eval must prove that each persisting/resolved finding carries the *exact* ID it was assigned in round 1, not just that *some* round-1 ID is present. A prefix check (`r1-f-*`) would miss ID swaps between two findings. The harness captures round-1's actual ID assignments and asserts exact equality in round 2.

## What to test

A multi-round eval validates:
1. **Round 1 findings** are correctly identified (precision/recall)
2. After a simulated fix, **round 2** correctly:
   - Tags fixed bugs as `resolved` (in `resolvedFindings`, with original `r1-f-*` IDs preserved)
   - Tags unfixed bugs as `persisting` (with status `"persisting"` and the **exact** round-1 ID for that specific finding — not just any `r1-f-*` ID)
   - Tags regression bugs as `new` (with status `"new"` and round-2 IDs)
   - Carries round-2 metadata (updated severity/confidence) on persisting findings, not stale round-1 values. At least one persisting finding must have intentionally different metadata between rounds to make this assertion meaningful.
   - Correctly tags findings in untouched code as `pre_existing` via real diff-based scope
3. **Session continuity** works across rounds — the orchestrator creates round 2 within the same session without expiring
4. **Edge case: all-resolved round** — when the patch fixes everything, round 2 has zero current findings and all previous findings are resolved

## Design

### Fixture directory structure

```
evals/repos/multi-round/
  src/api.ts              # source with planted bugs
evals/multi-round/
  patches/fix-round1.patch   # patch fixing 1 bug, introducing 1 regression
  README.md                  # describes the fixture
```

> **Important:** Only `evals/repos/multi-round/` is copied to the temp dir and scoped for review. `patches/` and `README.md` live outside the repo directory under `evals/multi-round/` so they are never included in the review scope. (F1)

### Fixture: `multi-round`

**`evals/repos/multi-round/src/api.ts`** — source with 3 planted bugs:
1. SQL injection in `getUser()` — will be FIXED between rounds
2. Missing input validation in `createUser()` — will PERSIST across rounds
3. Hardcoded secret — will PERSIST across rounds

**`evals/multi-round/patches/fix-round1.patch`** — a patch file that:
- Fixes bug #1 (parameterizes the SQL query)
- Introduces a NEW bug #4 (e.g., a path traversal in a new function added by the "fix")

### Fixture: `multi-round-all-resolved` (edge case)

**`evals/repos/multi-round-all-resolved/src/api.ts`** — source with 2 planted bugs.

**`evals/multi-round-all-resolved/patches/fix-all.patch`** — fixes both bugs, introduces none.

This exercises the `currentFindings.length === 0` short-circuit in `compareFindings()` (`finding-comparison.ts:347`), which returns all previous findings as resolved. (F11)

### Golden format

**`evals/golden/multi-round.json`**:
```json
{
  "fixture": "multi-round",
  "rounds": [
    {
      "expected_findings": [
        {
          "description": "SQL injection in getUser()",
          "expected_impact": "critical",
          "expected_confidence": "verified",
          "expected_status": "new",
          "expected_pre_existing": false
        },
        {
          "description": "Missing input validation in createUser()",
          "expected_impact": "functional",
          "expected_confidence": "likely",
          "expected_status": "new",
          "expected_pre_existing": false
        },
        {
          "description": "Hardcoded database password",
          "expected_impact": "critical",
          "expected_confidence": "verified",
          "expected_status": "new",
          "expected_pre_existing": false
        }
      ]
    },
    {
      "expected_findings": [
        {
          "description": "Missing input validation in createUser()",
          "expected_impact": "quality",
          "expected_confidence": "likely",
          "expected_status": "persisting",
          "expected_pre_existing": true
        },
        {
          "description": "Hardcoded database password",
          "expected_impact": "critical",
          "expected_confidence": "verified",
          "expected_status": "persisting",
          "expected_pre_existing": true
        },
        {
          "description": "Path traversal in exportUser()",
          "expected_impact": "critical",
          "expected_confidence": "verified",
          "expected_status": "new",
          "expected_pre_existing": false
        }
      ],
      "expected_resolved": [
        { "description": "SQL injection in getUser()", "expected_id_prefix": "r1-f-" }
      ]
    }
  ]
}
```

Design decisions in this format (F4, F12, F13):
- **No `round` field** — array index is the round number (0-indexed in JSON, 1-indexed in display). Avoids redundancy.
- **`expected_status` per finding** instead of `expected_persisting_count`/`expected_new_count`. A broken matcher that tags the wrong finding as persisting would pass a count check but fail a per-finding check.
- **`expected_pre_existing` per finding** — asserts that round-2 scope construction correctly tags findings in untouched code. (F2)
- **`expected_id_prefix` on resolved findings** — a minimum bar; the harness also asserts the **exact** round-1 ID (see ID preservation below). (F12)
- **Intentionally different round-2 severity** — "Missing input validation" changes from `functional` (round 1) to `quality` (round 2). If the harness accidentally carries stale round-1 metadata, `persisting_metadata_fresh` fails. Without this difference, the check would be vacuously true. (F13)

### Exact ID preservation (F12)

The harness must prove *exact* lineage, not just lineage existence. A prefix check (`r1-f-*`) would miss an ID swap where finding A gets finding B's ID and vice versa.

**Approach:** After judging round 1, `runMultiRoundFixture()` builds an `id_map: Record<string, string>` that maps each golden finding description to the actual ID assigned by `assignFindingIds()` in round 1. For round 2:

- **Persisting findings**: the harness looks up the round-1 ID for that finding's description in `id_map` and asserts exact equality (`actual.id === id_map[description]`).
- **Resolved findings**: same — the resolved finding's ID must exactly match the round-1 ID for that description.

This catches:
- ID swaps (finding A gets finding B's round-1 ID)
- ID regeneration (persisting finding gets a new `r2-f-*` ID instead of keeping its `r1-f-*` ID)
- Partial preservation (one persisting finding keeps its ID, another doesn't)

### Changes to `evals/run-eval.ts`

Add a `runMultiRoundFixture()` function alongside the existing `runFixture()`:

1. Copy `evals/repos/multi-round/` to a temp dir, init git, commit (same as single-round)
2. Build scope using synthetic `/dev/null` diffs (all code is new — correct for round 1)
3. Create orchestrator with **`findingComparison: { method: "heuristic", ... }`** pinned in config (F6)
4. **Round 1**: `orchestrator.run(scope)` — collect `ReviewResult`
5. **Apply patch**: `git apply --whitespace=fix <path-to-evals/multi-round/patches/fix-round1.patch>` in the temp dir, then `git add . && git commit -m "apply fix"` (F9)
6. **Rebuild scope for round 2** (F2, F15):
   - **`newScope.diff`**: Use `git diff HEAD~1` to get only the patch delta. The consolidator uses diff hunks to decide `pre_existing` — a narrow diff means findings in untouched lines are correctly tagged `pre_existing: true`.
   - **`newScope.files`**: Use the **full file list from round 1** (all files in the repo), NOT the files derived from the commit diff. Reviewers are prompted from `scope.files` (`src/reviewers/prompt.ts:10`), not from diff hunks. If `files` only contains the changed files, the two persisting findings in untouched code won't be in the review scope at all and the eval will fail to detect them. The diff narrows what the consolidator considers actionable; the file list controls what the reviewers see.
   - **`newScope.type`**, **`newScope.baseBranch`**, **`newScope.description`**: Must be identical to round-1 scope values.

   > **Session-identity constraint (F3):** `hasScopeBaseChanged()` in `state.ts:57` compares `type`, `baseBranch`, `baseCommitSha`, and `description`. It will expire the session if any differ. `baseCommitSha` is safe to omit (only compared when both are set). `diff` and `files` may change freely.

7. **Round 2**: `orchestrator.run(newScope)` — collect `ReviewResult` including `resolvedFindings`
8. **Judge both rounds** using `judgeMultiRound()` (see below)

### Changes to `evals/judge.ts`

#### Type definitions

```typescript
// Discriminated union for golden fixtures (F8)
export interface SingleRoundGolden {
  fixture: string;
  expected_findings: GoldenFinding[];
}

export interface MultiRoundGoldenFinding extends GoldenFinding {
  expected_status?: "new" | "persisting";
  expected_pre_existing?: boolean;
}

export interface MultiRoundGoldenRound {
  expected_findings: MultiRoundGoldenFinding[];
  expected_resolved?: Array<{ description: string; expected_id_prefix?: string }>;
}

export interface MultiRoundGolden {
  fixture: string;
  rounds: MultiRoundGoldenRound[];
}

export type GoldenFixture = SingleRoundGolden | MultiRoundGolden;

export function isMultiRoundGolden(g: GoldenFixture): g is MultiRoundGolden {
  return "rounds" in g && Array.isArray((g as MultiRoundGolden).rounds);
}

export interface CheckWithCoverage {
  pass: boolean;    // did all checked findings pass?
  checked: number;  // how many findings were verified (depends on judge match quality)
  total: number;    // how many golden findings have this expectation
}

export interface MultiRoundJudgeResult {
  rounds: JudgeResult[];                       // standard precision/recall/severity per round
  resolved_matched: number;                    // how many expected_resolved were actually resolved
  resolved_total: number;                      // total expected_resolved
  resolved_ids_exact: CheckWithCoverage;       // resolved findings have exact round-1 IDs (F12)
  status_correct: CheckWithCoverage;           // per-finding expected_status matched
  pre_existing_correct: CheckWithCoverage;     // per-finding expected_pre_existing matched
  persisting_ids_exact: CheckWithCoverage;     // persisting findings have exact round-1 IDs (F12)
  persisting_metadata_fresh: CheckWithCoverage;// persisting findings carry round-2 metadata (F7/F13)
}
```

#### `judgeMultiRound()` function

Extends `judge()`:
- Round 1 and round 2 finding quality use the existing `judge()` function
- Multi-round-specific checks are field-level comparisons on the findings that `judge()` matched to golden entries. Each check reports `{ pass, checked, total }` — `checked` may be less than `total` when the judge fails to match a golden finding, and the recall score from the corresponding round already reflects that gap. The checks:
  - `status_correct`: each matched finding's `status` field matches the corresponding `expected_status` from the golden
  - `pre_existing_correct`: each matched finding's `pre_existing` field matches `expected_pre_existing` (F2)
  - `resolved_ids_exact`: each resolved finding's ID exactly matches the ID that finding was assigned in round 1 (looked up via `id_map`). Catches ID swaps, not just prefix presence. (F12)
  - `persisting_ids_exact`: each matched persisting finding's ID exactly matches its round-1 assignment (looked up via `id_map`). Catches swaps between two persisting findings. (F12)
  - `persisting_metadata_fresh`: persisting findings carry metadata from the current round's review, not stale round-1 metadata. Checked by verifying the finding's impact/confidence against round-2 golden expectations. The "Missing input validation" finding intentionally changes from `functional` to `quality` between rounds — if stale metadata leaks through, this fails. (F7, F13)

### Changes to `EvalResult` shape in `evals/run-eval.ts` (F14)

The current `EvalResult` has `judge: JudgeResult`, and the summary loop prints `r.judge.precision` directly. Multi-round evals produce `MultiRoundJudgeResult` which has no top-level `precision`. Two changes needed:

```typescript
// Union result type
interface EvalResult {
  fixture: string;
  judge: JudgeResult | MultiRoundJudgeResult;
  timestamp: string;
}

```

`isMultiRoundJudge` is exported from `judge.ts` alongside the other type guards — no local redefinition needed in `run-eval.ts`.

**Summary rendering** becomes fixture-aware, showing coverage alongside each check:
```typescript
const fmtCheck = (c: CheckWithCoverage) => `${c.pass} (${c.checked}/${c.total})`;

for (const r of results) {
  if (isMultiRoundJudge(r.judge)) {
    const mr = r.judge;
    for (let i = 0; i < mr.rounds.length; i++) {
      const rj = mr.rounds[i];
      console.log(`${r.fixture} r${i+1}: precision=${fmt(rj.precision)} recall=${fmt(rj.recall)}`);
    }
    console.log(`${r.fixture} cross-round: status=${fmtCheck(mr.status_correct)} pre_existing=${fmtCheck(mr.pre_existing_correct)} ids_exact=... metadata_fresh=${fmtCheck(mr.persisting_metadata_fresh)}`);
  } else {
    console.log(`${r.fixture}: precision=${fmt(r.judge.precision)} recall=${fmt(r.judge.recall)}`);
  }
}
```

The JSON results file stores the full union — consumers distinguish via the `rounds` field. Each `CheckWithCoverage` field shows how many findings were actually verified, so partial judge recall is immediately visible in the cross-round output.

### Detection of multi-round fixtures

`main()` uses the `isMultiRoundGolden()` type guard (F8) to route:
```typescript
const golden = JSON.parse(readFileSync(goldenPath, "utf-8")) as GoldenFixture;
if (isMultiRoundGolden(golden)) {
  result = await runMultiRoundFixture(fixtureName, golden, judgeModel);
} else {
  result = await runFixture(fixtureName, golden, judgeModel);
}
```

This prevents `runFixture()` from silently accessing `golden.expected_findings` on a multi-round golden (which would be `undefined`).

### Finding comparison config (F6)

The eval harness pins the finding comparison method to avoid flaky LLM calls:

```typescript
const config = loadConfig({
  thresholds: { stopAt: "p3" },
  findingComparison: { method: "heuristic", model: "", timeoutMs: 0, fallback: "heuristic" },
});
```

This ensures the eval tests orchestration plumbing deterministically. LLM comparison quality is a separate concern tested by `test/finding-comparison.test.ts`.

### Scope of semantic matching claims (F5)

This eval tests orchestration integration: state management, round transitions, finding status assignment, ID preservation, and resolved detection. It does **not** test semantic matching quality — the fixture's persisting findings have stable file + title across rounds, so the heuristic matcher handles them without fuzzy/LLM logic.

To genuinely test semantic matching across rewording and line shifts, add a dedicated finding-comparison eval with fixtures designed to defeat the heuristic (renamed functions, reworded descriptions, shifted line numbers). That is out of scope for this plan.

## Files to modify

| File | Change |
|------|--------|
| `evals/repos/multi-round/src/api.ts` | New — source with 3 planted bugs |
| `evals/multi-round/patches/fix-round1.patch` | New — patch fixing 1 bug, introducing 1 regression (outside repo dir) |
| `evals/multi-round/README.md` | New — describes the fixture (outside repo dir) |
| `evals/repos/multi-round-all-resolved/src/api.ts` | New — source with 2 planted bugs (F11) |
| `evals/multi-round-all-resolved/patches/fix-all.patch` | New — patch fixing all bugs (F11) |
| `evals/golden/multi-round.json` | New — multi-round golden with per-finding status/pre_existing |
| `evals/golden/multi-round-all-resolved.json` | New — all-resolved edge case golden (F11) |
| `evals/run-eval.ts` | Add `runMultiRoundFixture()`, `EvalResult` union type, `isMultiRoundJudge()` guard, fixture-aware summary rendering, golden type guard routing, pinned heuristic config |
| `evals/judge.ts` | Add discriminated union types, `isMultiRoundGolden()`, `judgeMultiRound()` |
| `test/eval-routing.test.ts` | New — unit tests for golden routing and multi-round scope construction (F10) |

## Files NOT modified

- `src/orchestrator.ts` — multi-round already works, just untested by evals
- `src/finding-comparison.ts` — no changes needed
- `src/state.ts` — no changes needed (session-identity stability is the harness's responsibility)
- Existing golden files — unchanged
- Existing test files — unchanged

## Implementation notes

### git apply robustness (F9)

Use `git apply --whitespace=fix` to handle whitespace/line-ending differences across platforms:
```typescript
execFileSync("git", ["apply", "--whitespace=fix", patchPath], { cwd: tempDir, stdio: "pipe" });
```

### Unit tests for eval control flow (F10)

`test/eval-routing.test.ts` covers:
1. **Golden format detection** — `isMultiRoundGolden()` correctly identifies single-round vs. multi-round goldens
2. **Result type detection** — `isMultiRoundJudge()` correctly identifies single-round vs. multi-round judge results (F14)
3. **Scope identity stability** — round-2 scope construction preserves `type`, `baseBranch`, `description` from round-1 scope
4. **`judgeMultiRound()` deterministic checks** — status matching, pre_existing matching, exact ID preservation (no swaps), metadata freshness with intentionally different severity
5. **Summary rendering** — fixture-aware summary correctly branches on result type (F14)

These are pure-function unit tests with no LLM calls.

## Verification

1. `npm run build` — clean
2. `npm run lint` — clean
3. `npm test` — all existing tests pass + new `eval-routing.test.ts` passes
4. `npm run eval -- multi-round` — runs the multi-round fixture, reports:
   - Round 1 precision/recall/severity
   - Round 2 precision/recall/severity
   - Per-finding status correctness (new/persisting matched expected)
   - Per-finding pre_existing correctness
   - Resolved accuracy (did fixed bugs show as resolved?)
   - Resolved exact ID match (resolved findings carry the exact round-1 ID for that specific finding)
   - Persisting exact ID match (persisting findings carry the exact round-1 ID, no swaps)
   - Persisting metadata freshness (round-2 severity/confidence, not stale)
5. `npm run eval -- multi-round-all-resolved` — runs the all-resolved edge case:
   - Round 1 precision/recall
   - Round 2: zero current findings, all previous resolved
6. `npm run eval` — all fixtures run (existing single-round + 2 multi-round)

## Review findings addressed

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| F1 | Support files reviewed as code | High | Moved patches/ and README.md outside repo dir |
| F2 | Round-2 scope needs real git diff | High | Commit patch, use `git diff HEAD~1`, add `expected_pre_existing` |
| F3 | Session expiry on scope rebuild | High | Documented session-identity constraint, harness keeps fields stable |
| F4 | Count-based assertions too weak | Medium | Per-finding `expected_status`, `expected_id_prefix` on resolved |
| F5 | Overclaims semantic matching | Medium | Scoped claims to orchestration plumbing, removed semantic claim |
| F6 | Comparison method not pinned | Medium | Forced `method: "heuristic"` in eval config |
| F7 | Severity drift unasserted | Medium | Added `persisting_metadata_fresh` check in `judgeMultiRound()` |
| F8 | No type guard for golden routing | Low | Discriminated union type + `isMultiRoundGolden()` |
| F9 | Patch robustness | Low | `git apply --whitespace=fix`, patch outside review scope |
| F10 | No tests for eval control flow | Low | Added `test/eval-routing.test.ts` |
| F11 | All-resolved edge case | Low | Added `multi-round-all-resolved` fixture |
| F12 | ID preservation checks too weak (prefix not exact) | Medium | Exact ID map from round 1, assert exact equality on persisting + resolved |
| F13 | persisting_metadata_fresh vacuously true | Medium | Changed "input validation" from `functional` → `quality` between rounds |
| F14 | EvalResult shape incompatible with multi-round | Low | Union type `JudgeResult \| MultiRoundJudgeResult`, fixture-aware summary |
| F15 | Round-2 scope.files underspecified | Medium | Explicitly: files = full repo file list (same as round 1), diff = `git diff HEAD~1` |
