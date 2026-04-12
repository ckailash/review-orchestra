# LLM-Based Cross-Round Finding Comparison

**Status:** Complete
**Priority:** High — current comparison is non-functional in practice
**Written:** 2026-04-12

---

## Problem

Cross-round finding comparison uses `file + title.toLowerCase()` to match findings
between rounds (see `src/finding-comparison.ts`). In practice this produces zero matches
because LLM reviewers generate completely different titles for the same issue every round.

Examples from dogfooding over 4 rounds — same bug, different titles:
- Round 3: "recovery path discards saved findings when remaining reviewers all fail"
- Round 4: "reviewer errors lost across crash recovery"

The titles, line numbers, categories, and even file attribution vary between rounds.
Deterministic heuristics won't fix this — it's fundamentally a semantic similarity problem.

This makes the multi-round review loop useless: every finding appears "new" every round,
nothing is ever "persisting" or "resolved."

## Design

### Approach

Replace the deterministic `comparisonKey(file + title)` heuristic in `compareFindings()`
with an LLM call that takes summarized descriptions of both rounds' findings and returns
pairwise matches. The LLM judges whether two findings describe the same underlying code
problem, regardless of how each reviewer worded it.

The public API of `finding-comparison.ts` stays the same (`compareFindings` → `ComparisonResult`,
`assignFindingIds` → `AssignedResult`). Both become async. Callers get the same types back.

### Summary format (input to LLM)

Full finding objects are too expensive to send. Each finding is summarized to ~40-60 tokens:

```
[PREV-1] file:src/auth/middleware.ts line:42 cat:security sev:p0
  Issue: userId parameter interpolated directly into SQL query without parameterization
  Fix: Use parameterized queries with $1 placeholders
```

Three lines per finding:
1. **ID + location + metadata** — `[ID] file:<path> line:<N> cat:<category> sev:<p-level>`
2. **Issue essence** — 1 sentence from `description`, NOT `title` (titles are the most
   volatile field — descriptions contain the actual substance)
3. **Fix essence** — 1 sentence from `suggestion`

The description and suggestion are truncated to ~100 chars each to cap per-finding cost.
If either field is very short (<20 chars), include the `title` as supplementary context
on the same line. This handles degenerate inputs where the description or suggestion
alone is too vague for matching.

Previous-round findings are labeled `PREV-1, PREV-2, ...`. Current-round findings are
labeled `CUR-1, CUR-2, ...`. These are temporary IDs for the comparison prompt only —
not exposed to users.

**Why not `P1/C1`?** The project uses `P0-P3` for severity levels throughout. Using `P1`
for "previous finding 1" would collide with "severity P1" in the prompt and confuse the
LLM. `PREV/CUR` prefixes are unambiguous.

### Prompt structure

```
You are comparing code review findings across two review rounds of the same codebase.
Determine which current-round findings match previous-round findings — meaning they
describe the same underlying code problem.

"Same issue" means: same root cause bug or code problem at approximately the same
location, regardless of how the reviewer worded the title or description. Consider:
- Same file or a renamed/moved file with the same issue
- Same logical problem even if line numbers shifted (code was edited between rounds)
- Same category of issue in the same code region

Do NOT match findings that are merely similar in category but describe different
concrete problems (e.g., two different SQL injection bugs in different functions are
NOT the same finding).

Each current finding should match at most one previous finding (pick the best match).
Each previous finding should match at most one current finding.

## Previous round findings:
{previousSummaries}

## Current round findings:
{currentSummaries}

Return JSON only, no explanation:
{
  "matches": [
    {"current": "CUR-1", "previous": "PREV-3"},
    {"current": "CUR-2", "previous": null}
  ]
}

Every current finding must appear exactly once in the matches array.
If a current finding has no match, set "previous" to null.
```

### Output format

```json
{
  "matches": [
    {"current": "CUR-1", "previous": "PREV-3"},
    {"current": "CUR-2", "previous": null},
    {"current": "CUR-3", "previous": "PREV-1"}
  ]
}
```

Each current finding maps to at most one previous finding (or `null` if new).
Unmatched previous findings are "resolved" (present in previous round, absent in current).

