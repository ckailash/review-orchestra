# Finding Quality Enhancement — Feature Plan

**Status:** Complete
**Priority:** Phase A — prerequisite for supervised flow SKILL.md rewrite
**Written:** 2026-03-30

---

## Problem

Findings today have `title`, `description`, `suggestion`. This is sufficient for simple bugs but produces vague, hard-to-act-on reviews for anything nuanced. Two recurring failure modes from dogfooding:

1. **"What should it be?"** — A finding says something is wrong but doesn't articulate the desired state. The fixer (human or orchestrator) has to guess intent. Example: "Error handling is insufficient in processPayment" — insufficient compared to what? What would sufficient look like?

2. **"Says who?"** — A finding makes a claim with no supporting evidence. Especially bad for `speculative` confidence findings that look authoritative in the output. The user can't distinguish a substantiated concern from an LLM hallucination without reading the code themselves.

Additionally, reviewers have no visibility into the developer's intent. They review code in isolation — they can catch mechanical bugs but miss cases where the code works correctly yet contradicts what the developer was trying to do. Commit messages carry intent signal that we discard.

Finally, the fixer (the orchestrator in supervised mode) has no explicit guardrails against common overcorrection patterns: weakening tests to make findings go away, adding features beyond the finding scope, refactoring unrelated code.

## Design

### 1. Expected/Observed framing on findings

Add two optional string fields to `Finding`:

- `expected` — What should the code do? The desired state, correct behavior, or standard being violated.
- `observed` — What does the code actually do? The specific behavior or pattern that constitutes the issue.

These complement the existing `description` and `suggestion` fields. The relationship:

| Field | Purpose | Example |
|-------|---------|---------|
| `title` | One-line summary (for dedup, display) | "SQL injection in getUser" |
| `expected` | Desired state | "Database queries use parameterized inputs ($1 placeholders) for all user-provided values" |
| `observed` | Actual state | "userId is interpolated directly into the SQL query string via template literal" |
| `description` | Context, explanation, impact | "The userId parameter comes from the request URL and is attacker-controlled. This allows arbitrary SQL execution." |
| `suggestion` | How to fix | "Use parameterized queries: `db.query('SELECT * FROM users WHERE id = $1', [userId])`" |

**Decision: optional, not required.** The review prompt recommends expected/observed but does not mandate them. Rationale:
- Style nitpicks and naming issues often don't have a meaningful "expected" state beyond "a better name"
- Forcing the fields on every finding would produce filler text that degrades signal
- Reviewers that produce expected/observed naturally get higher quality scores — the incentive is built in

**Decision: `description` stays.** Not replaced by expected/observed. Description carries context and impact explanation that doesn't fit either expected or observed. A finding can have all four fields populated, or just description + suggestion (backward compatible with current findings).

### 2. Evidence field

Add an optional `evidence: string[]` field to `Finding`. Each entry is a free-form string: a code snippet, a command output, a trace, a reference to a spec, or a logical argument.

Evidence lets reviewers "show their work." It's particularly valuable for:
- `verified` confidence findings (evidence IS the verification)
- Security issues (show the attack vector)
- Logic bugs (show the failing case)

**Decision: free-form string array.** Not structured sub-fields like `commands_run`, `tracebacks`, `references`. Structured evidence types add schema complexity for marginal gain — the consumer (human or fixer LLM) can read free-form text just fine.

**Decision: not mandated.** Some findings (style nits, naming) don't benefit from evidence. The review prompt encourages evidence for P0/P1 findings specifically.

### 3. Design intent context via commit messages

Add recent commit messages to the review prompt so reviewers can detect code that works correctly but mismatches the developer's stated intent.

