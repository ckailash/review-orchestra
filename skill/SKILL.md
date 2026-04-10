---
name: review-orchestra
description: Multi-model code review orchestration — runs Claude + Codex reviewers in parallel, consolidates findings, and returns results for supervised fixing.
argument-hint: "[paths...] [options in plain english]"
---

# Review Orchestra

You orchestrate multi-model code review. You are the fixer and presenter, but NOT a reviewer — fresh reviewer instances review the code independently.

## Step 1: Review

Run the CLI to get consolidated findings from fresh reviewers:

```bash
review-orchestra review $ARGUMENTS
```

The CLI accepts natural language arguments:
- **Paths**: `src/auth/ src/api/` — only review these directories
- **Threshold**: `fix quality issues too` → extends to P2; `fix everything` → P3
- **Reviewer selection**: `only use claude`, `skip codex`
- **Model selection**: `use opus for claude`, `use o3 for codex`
- **Git ref**: `HEAD~3` — review changes since a specific commit
- **Dry run**: `dry run` — shows what would happen without running reviews
- No arguments = all defaults (auto-detect scope, both reviewers, stop at P1)

Status updates are printed to stderr. The final `ReviewResult` JSON is printed to stdout.

## Step 2: Present findings

Parse the `ReviewResult` JSON from stdout. Use progressive disclosure based on volume:

**If ≤15 findings:** show full detail inline, grouped by severity (P0 first).

**If >15 findings:** show a severity summary table first, then detail for P0/P1 only. Offer to expand P2/P3 on request.

For each finding, show:
- **ID** (round-scoped, e.g. `r1-f-001`), **severity**, **title**
- **File:line**, description, suggestion
- Which **reviewer(s)** found it
- Tag: **[new]** or **[persisting]** (compared to previous round, if any)

Separate **pre-existing findings** under their own heading — these are issues in unchanged code, shown for awareness but not part of the current diff.

If this is **round 2+**, also show resolved findings (from the `resolvedFindings` array in the ReviewResult): "N findings from round X resolved." List titles briefly — no need for full detail on resolved items.

## Step 3: User decides

Ask the user what to fix. Recognized intents:

- `"fix all"` — fix ALL findings regardless of severity
- `"fix critical"` / `"fix P0/P1"` — fix only P0 and P1 findings
- `"fix r1-f-001, r1-f-003"` — fix specific findings by ID
- `"skip r1-f-002"` — mark as skipped (false positive, intentional, etc.)
- `"fix all and re-review"` — fix all then automatically re-review

**Ambiguity handling:** If the user's intent is unclear, do NOT guess. Ask a clarifying question. Examples:
- `"fix the important stuff"` → "Do you mean fix all P0/P1 findings, or something else?"
- `"looks good"` → "Would you like me to fix these findings, or are you saying the code looks good and we're done?"
- `"leave tests alone"` → "Got it — I'll skip any findings in test files. Fix all remaining findings?"

**Pre-existing findings:** If the user explicitly requests fixing a pre-existing finding (e.g., `"fix r1-f-012"` where `r1-f-012` is tagged pre-existing), allow it — the user knows best. Note that it was pre-existing but proceed with the fix.

## Step 4: Confirm before editing

Before making any edits, echo back a summary of planned actions:
- List the finding IDs you will fix
- List any you will skip and why
- State the total number of files to be edited

Wait for user confirmation. This prevents silent policy decisions.

## Step 5: Fix

Fix the approved findings directly using your Edit/Write tools. You wrote this code — use your context to make accurate fixes.

### Fixing Guidelines

Follow these guardrails to avoid common overcorrection patterns:

1. Do not weaken or delete existing tests to resolve a finding. If a finding says a test is wrong, verify the test's intent before modifying it.
2. Do not add new features, abstractions, or utilities beyond what is needed to fix the specific finding.
3. Do not refactor code that is not directly part of the finding. Stay surgical.
4. If a fix requires changing the public API or type signatures, escalate rather than proceeding.

### Stale-finding check

Before editing, run:

```bash
review-orchestra stale
```

- **Exit 0** → fresh, proceed with fixes.
- **Exit 1** → stale (worktree changed since last review). Warn the user and recommend re-reviewing first. Proceed only if the user confirms.
- **Exit 2** → no active session. This shouldn't happen mid-flow; if it does, re-run `review-orchestra review` to start a new session.

### Partial failure handling

If an edit fails (file moved, merge conflict, unexpected content), do not silently skip it. Report the failure to the user immediately with the finding ID and reason, then continue with remaining fixes. After all fixes, summarize: N fixed, M failed (with IDs and reasons).

## Step 6: Re-review

**Default behavior:** After fixing, always ask "Want me to re-review?" Do not re-review automatically unless the user explicitly said "fix and re-review" in Step 3.

If re-reviewing, run `review-orchestra review` again. The CLI auto-continues the session (increments round, preserves history). Present new findings with [new]/[persisting] tags, and list resolved findings separately. Repeat from Step 2.

## Step 7: Done

When the user is satisfied (or reviewers find no issues):
- Summarize the session: rounds completed, findings fixed, findings skipped, findings remaining
- Suggest next action based on repo state (commit, push, create PR)

## Error handling

If the CLI exits with a non-zero code, read stderr and present the error. Common issues:
- "No changes detected" — nothing to review
- "Diff is too large" — suggest narrowing scope with paths
- Preflight failures — missing CLI tools (claude, codex)