### Model choice

**Claude 3.5 Haiku** (`claude-3-5-haiku-latest`).

This is a structured classification/matching task on well-formatted input, not complex
reasoning. Haiku is sufficient and keeps the call fast (~2-5s) and cheap (~$0.003 per
comparison of 20 findings).

Sonnet would be 10x cost and 3x latency with negligible accuracy gain for this task.
Opus is overkill by an order of magnitude.

### Invocation method

**`claude -p` CLI without tools**, via `spawnWithStreaming()`:

```typescript
spawnWithStreaming({
  bin: "claude",
  args: ["-p", "-", "--output-format", "text", "--model", model],
  input: prompt,
  inactivityTimeout: 30_000,
  catastrophicTimeout: 60_000,
});
```

Rationale for CLI over direct API:
- **Zero new dependencies.** The project has zero runtime dependencies (no `node_modules`
  in production). Adding the Anthropic SDK would be the first.
- **Auth reuse.** The CLI handles authentication — no need to discover, read, or manage
  `ANTHROPIC_API_KEY` separately.
- **Consistency.** Reviewers already use `claude -p` via `src/process.ts`. Same spawning
  infrastructure, same error handling patterns, same timeout machinery.

Key differences from reviewer invocation:
- No `--allowedTools` (comparison needs zero tools — text in, text out)
- `--output-format text` (not `json`) to avoid the Claude message envelope. The response
  IS JSON, but we extract it ourselves rather than dealing with the envelope wrapper.
- Model explicitly set to haiku (reviewers use the user's configured model)
- Much shorter timeout: 30s inactivity, 60s catastrophic (vs 10min+ for reviewers)

**Note on preflight:** `src/preflight.ts` only validates binaries for enabled reviewers,
not system-wide. If a user disables the Claude reviewer but uses LLM comparison, preflight
won't catch a missing `claude` binary. The fallback handles this gracefully (spawning fails
→ fallback to heuristic), but implementation step 1 should add a comparison-specific
preflight check when `method === "llm"`: verify `claude` exists on PATH and emit a warning
if not ("LLM finding comparison requires claude CLI; falling back to heuristic matching").

### Fallback behavior

If the LLM call fails for any reason — timeout, non-zero exit, malformed JSON, missing
`matches` array, wrong IDs in matches — fall back to the current deterministic heuristic
(`file + title.toLowerCase()`). The heuristic is imperfect but better than crashing.

Fallback produces a warning on stderr:

```
warning: LLM finding comparison failed (<reason>), falling back to heuristic matching
```

This is consistent with the architecture doc's framing: finding comparison tags are
"presentation aids for user orientation, not policy inputs." Degraded matching is
acceptable; a crash is not.

### Short-circuit: round 1

When `previousFindings` is empty (round 1 or first round of a session), skip the LLM
call entirely. All findings are `new` by definition. No tokens spent.

### Edge cases

**Large finding count (50+):** 50 previous + 50 current = ~5,000 input tokens. Still
cheap and well within context limits. No batching needed unless we hit 100+ per side,
which is unrealistic after consolidation dedup.

**Findings across different files (same issue, file renamed):** The prompt explicitly
instructs the LLM to consider file renames. The description/suggestion content provides
enough signal even when the file path changes.

**One-to-many splits:** If round 1 had one broad finding and round 2 splits it into two
specific findings, the LLM matches the best one and the other appears as "new." This is
acceptable — the user sees one persisting and one new, which accurately reflects what
happened.

**Many-to-one merges:** If round 1 had two related findings and round 2 consolidates
them into one, the LLM matches the best previous finding. The other previous finding
appears as "resolved." Also acceptable.

**LLM matches a finding incorrectly:** The prompt enforces 1:1 matching and the code
validates that returned IDs exist in the input sets. Invalid IDs trigger fallback.

**Pre-existing findings:** Pre-existing findings (tagged `pre_existing: true` by the
consolidator) are included in the comparison like any other finding. A pre-existing
finding that was also pre-existing in the previous round should match as "persisting."
The LLM doesn't need to know about pre-existing status — it's irrelevant to whether two
findings describe the same issue.