The `buildReviewPrompt()` function in `src/reviewers/prompt.ts` currently appends scope description and file list to the base prompt. It will additionally include commit messages from the current scope:
- For `branch` scope: `git log --oneline ${baseBranch}..HEAD` (commits on the branch, using the detected default branch — not hardcoded `main`)
- For `uncommitted` scope: `git log --oneline -10 HEAD` (last 10 commits for context; wrapped in try/catch for fresh repos with no commits)
- For `commit` scope: `git log --oneline ${from}${separator}${to}` (preserves the user's original `..` vs `...` range from `normalizeRefRange()` so commit intent matches the diff range)
- For `pr` scope: deferred — `detectScope()` does not produce this scope type yet

This is passed as a new `commitMessages?: string` field on `DiffScope`, populated during scope detection when available (undefined on fresh repos or when git log fails). `buildReviewPrompt` includes it in the prompt under a "## Recent Commits (developer intent)" section.

**Decision: add `design_intent` as a suggested review category.** The review prompt's category list gets `design_intent` alongside the existing `security`, `logic`, `performance`, etc. This signals to reviewers that intent-mismatch is a valid finding type.

### 4. Fix guardrails in SKILL.md

Add a new "## Step 3: Fixing Guidelines" section to `skill/SKILL.md` (after existing Step 2) with explicit anti-patterns:

- "Do not weaken or delete existing tests to resolve a finding. If a finding says a test is wrong, verify the test's intent before modifying it."
- "Do not add new features, abstractions, or utilities beyond what is needed to fix the specific finding."
- "Do not refactor code that is not directly part of the finding. Stay surgical."
- "If a fix requires changing the public API or type signatures, escalate rather than proceeding."

In supervised mode, the orchestrator Claude IS the fixer, so `skill/SKILL.md` is the correct surface for these guardrails. `prompts/fix.md` still exists on disk (used by auto-mode fixer) but is not used in supervised mode. Its deletion is tracked separately with the broader auto-mode cleanup — out of scope for this plan.

### Dedup impact

**Decision: dedup key unchanged.** The consolidator's dedup key stays as `file:line:title.toLowerCase()`. The new fields are not part of the dedup key. Rationale:
- Two reviewers finding the same issue at the same file/line/title should still dedup even if one provides expected/observed and the other doesn't
- Changing the dedup key risks breaking the consolidator's existing behavior for no clear gain

### Consolidator merge behavior for new fields

When dedup selects one finding over another, the winning finding's fields are used as-is. No field-level merging across duplicates. Rationale:
- Merging `expected` from reviewer A with `observed` from reviewer B would produce Frankenstein findings
- Keeps the consolidator simple and deterministic

**Tie-breaking on equal severity:** The current consolidator keeps the first finding when severities are equal. This means a later finding with richer optional fields (expected/observed/evidence) can be silently dropped. To address this, the consolidator will add a tie-breaker: when severities are equal, prefer the finding with more populated optional fields (`expected`, `observed`, `evidence`). This is a minor, backward-compatible change to the dedup comparator — the dedup key and merge strategy are unchanged.

## Implementation Order

1. **Architecture.md** — Update the source of truth first (before code changes):
   - Findings schema example to show new optional fields (`expected`, `observed`, `evidence`)
   - `DiffScope` definition to show `commitMessages`
   - Decisions table with rows for: finding framing, evidence, design intent context, fix guardrails
   - Scope: new field documentation only. Auto-mode cleanup is a separate task.

2. **Types** — Add `expected?`, `observed?`, `evidence?` to `Finding` in `src/types.ts`. Add `commitMessages?` to `DiffScope`.

3. **Schema** — Add optional `expected`, `observed` (string), `evidence` (string[]) to `schemas/findings.schema.json`.

4. **Reviewer parser tests (TDD)** — Write failing tests for:
   - Finding with expected/observed/evidence fields passes through correctly
   - Finding without new fields still parses (backward compat)
   - Evidence as non-array (string, null) is normalized to `undefined`
   - Expected/observed as non-string is normalized to `undefined`

5. **Reviewer parser** — Update `normalizeFinding()` in `src/reviewer-parser.ts` to handle new optional fields. Pass through when present and valid, omit when absent or wrong type.

6. **Scope detection** — Update `src/scope.ts` to populate `commitMessages` on `DiffScope` during scope detection. Use `git log --oneline` with appropriate range per scope type:
   - `branch` scope: `git log --oneline ${baseBranch}..HEAD` (uses `detectDefaultBranch()`, not hardcoded `main`)
   - `uncommitted` scope: `git log --oneline -10 HEAD` (wrap in try/catch — fails on fresh repos with no commits, same pattern as the existing `git diff HEAD` guard)
   - `commit` scope: `git log --oneline ${from}${separator}${to}` (preserves the user's original `..` vs `...` range from `normalizeRefRange()` so commit intent matches the diff being reviewed)
   - `pr` scope: deferred — `detectScope()` does not produce this scope type yet
   - Path filtering does not narrow commit history. Commit messages reflect full-branch developer intent regardless of which files are scoped for review.

7. **Review prompt** — Restructure `prompts/review.md`:
   - Update output format to show expected/observed/evidence as optional fields
   - Add guidance: "For P0/P1 findings, include expected and observed fields. For lower severity, these are optional."
   - Add guidance: "Include evidence (code snippets, traces, logical arguments) when it strengthens the finding."
   - Add `design_intent` to the category list with description
   - Add a "Recent Commits" section placeholder that `buildReviewPrompt` will populate

8. **Prompt builder** — Update `buildReviewPrompt()` in `src/reviewers/prompt.ts` to include commit messages from `scope.commitMessages` when available.

9. **Fix guardrails in SKILL.md** — Add a new "## Step 3: Fixing Guidelines" section to `skill/SKILL.md` (after existing Step 2) with guardrail anti-patterns. This adds a section — it does not rewrite SKILL.md's structure. The Phase B supervised-flow plan rewrites SKILL.md for presentation; it must preserve these guardrails. Note: `prompts/fix.md` still exists on disk but is unused in supervised mode. Its deletion is out of scope for this plan (tracked separately with auto-mode cleanup).

## What This Does NOT Change

- **Consolidator dedup key** — Key stays as file:line:title. No field-level merging. (Minor change: tie-breaker added for equal severity — see Dedup impact section.)
- **P-level computation** — Severity still derived from confidence x impact. New fields don't affect it.
- **Finding IDs** — Still round-scoped (`r1-f-001`). No change.
- **Pre-existing tagging** — Still based on diff hunk check. No change.
- **Finding comparison across rounds** — Still file + title matching. New fields not used for matching.
- **Reviewer implementations** (`claude.ts`, `codex.ts`) — No changes to how reviewers are invoked. They get the updated prompt via `buildReviewPrompt` and the updated base prompt from `prompts/review.md`, but the reviewer adapter code itself is unchanged.
- **State management** — `SessionState`, round tracking, worktree hashing — all untouched.
- **CLI interface** — No new subcommands, no argument changes.
- **SKILL.md structure** — Not rewritten here. This plan adds a "Step 3: Fixing Guidelines" section with guardrail anti-patterns. The supervised flow plan (Phase B) rewrites SKILL.md's overall structure for finding presentation — Phase B must preserve the guardrails added here.

## Testing Strategy

### TDD (reviewer-parser) — Step 3 above

New test cases in `test/reviewer-parser.test.ts`:

| Test | What it verifies |
|------|-----------------|
| Parses finding with expected/observed/evidence | All three optional fields preserved on output |
| Parses finding without new fields (backward compat) | Existing findings still parse identically — no regression |
| Expected/observed as non-string normalized | `expected: 42` or `expected: null` results in `undefined` on the Finding |
| Evidence as non-array normalized | `evidence: "single string"` or `evidence: null` results in `undefined` |
| Evidence with mixed types in array | `evidence: ["valid", 42, null]` filters to valid strings only |
| Finding with expected but no observed | Partial population is fine — fields are independent |

### Consolidator (existing tests, verify no regression)

Run existing `test/consolidator.test.ts` — dedup key behavior must not change. Add tests:
- Two findings with identical file:line:title but different expected/observed values still dedup correctly (higher severity wins, its fields preserved)
- Two findings with identical file:line:title and equal severity: the finding with more populated optional fields (expected/observed/evidence) wins the tie-break

### Scope detection (commit messages)

Add tests in `test/scope.test.ts`:
- Scope detection populates `commitMessages` string. Mock `git log` output, verify it appears on the `DiffScope` object.
- Fresh repo with no commits: `git log -10 HEAD` fails, `commitMessages` is `undefined` (not an error). Verify scope detection still succeeds with the remaining fields populated.

### Prompt builder

Add test: `buildReviewPrompt` includes commit messages section when `scope.commitMessages` is populated. Verify it's omitted when `commitMessages` is empty/undefined.

### Integration (manual)

After implementation, run `review-orchestra review` on a real codebase and verify:
- At least some findings have expected/observed populated
- Evidence appears on higher-confidence findings
- Commit messages visible in the reviewer prompt (check `.review-orchestra/round-1/` artifacts)
- Findings without new fields still consolidate and display correctly

## File-Level Changes Summary

| File | Change |
|------|--------|
| `src/types.ts` | Add `expected?`, `observed?`, `evidence?` to `Finding`. Add `commitMessages?` to `DiffScope`. |
| `schemas/findings.schema.json` | Add optional `expected` (string), `observed` (string), `evidence` (string array) to finding item properties. |
| `src/reviewer-parser.ts` | Update `normalizeFinding()` to pass through new optional fields with type validation. |
| `test/reviewer-parser.test.ts` | Add 6 new test cases per testing strategy above. |
| `src/scope.ts` | Populate `commitMessages` on `DiffScope` during scope detection using `git log`. |
| `test/scope.test.ts` | Add test for `commitMessages` population. |
| `src/reviewers/prompt.ts` | Update `buildReviewPrompt()` to include commit messages section. |
| `prompts/review.md` | Add expected/observed/evidence to output format. Add guidance on when to use them. Add `design_intent` category. Add commit context section placeholder. |
| `skill/SKILL.md` | Add "Step 3: Fixing Guidelines" section with four guardrail anti-patterns. |
| `src/consolidator.ts` | Add tie-breaker: on equal severity, prefer finding with more populated optional fields. |
| `test/consolidator.test.ts` | Add tests: dedup preserves winning finding's new fields; equal-severity tie-breaker prefers richer finding. |
| `docs/plans/architecture.md` | Update findings schema example, add decisions table rows. |