**Same file, similar issues at different lines:** Two distinct SQL injection bugs in the
same file at lines 42 and 87 could produce similar summaries. The `line:N` field and the
specific description content (which function, which variable) provide disambiguation
signal. The prompt's "same root cause bug or code problem at approximately the same
location" instruction handles this — different functions at different lines are different
findings even if the category is the same.

**Crash recovery during LLM comparison:** Phase 3 runs after `saveConsolidated()` while
the round phase is still `"consolidating"`. If the process crashes during the LLM call:
- On recovery, phase = `"consolidating"`, consolidated data exists on disk
- Recovery re-runs consolidation (idempotent), then re-runs Phase 3 (the LLM comparison)
- This works because consolidation is idempotent and Phase 3 runs unconditionally after
  all three recovery branches converge
- No new phase state needed. The LLM call is ~2-5s — a narrow crash window. The cost of
  re-running it is negligible.

**`assignFindingIds` backward compatibility:** The function gains a 4th parameter
(`config`). For backward compatibility with existing tests and callers, make it optional
with a default that uses heuristic matching:
`async assignFindingIds(current, previous, round, config?)`. When `config` is undefined,
use heuristic. This keeps existing tests working without modification until they're
explicitly updated to test the LLM path.

## Integration point

### Where in the pipeline

`src/orchestrator.ts`, lines 105-115 — Phase 3 (after consolidation, before building
`ReviewResult`). This code runs once, outside all the crash-recovery `if/else` branches:

```typescript
// Phase 3: Finding comparison — assign IDs and statuses
const previousRound = this.state.getPreviousRound();
const previousFindings = previousRound?.consolidated ?? [];
const currentConsolidated = this.state.getCurrentRound()?.consolidated ?? [];
const { findings: comparedFindings, resolvedFindings } =
  assignFindingIds(currentConsolidated, previousFindings, round.number);
```

Change: `assignFindingIds` becomes async. The call becomes:

```typescript
const { findings: comparedFindings, resolvedFindings } =
  await assignFindingIds(currentConsolidated, previousFindings, round.number, this.config);
```

Config is threaded through for model/timeout settings.

### What changes in finding-comparison.ts

1. `compareFindings()` → `async compareFindings()`. Internally:
   - If `previousFindings.length === 0`, short-circuit (no LLM call)
   - Build summary strings from both finding arrays
   - Construct prompt
   - Spawn `claude -p` via `spawnWithStreaming()` with haiku + short timeouts
   - Parse JSON response, validate structure
   - Convert matches into `ComparisonResult` (newFindings, persistingFindings, resolvedFindings)
   - On any failure: log warning, fall back to current `comparisonKey()` heuristic

2. `assignFindingIds()` → `async assignFindingIds()`. Just awaits `compareFindings()`.

3. New helper: `summarizeFinding(finding: Finding, label: string): string` — pure function
   that produces the 3-line summary format.

4. New helper: `buildComparisonPrompt(previousSummaries: string, currentSummaries: string): string`

5. Old `comparisonKey()` function is KEPT as the fallback path — not deleted.

### What does NOT change

- `consolidate()` in `src/consolidator.ts` — deterministic dedup/P-level/pre-existing stays as-is
- `Finding` type — `status` field already exists as `"new" | "persisting"`
- `ReviewResult` type — no structural changes
- `ComparisonResult` / `AssignedResult` interfaces — same shape, just produced differently
- CLI (`src/cli.ts`) — no changes needed
- SKILL.md — no changes needed (already consumes `status` and `resolvedFindings`)

## Token budget estimate

For a typical comparison with 20 findings per round:

| Component | Tokens |
|-----------|--------|
| System prompt + instructions | ~350 |
| 20 previous findings × ~50 tokens | ~1,000 |
| 20 current findings × ~50 tokens | ~1,000 |
| Expected output (20 match entries) | ~300 |
| **Total** | **~2,650** |

Cost at Haiku pricing ($0.80/M input, $4/M output):
- Input: ~2,350 × $0.80/M = $0.002
- Output: ~300 × $4/M = $0.001
- **Total: ~$0.003 per comparison**

This runs once per round (after consolidation). Even with 5 rounds, total comparison cost
is ~$0.015 — negligible.

At 50 findings per round (stress case): ~5,500 total tokens, ~$0.006.

## Configuration

New section in `config/default.json`:

```json
{
  "findingComparison": {
    "method": "llm",
    "model": "claude-3-5-haiku-latest",
    "timeoutMs": 30000,
    "fallback": "heuristic"
  }
}
```

New type in `src/types.ts`:

```typescript
export interface FindingComparisonConfig {
  method: "llm" | "heuristic";
  model: string;
  timeoutMs: number;
  fallback: "heuristic" | "error";
}
```

Added to `Config` as optional with a code-level default:

```typescript
export interface Config {
  reviewers: Record<string, ReviewerConfig>;
  thresholds: ThresholdConfig;
  findingComparison?: FindingComparisonConfig;
}
```

The field is optional on the `Config` interface so existing configs without
`findingComparison` don't break. `DEFAULT_CONFIG` in `src/config.ts` provides the default.

**Config loading changes required:** `loadBaseConfig()` currently constructs its return
value with only `reviewers` and `thresholds` — it will silently drop `findingComparison`
from the JSON. Similarly, `loadConfig()`'s `overrides` parameter type only accepts
`reviewers` and `thresholds`. Both must be updated:
- `loadBaseConfig()`: add `findingComparison` to the constructed return object with
  `{ ...DEFAULT_FINDING_COMPARISON_CONFIG, ...parsed.findingComparison }`
- `loadConfig()` overrides type: add `findingComparison?: Partial<FindingComparisonConfig>`
- `DEFAULT_CONFIG`: add `findingComparison` with the defaults above

This follows the existing merge pattern used for `thresholds`.

- `method: "heuristic"` disables the LLM call entirely — useful for testing, CI, or
  environments without claude CLI.
- `fallback: "error"` makes LLM failures fatal instead of falling back — useful for
  debugging the comparison prompt during development.

## Implementation order

1. **Add `FindingComparisonConfig` to types and config** — New type in `src/types.ts`,
   `DEFAULT_FINDING_COMPARISON_CONFIG` constant, update `loadBaseConfig()` to include the
   new section, update `loadConfig()` overrides type, add to `config/default.json`. Also
   add comparison-specific preflight: when `method === "llm"`, verify `claude` binary
   exists on PATH (separate from reviewer preflight). TDD.

2. **Add `summarizeFinding()` helper** — Pure function, easy to test. Truncates description
   and suggestion, formats the 3-line summary. TDD.

3. **Add `buildComparisonPrompt()` helper** — Pure function, assembles the full prompt from
   summary strings. TDD.

4. **Add LLM invocation + response parsing** — New function `compareFindingsViaLLM()` that
   spawns `claude -p`, parses response, validates structure. Returns matched pairs or throws.
   Test-after (LLM-facing).

5. **Rewrite `compareFindings()` to be async** — Dispatches to `compareFindingsViaLLM()`
   when `config.findingComparison.method === "llm"`, falls back to old heuristic on failure
   or when method is `"heuristic"`. Thread config through. Old heuristic code kept as-is
   inside a `compareFindingsHeuristic()` function.

6. **Make `assignFindingIds()` async** — Trivial change, just awaits `compareFindings()`.

7. **Update `orchestrator.ts`** — Await `assignFindingIds()`, pass config through.

8. **Update tests** — Mock `spawnWithStreaming` for unit tests of the new comparison path.
   Add integration test with a real LLM call (test-after). Update existing
   `test/finding-comparison.test.ts` tests to handle async.

9. **Update eval harness** — Add a finding comparison accuracy eval dimension: known finding
   pairs with different titles, verify matching correctness.

10. **Update docs** — architecture.md and supervised-flow.md (see below).

## Testing strategy

### Unit tests (TDD — deterministic components)

In `test/finding-comparison.test.ts`:

| Test | What it verifies |
|------|-----------------|
| `summarizeFinding` produces correct 3-line format | Summary format, truncation at char limit |
| `summarizeFinding` handles missing optional fields | No `expected`/`observed`/`evidence` doesn't crash |
| `buildComparisonPrompt` assembles valid prompt | Previous/current sections present, JSON format instruction present |
| `buildComparisonPrompt` with 0 previous findings | Should not be called (short-circuit), but doesn't crash |
| `compareFindings` short-circuits on round 1 | No LLM call when previousFindings is empty |
| `compareFindings` with `method: "heuristic"` | Uses old heuristic, no LLM call |
| `compareFindings` falls back on LLM error | Mock LLM to throw, verify heuristic result returned + warning logged |
| `compareFindings` falls back on malformed JSON | Mock LLM to return garbage, verify heuristic fallback |
| `compareFindings` falls back on invalid match IDs | Mock LLM to return IDs not in input set, verify fallback |
| `compareFindings` with `fallback: "error"` | Mock LLM to throw, verify error propagates (no fallback) |
| `summarizeFinding` handles minimal description/suggestion | Short fields (<20 chars) get title appended as supplementary context |
| `assignFindingIds` without config (backward compat) | No config → uses heuristic, no LLM call |
| All existing tests still pass (async) | Existing test cases for heuristic behavior unchanged |

### Integration tests (test-after — LLM-facing)

| Test | What it verifies |
|------|-----------------|
| LLM correctly matches findings with different titles | Same bug, different wording → "persisting" |
| LLM correctly identifies genuinely new findings | Different bug → "new" |
| LLM handles file renames | Same issue, different file path → "persisting" |
| End-to-end through `assignFindingIds` | Full path: summarize → prompt → LLM → parse → assign IDs |

### Eval extension

Add to `evals/`:
- Finding pairs dataset: pairs of findings with ground-truth same/different labels
- Include adversarial cases: same title different issue, different title same issue, file renames, line number drift
- Score: precision and recall of matching

This extends the existing eval dimension mentioned in architecture.md: "Finding comparison
accuracy (multi-round): Are new/persisting/resolved tags correct across rounds?"

## Changes to architecture.md

Update the "Decisions Made" table entry for "Finding comparison":

**Before:**
```
| Finding comparison | File + title matching across rounds | Tags current findings as new/persisting; ... Best-effort heuristic — presentation aid, not policy input. |
```

**After:**
```
| Finding comparison | LLM-based semantic matching (haiku), heuristic fallback | LLM judges whether findings describe the same underlying issue across rounds, regardless of title wording. Falls back to file + title heuristic on LLM failure. Configurable via `findingComparison` config. Still a presentation aid, not policy input. |
```

Update the "Phase 3: Consolidation" description to mention the LLM comparison step
(currently says "Compares against previous round's findings" without specifying the
mechanism beyond dedup).

Update the "Matching heuristic" paragraph (currently documents the `file + title.toLowerCase()`
approach) to describe the LLM-based approach and the fallback.

## Changes to supervised-flow.md

Update the "Finding comparison across rounds" section (currently at the end of the
"Session persistence" subsection). Replace the paragraph about `file + title.toLowerCase()`
and its known limitations:

**Before:**
```
Matching heuristic: normalize `file + title.toLowerCase()`. This is best-effort — it will
misclassify if a reviewer changes a title's wording between rounds, ...
```

**After:**
```
Matching method: LLM-based semantic comparison via claude-3-5-haiku. The CLI summarizes
each finding (file, line, category, issue description, fix) and asks the LLM to determine
which current findings match previous findings based on the underlying code problem, not
surface wording. Falls back to `file + title.toLowerCase()` heuristic if the LLM call
fails. Configurable via `findingComparison` config (can force heuristic-only mode).

The LLM comparison is called once per round, after consolidation. Token cost is ~2,500
tokens per comparison (20 findings/side), taking ~2-5s on haiku.

Known limitation: the matching is still best-effort. The `[new]`/`[persisting]` tags are
presentation aids for user orientation, not policy inputs.
```

Remove the "Known limitations" bullet list about title rewording, file moves, and
duplicate titles — these are addressed by the LLM approach (though not perfectly, the
failure modes are different and less systematic).

Update the "Testing strategy" section's "Finding comparison" row to reflect LLM-based
testing approach.
