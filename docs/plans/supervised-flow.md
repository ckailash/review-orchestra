# Supervised Flow — Feature Plan

**Status:** Complete
**Priority:** Next — before learnings
**Written:** 2026-03-15
**Updated:** 2026-04-07 — folded checkpointing plan into step 3 (crash recovery subsection); previous: uplifted after consolidated review (Claude + Codex): completed deletion inventory, resolved finding ID scheme, expanded session model scope, merged steps 2+3 into atomic migration, acknowledged architecture.md rewrite scope

---

## Problem

The current architecture runs the entire review→fix→re-review loop as one long CLI call. The user gets no say between review and fix. The fixer makes autonomous decisions that are often wrong (fixing eval fixtures, adding unwanted abstractions, escalating 17 findings at once). The orchestrator Claude — the one that wrote the code — is also the one consolidating, which is fine, but it has no ability to interact with the user mid-loop.

In practice, the user's manual workflow is better:
1. Open a fresh Claude to review (not the one that wrote the code)
2. Wait for Codex to finish separately
3. Ask the reviewing Claude to consolidate both sets of findings
4. Decide what to fix
5. Have the code-writing Claude fix it (it has the most context on intent)

The tool should match this workflow, not fight it.

## Design

### Role separation

| Role | Who | Why |
|------|-----|-----|
| **Reviewer (Claude)** | Fresh headless `claude -p` | Fresh eyes — no context of the code-writing session |
| **Reviewer (Codex)** | Fresh headless `codex exec` | Different model, different perspective |
| **Consolidator** | CLI (deterministic code) | Dedup, P-level, pre-existing tagging — no LLM needed. Orchestrator just presents the results. |
| **Fixer** | Orchestrator Claude | Wrote the code, knows intent, can fix accurately. User guides decisions. |

The orchestrator is NOT a reviewer. It wrote the code — it's the worst reviewer of its own work. But it's the best fixer because it has full context.

### CLI becomes a review + consolidation launcher

The CLI does one thing: spawn reviewers, consolidate findings, and return results.

```bash
# Run all enabled reviewers, consolidate, return findings JSON
review-orchestra review

# With scope options (natural language, same as today)
review-orchestra review HEAD~3
review-orchestra review src/services/
review-orchestra review only claude
review-orchestra review skip codex
```

Arguments remain natural language — no `--flags`. The existing `parseArgs()` already handles "only claude", "skip codex", etc. No change to the argument contract.

Output: consolidated findings JSON on stdout, progress on stderr (same as today).

No fix command. No autonomous loop. The auto mode code is deleted, not gated.

### Consolidation stays in the CLI

Consolidation is deterministic code (dedup, P-level computation, pre-existing tagging). No reason to make the LLM do it. `review-orchestra review` runs reviewers *and* consolidation, then returns a single consolidated findings JSON. The skill just presents the results.

The SKILL.md instructs the orchestrator to:
1. Run `review-orchestra review` (which internally runs reviewers + consolidation)
2. Parse the consolidated findings JSON
3. Present to the user in a readable format

### Session persistence across invocations

The supervised loop calls `review-orchestra review` multiple times (initial review, re-reviews after fixes). The CLI needs to track state across these invocations so that:
- Round artifacts are preserved (`.review-orchestra/round-N/`)
- Finding IDs are unique per finding (each finding gets one stable ID for its lifetime; the round prefix indicates when it was first detected, not which round it belongs to)
- Stale findings can be detected (files changed since last review)
- Previous findings can be compared to new findings (new/resolved tracking)

**Design: session-based state with worktree snapshots.**

The first `review-orchestra review` invocation creates a session:
- Generates a session ID (timestamp-based, e.g. `20260315-143022`)
- Creates `.review-orchestra/` with `session.json`
- Computes and stores a `worktreeHash` snapshot (see definition below)
- Writes round-1 artifacts

Subsequent invocations detect the existing session:
- If `.review-orchestra/session.json` exists and status is `active`, continue the session
- Increment round number, write new round artifacts
- Compute a new worktree hash and store it with the round

Session continuation is automatic (auto-detection is the default). No explicit session flags needed — the CLI detects an existing `.review-orchestra/session.json` and continues it.

**Session state structure:**

```json
{
  "sessionId": "20260315-143022",
  "status": "active",
  "scope": { "type": "branch", "base": "main", "diff": "..." },
  "currentRound": 2,
  "worktreeHash": "abc123",
  "rounds": [
    {
      "number": 1,
      "worktreeHash": "def456",
      "findings": [ ... ],
      "startedAt": "2026-03-15T14:30:22Z"
    },
    {
      "number": 2,
      "worktreeHash": "abc123",
      "findings": [ ... ],
      "startedAt": "2026-03-15T14:35:10Z"
    }
  ],
  "startedAt": "2026-03-15T14:30:22Z"
}
```

**Session lifecycle:**
- `review-orchestra review` → creates or continues session, runs reviewers + consolidation, returns findings
- `review-orchestra reset` → clears the session (equivalent to `rm -rf .review-orchestra/`)
- Session auto-expires if the scope base changes (e.g., new commits on main) — stale session warning, user must reset (`review-orchestra reset`) and start a new session. No force-continue: if the scope base changed, old findings are unreliable and continuing the session would produce misleading new/persisting/resolved tags

**`worktreeHash` definition:** The hash must capture *all* file state the reviewers will see. It is a single SHA-256 over three components concatenated in order:

1. **HEAD commit** — `git rev-parse HEAD`
2. **Staged + unstaged changes** — `git diff HEAD` (covers both index and working tree vs HEAD)
3. **Untracked files** — each untracked file contributes its **path and content** to the hash input. This is not a single git command — the implementation must list untracked files (`git ls-files -z --others --exclude-standard`), sort them, then for each file feed `"path\0content\0"` into the running hash. Path inclusion is required so that renaming or swapping untracked files changes the hash.

The implementation owns the exact shell/Node construction. The requirement is:
- Null-safe: handles filenames with spaces, newlines, and special characters
- Deterministic: same file state always produces the same hash
- Path-sensitive: renaming an untracked file (same content, different path) changes the hash
- Complete: if any of HEAD, staged, unstaged, or untracked state changes, the hash changes

**Finding IDs are round-scoped for new findings only.** New findings in round N get the prefix `rN-f-` (e.g. `r1-f-001`, `r2-f-003`). This prevents collisions when the user says "fix r1-f-003" after a re-review has generated its own findings.

**Persisting findings keep their original ID.** If `r1-f-007` is still present in round 2, it appears in round 2's results as `r1-f-007 [persisting]` — not as `r2-f-002`. The user shouldn't have to learn a new ID for the same finding. This means:
- A finding's ID is stable for its entire lifetime across rounds
- The round prefix tells you *when the finding was first detected*, not which round you're looking at
- The user can always say "fix r1-f-007" regardless of which round they're in

**Finding comparison across rounds:** The CLI compares the current round's findings against the previous round's findings and tags each:
- `new` — in current round but not in previous → gets a new round-N ID
- `persisting` — in both current and previous → keeps its original ID from the round it first appeared
- (Resolved findings — in previous but not current — are reported in a separate `resolvedFindings` array in the `ReviewResult`, not as entries in the main findings list)

Matching heuristic: normalize `file + title.toLowerCase()`. This is best-effort — it will misclassify if a reviewer changes a title's wording between rounds, or if two findings in the same file share a title. Known limitations:
- Title rewording across rounds → false `new` + false resolved (the finding looks like a different issue)
- Code moves to a different file → false `new` + false resolved (file component no longer matches)
- Two findings with identical file + title → incorrectly merged

These are acceptable for a user-facing hint (the `[new]`/`[persisting]` tags help orientation, not policy). The skill should not make automated decisions based on these tags — they're presentation aids. If we find the heuristic is too noisy in practice, we can strengthen the fingerprint later (e.g., add line-range proximity, description similarity scoring).

**Stale-finding detection:** Each round records a `worktreeHash`. Before the skill acts on findings, it can check if the current worktree hash matches the round's hash. If files have changed since the review, the skill warns the user: "Files have changed since this review. Re-review recommended before fixing."

The CLI exposes this as the `review-orchestra stale` subcommand:
```bash
review-orchestra stale    # exits 0 if fresh, 1 if stale, 2 if no session
```
This is a subcommand (not a flag), consistent with `review-orchestra review` and `review-orchestra reset`. The SKILL.md calls this before fixing.

### Fixing moves to the orchestrator

No more headless fixer process. The orchestrator Claude fixes code directly using its own Edit/Write tools. Benefits:

- The orchestrator has full context from the code-writing session
- The user can interact mid-fix ("don't fix it that way, do this instead")
- No need to spawn another `claude -p` process (saves time and tokens)
- No fixer prompt injection surface (the fixer was reading untrusted code)
- No fixer envelope parsing issues

The skill instructs the orchestrator:
1. Present consolidated findings to the user
2. User says which to fix (all, specific IDs, skip some)
3. Confirm planned actions before editing
4. Orchestrator reads the relevant files and fixes them directly
5. After fixing, ask user if they want to re-review
6. If yes, run `review-orchestra review` again → loop

**Trade-off: context window cost.** Architecture.md's rationale for the headless fixer was "keeps orchestrator context clean." The supervised flow trades context cleanliness for user control and fix accuracy. This is acceptable for typical sessions (1-3 rounds, <30 findings). For large sessions, the SKILL.md includes guidance to suggest starting a fresh conversation.

### Escalation model change

In the current autonomous flow, escalation is an explicit phase (architecture.md Phase 7): the fixer flags ambiguous findings, the orchestrator pauses the loop, and the user decides. Escalation config (`pauseOnAmbiguity`, `pauseOnConflict`) controls this behavior.

In the supervised flow, **escalation is implicit** — every finding goes to the user, and the user decides what to fix. There is no separate escalation phase because the user is already in the loop. This means:
- `escalation.pauseOnAmbiguity` and `escalation.pauseOnConflict` are meaningless in supervised mode
- The `EscalationItem` type is not produced
- The `onEscalation` callback never fires
- Conflicting reviewer opinions are surfaced naturally (both reviewers' perspectives shown in findings)

These config keys and types are deleted along with auto mode.

### SKILL.md structure

```markdown
# Review Orchestra

You orchestrate multi-model code review. You are the fixer and presenter,
but NOT a reviewer — fresh reviewer instances review the code independently.

## Step 1: Review

Run the CLI to get consolidated findings from fresh reviewers:
\`\`\`bash
review-orchestra review $ARGUMENTS
\`\`\`

## Step 2: Present findings

Parse the consolidated JSON output. Present using progressive disclosure:

**If ≤15 findings:** show full detail inline, grouped by severity (P0 first).
**If >15 findings:** show a severity summary table first, then detail for P0/P1
only. Offer to expand P2/P3 on request.

For each finding, show:
- ID (round-scoped, e.g. r1-f-001), severity, title
- File:line, description, suggestion
- Which reviewer(s) found it
- Tag: [new] or [persisting] (compared to previous round, if any)

Separate pre-existing findings under their own heading.

If this is round 2+, also show resolved findings (from the `resolvedFindings`
array in the ReviewResult): "N findings from round X resolved." List titles
briefly — no need for full detail on resolved items.

## Step 3: User decides

Ask the user what to fix. Recognized intents:

- "fix all" — fix ALL findings regardless of severity
- "fix critical" / "fix P0/P1" — fix only P0 and P1 findings
- "fix r1-f-001, r1-f-003" — fix specific findings by ID
- "skip r1-f-002" — mark as skipped (false positive, intentional, etc.)
- "fix all and re-review" — fix all then automatically re-review

**Ambiguity handling:** If the user's intent is unclear (e.g., "fix the
important stuff", "looks good", "leave tests alone"), do NOT guess. Ask a
clarifying question. Examples:
- "fix the important stuff" → "Do you mean fix all P0/P1 findings, or
  something else?"
- "looks good" → "Would you like me to fix these findings, or are you
  saying the code looks good and we're done?"
- "leave tests alone" → "Got it — I'll skip any findings in test files.
  Fix all remaining findings?"

**Pre-existing findings:** If the user explicitly requests fixing a
pre-existing finding (e.g., "fix r1-f-012" where r1-f-012 is tagged
pre-existing), allow it — the user knows best. Note that it was
pre-existing but proceed with the fix.

## Step 4: Confirm before editing

Before making any edits, echo back a summary of planned actions:
- List the finding IDs you will fix
- List any you will skip and why
- State the total number of files to be edited

Wait for user confirmation. This prevents silent policy decisions.

## Step 5: Fix

Fix the approved findings directly using your Edit/Write tools.
You wrote this code — use your context to make accurate fixes.
Do not add new features or refactor beyond what the finding requires.

**Stale-finding check:** Before editing, run
\`review-orchestra stale\`.
- Exit 0 → fresh, proceed with fixes.
- Exit 1 → stale (worktree changed since last review). Warn the user
  and recommend re-reviewing first. Proceed only if the user confirms.
- Exit 2 → no active session. This shouldn't happen mid-flow; if it
  does, re-run \`review-orchestra review\` to start a new session.

**Partial failure handling:** If an edit fails (file moved, merge
conflict, unexpected content), do not silently skip it. Report the
failure to the user immediately with the finding ID and reason, then
continue with remaining fixes. After all fixes, summarize: N fixed,
M failed (with IDs and reasons).

## Step 6: Re-review

**Default behavior:** After fixing, always ask "Want me to re-review?"
Do not re-review automatically unless the user explicitly said
"fix and re-review" in Step 3.

If re-reviewing, run \`review-orchestra review\` again. The CLI
auto-continues the session (increments round, preserves history).
Present new findings with [new]/[persisting] tags, and list
resolved findings separately. Repeat from Step 3.

## Step 7: Done

When the user is satisfied (or reviewers find no issues):
- Summarize the session: rounds completed, findings fixed, findings
  skipped, findings remaining
- Suggest next action based on repo state (commit, push, PR)
```

**Context window management:** The supervised loop runs inside the orchestrator's existing conversation. After multiple rounds, the context fills with file contents, findings JSON, and edit operations. To mitigate:
- The CLI writes full findings to `.review-orchestra/round-N/consolidated.json` — the skill should reference these files rather than keeping all finding detail in conversation
- Between rounds, the skill should summarize the previous round concisely (N fixed, M remaining) rather than preserving full finding text
- The old architecture rationale for the headless fixer was "keeps orchestrator context clean." The supervised flow trades that for user control and accuracy. This is an acceptable trade-off, but for sessions with >3 rounds or >30 findings, context pressure will degrade quality. In those cases, the skill should suggest the user start a fresh conversation.

### What happens to existing components

| Component | Current role | Supervised flow | Notes |
|-----------|-------------|-----------------|-------|
| `src/orchestrator.ts` | Runs the entire loop | Simplified: runs reviewers + consolidation, returns `ReviewResult`. Loop logic deleted. | Major simplification |
| `src/fixer.ts` | Spawns headless claude for fixes | **Deleted** | Orchestrator Claude fixes directly in supervised mode |
| `src/consolidator.ts` | Dedup, P-level, pre-existing tagging | Stays — called as part of `review-orchestra review` | Unchanged |
| `src/scope.ts` | Detects diff scope | Stays | Unchanged |
| `src/reviewers/` | Claude/Codex adapters | Stay | Unchanged |
| `src/process.ts` | Spawn with streaming | Stays — used by reviewers | Unchanged |
| `src/reviewer-parser.ts` | Parse reviewer output | Stays | Unchanged |
| `src/state.ts` | Track session + round state | Rewritten: `StateManager` → `SessionManager`. Current `start()` resets state every invocation — must become session-aware (detect existing session, continue vs create). Adds session IDs, worktree hashes, per-round findings. Removes `FixReport` fields, dead `RoundPhase` values, dead `OrchestratorStatus` values. | See "Session persistence" section |
| `src/cli.ts` | Entry point for full loop | `review-orchestra review` is the only command. Default (no subcommand) also runs review. | Simplified |
| `prompts/review.md` | Reviewer prompt | Stays | Unchanged |
| `prompts/fix.md` | Fixer prompt | **Deleted** | No headless fixer |
| `prompts/consolidate.md` | Consolidation prompt (if used) | **Deleted** — confirmed dead (no imports or references in source) | |
| `skill/SKILL.md` | Tells orchestrator to run CLI and present | Rewritten per above | Major rewrite |

### CLI contract break

This is a **public contract change**, not just an internal simplification.

**Stdout format:**

`review-orchestra review` outputs `ReviewResult` JSON (session ID, round number, consolidated findings with new/persisting tags, resolvedFindings array, worktree hash). The old `OrchestratorSummary` format is deleted.

**Callback surface (for programmatic consumers):**

| Callback | Status |
|----------|--------|
| `onRoundStart` | Fires (single round per invocation) |
| `onReviewComplete` | Fires per reviewer (unchanged) |
| `onReviewerError` | Fires on reviewer failure (unchanged) |
| `onConsolidated` | Fires after consolidation (unchanged) |
| `onFixComplete` | **Deleted** (no fixer) |
| `onEscalation` | **Deleted** (user decides in conversation) |
| `onComplete` | Fires with `ReviewResult` |
| `onPreflightWarning` | Fires (unchanged) |

**Config changes:**

| Config key | Change |
|------------|--------|
| `thresholds.stopAt` | Kept — skill uses it to *recommend* which findings to fix, user decides |
| `thresholds.maxRounds` | **Deleted** — user controls the loop |
| `escalation.pauseOnAmbiguity` | **Deleted** — all findings go to user |
| `escalation.pauseOnConflict` | **Deleted** |

**Type changes:**

| Type | Change |
|------|--------|
| `OrchestratorSummary` | **Deleted**. Replaced by `ReviewResult`. |
| `FixReport` | **Deleted**. |
| `EscalationItem` | **Deleted**. |
| `Round` | `fixReport` field removed. |
| `OrchestratorState` | Renamed to `SessionState`. Adds `sessionId`, `worktreeHash`. |
| New: `ReviewResult` | `{ sessionId, round, findings, resolvedFindings, reviewerErrors, worktreeHash, scope, metadata }` — `reviewerErrors` is `Array<{ reviewer: string, error: string }>`, empty when all reviewers succeed |

### The re-review loop (example)

```
User: /review-orchestra src/services/

Orchestrator: runs `review-orchestra review src/services/`
              → creates session 20260315-143022
              → claude finds 8 issues, codex finds 12
              → consolidated: 15 unique findings (5 duplicated across reviewers)
              → all tagged [new] (first round)

Orchestrator: presents findings:
              "Review round 1 — 15 findings (10 P0/P1, 3 P2, 2 P3):

               **P0**
               r1-f-001: SQL injection in getUser (claude + codex) [new]
               r1-f-002: Path traversal in saveUpload (codex) [new]
               ...

               **P2/P3** (3 P2, 2 P3 — expand?)

               1 pre-existing finding (not in your diff):
               r1-f-015: Missing null check in legacy helper [pre-existing]"

User: "fix the P0s and P1s, skip the P2/P3 stuff"

Orchestrator: "I'll fix these 10 findings:
               r1-f-001, r1-f-002, r1-f-003, ... r1-f-010
               Skipping: r1-f-011 through r1-f-015 (P2/P3/pre-existing)
               Editing 6 files. Proceed?"

User: "yes"

Orchestrator: reads files, fixes 10 findings using Edit tool
              "Fixed 9/10. r1-f-007 failed: file was renamed since review.
               Want me to re-review?"

User: "yes"

Orchestrator: runs `review-orchestra review src/services/`
              → session continues, round 2
              → claude finds 1 issue, codex finds 0
              → consolidated: 1 finding tagged [new], 1 tagged [persisting]
              → resolvedFindings: 9 from round 1 no longer present

Orchestrator: "Re-review round 2 — 2 active findings:
               r2-f-001 [new]: off-by-one in path validation (P1)
               r1-f-007 [persisting]: original finding, file was renamed

               9 findings from round 1 resolved."

User: "fix both"

Orchestrator: "I'll fix r2-f-001 and r1-f-007. Editing 2 files. Proceed?"

User: "yes"

Orchestrator: fixes both

User: "re-review one more time"

Orchestrator: runs `review-orchestra review src/services/`
              → round 3, 0 findings

Orchestrator: "Clean review — no issues found.
               Session summary: 3 rounds, 12 fixed, 4 skipped, 0 remaining.
               Ready to commit."
```

## Implementation order

1. **Update architecture.md** — This is a major rewrite, not an incremental update. Reverse the "Gate vs delete" decision to "Delete, don't gate." Remove: Two Modes table, auto mode phases (4A-8A), `review-orchestra auto` subcommand, `fix-report.json` in state listing, mode-gated component overview, mode-dependent config semantics, mode-gated test descriptions, eval "Fix success" dimension. This is the source of truth (per CLAUDE.md) and must be updated first — it's a decision reversal in the authoritative document, not just an edit.
2. **Atomic migration: delete auto mode + simplify orchestrator** — These are one logical change. Doing them separately strands the repo in a broken intermediate state (e.g. deleting `OrchestratorSummary` breaks `cli.ts` until `ReviewResult` exists). In one pass:
   - Define `ReviewResult` and `SessionState` types
   - Rewrite `orchestrator.ts` to: preflight → reviewers → consolidate → return `ReviewResult`. Delete the loop, `shouldStop()`, `regenerateDiff()`, `buildSummary()`, `suggestAction()`, fixer binary validation, escalation handling, pause logic
   - Switch `cli.ts` to the new contract — remove `maxRounds` override, `onFixComplete`/`onEscalation` callbacks, `OrchestratorSummary` consumption
   - Delete `src/fixer.ts`, `prompts/fix.md`, `prompts/consolidate.md`
   - Clean `src/types.ts` — remove `FixReport`, `EscalationItem`, dead `RoundPhase` values, dead `OrchestratorStatus` values, `ThresholdConfig.maxRounds`, `EscalationConfig`, `Config.escalation`
   - Clean `config/default.json` — remove `thresholds.maxRounds`, `escalation.*`
   - Clean `src/config.ts` — remove `maxRounds` defaults and merge logic
   - Clean `src/parse-args.ts` — remove `maxRounds` parsing
   - Clean `evals/run-eval.ts` — remove `maxRounds` references
   - Delete associated tests in `test/orchestrator.test.ts`, `test/cli.test.ts`, `test/config.test.ts`, `test/state.test.ts`
3. **Rewrite `state.ts` → session model** — This is closer to a rewrite than a refactor. The current `StateManager` is auto-loop-shaped: `start()` resets state every invocation, which directly conflicts with multi-invocation session continuation. Changes:
   - Rename `OrchestratorState` to `SessionState`. Add `sessionId`, `worktreeHash`, per-round worktree hashes
   - Remove `Round.fixReport` field (already done in step 2 types cleanup — this step wires the session logic)
   - Make `StateManager` session-aware: detect existing `session.json` on entry, continue session (increment round) vs create new session. Current `start()` nukes previous state — must become `startOrContinue()`
   - Add round-scoped finding IDs (`r1-f-001`), new/persisting tags on findings, `resolvedFindings` array
   - Rename class `StateManager` → `SessionManager`
   - **Within-invocation crash recovery (folded from checkpointing plan):** If a `review-orchestra review` invocation crashes after some reviewers complete but before all finish, the next invocation detects the incomplete round (session status `active`, current round phase `reviewing` or `consolidating`). If the crash was mid-review, it skips completed reviewers and only runs the missing ones. If the crash was mid-consolidation, it re-runs consolidation. This is the same `saveReview()` pattern already in `state.ts` — the SessionManager reads back saved reviewer output on startup instead of always starting fresh. Implementation detail:
     - **Partial reviewer recovery algorithm:** On entry, check `currentRound.reviews` for existing output. Filter the reviewer list to only those whose name is not already a key in `reviews`. Run only the missing reviewers. Combine cached + new findings before passing to consolidation. ~20 lines of orchestrator logic.
     - **Corrupted state handling:** `persist()` already uses atomic writes (write to `session.json.tmp`, then `rename` — rename is atomic on POSIX). If the tmp file exists but `session.json` doesn't, the last write was interrupted — discard tmp and start fresh.
     - **Concurrent run prevention:** The existing lock file mechanism (`state.lock` with PID check) carries over to the SessionManager. Acquire on first `review` invocation, release on completion or failure. Stale locks (dead PID) are overwritten.
     - **Resume trigger:** Do NOT key off a generic `status: "running"`. Crash recovery only applies to **incomplete** rounds. The correct check is: session status is `active` AND current round phase is NOT `complete`. Then: if phase is `reviewing` and at least one reviewer output exists, skip completed reviewers and run only the missing ones. If phase is `consolidating`, re-run consolidation (it's fast and idempotent). If the current round phase IS `complete`, this is a healthy finished round — the normal session continuation path applies (start round N+1), not crash recovery.
4. **Update CLI** — `review-orchestra review` is the primary command. Default (no subcommand) also runs review. Remove auto-mode subcommand. Add `reset` and `stale` subcommands.
5. **Add stale-detection** — `review-orchestra stale` subcommand compares current worktree hash against last round's hash. Exit 0 (fresh), 1 (stale), 2 (no session).
6. **Add finding comparison logic** — Compare current round's findings against previous round by file + title. Tag new findings with round-N IDs. Persisting findings keep their original ID from the round they first appeared. Build `resolvedFindings` array from previous-but-not-current.
7. **Rewrite SKILL.md** — Supervised flow with confirmation steps, ambiguity handling, progressive disclosure, stale checks, partial failure reporting per the spec above.
8. **Update tests** — Delete auto-mode tests. Add supervised-mode tests per "Testing strategy" section below.
9. **Update README.md** — Remove two-mode descriptions, `fix-report.json` references, `review-orchestra auto` subcommand, auto mode workflow.
10. **Dogfood** — `/review-orchestra` on our own code with the new supervised flow.

## What this does NOT change

- Reviewer implementations (claude.ts, codex.ts) — unchanged
- Scope detection — unchanged
- Consolidation logic — unchanged
- Process spawning — unchanged
- Natural language arg parsing — unchanged (just applied to `review` command), except `maxRounds` parsing is removed

## What IS deleted

### Core files
- `src/fixer.ts` — headless fixer process
- `prompts/fix.md` — fixer prompt template
- `prompts/consolidate.md` — unused consolidation prompt (confirmed dead — no imports or references in source)

### Types and interfaces (`src/types.ts`)
- `OrchestratorSummary` type — replaced by `ReviewResult`
- `FixReport` type — no fixer, no report
- `EscalationItem` type — no escalation phase
- `RoundPhase` dead values: `"checking"`, `"fixing"`, `"escalating"` — only `"reviewing"`, `"consolidating"`, `"complete"` remain
- `OrchestratorStatus` — replaced entirely by `SessionStatus`. New values: `"active"` (session in progress, accepting new rounds), `"expired"` (scope base changed, requires reset), `"completed"` (user explicitly ended session). Old `"running"` / `"paused"` values are deleted, not renamed
- `ThresholdConfig.maxRounds` field
- `EscalationConfig` type
- `Config.escalation` field
- `Round.fixReport` field

### Orchestrator methods (`src/orchestrator.ts`)
- `shouldStop()` — user decides when to stop (plan previously called this `checkStopCondition()` — corrected to match actual code)
- `regenerateDiff()` — exists solely to refresh diff between auto-loop rounds after fixer changes; supervised flow invokes the CLI fresh each time so `scope.ts` handles it on entry
- `buildSummary()` — summary/handoff moves to the skill (SKILL.md Step 7)
- `suggestAction()` — same, moves to the skill
- `onFixComplete` callback
- `onEscalation` callback
- `OrchestratorSummary` interface
- Fixer loop, fixer binary validation, escalation handling, pause logic

### Config (`config/default.json`, `src/config.ts`)
- `thresholds.maxRounds` — user controls the loop
- `escalation.*` block — user sees all findings directly
- `src/config.ts` — `maxRounds` in defaults and config loading/merge logic

### CLI and arg parsing
- `src/cli.ts` — `maxRounds` override passthrough, `onFixComplete`/`onEscalation` callbacks, `OrchestratorSummary` consumption
- `src/parse-args.ts` — `maxRounds` parsing from natural language args

### Evals
- `evals/run-eval.ts` — `maxRounds` references

### Tests
- `test/orchestrator.test.ts` — multi-round loop tests, escalation callback tests, fixer callback tests, `runFixer` imports
- `test/cli.test.ts` — `maxRounds` references
- `test/config.test.ts` — `maxRounds` references
- `test/state.test.ts` — `saveFixReport` tests
- All other auto-mode-specific test coverage

### Docs
- `README.md` — two-mode descriptions, `fix-report.json` references, `review-orchestra auto` subcommand, auto mode workflow

## Auto mode: deleted, not gated

**Strategy: delete, don't gate.** The autonomous flow is broken and carrying it as dead gated code adds complexity to every change (mode parameters, conditional branches, tests for two paths).

The auto mode code is fully removed. If autonomous review→fix loops are needed in future, they'll be rebuilt on top of the clean supervised foundation — which will be a better base than the current broken implementation.

**CLI after this change:**
- `review-orchestra review` → runs review + consolidation, returns findings
- `review-orchestra` (no subcommand) → same as `review`
- `review-orchestra reset` → clears session
- `review-orchestra stale` → checks if files changed since last review

**Primitives retained (all used by supervised flow):**
- `Orchestrator.run()` — the simplified single-round path: preflight → run reviewers → consolidate → return `ReviewResult`. This replaces the old multi-round loop. No new `reviewOnce()` function — the orchestrator itself becomes the single-round primitive.
- `SessionManager` — track rounds, findings, hashes
- `detectScope()` — diff scope auto-detection
- `consolidate()` — dedup, P-level, pre-existing

## Testing strategy

### What's deleted

| Deleted coverage | Reason |
|-----------------|--------|
| `orchestrator.test.ts` multi-round loop tests | Auto-mode loop deleted |
| `orchestrator.test.ts` escalation callback tests | Escalation phase deleted |
| `orchestrator.test.ts` fixer callback tests | Fixer deleted |
| `state.test.ts` `saveFixReport` tests | `FixReport` type deleted |
| Any tests for `shouldStop()` | Stop condition deleted (user decides) |

### New tests required

| Test | What it covers | Type |
|------|---------------|------|
| **CLI `review` subcommand parsing** | `review-orchestra review` is recognized, scope args passed through, natural-language filtering works | TDD |
| **`ReviewResult` output contract** | CLI outputs valid `ReviewResult` JSON matching the schema the SKILL.md expects to parse | TDD |
| **Session creation and continuation** | First `review` creates session, second `review` continues it with incremented round | TDD |
| **Round-scoped finding IDs** | New findings get `rN-f-001` IDs; persisting findings keep their original ID across rounds; no collisions | TDD |
| **Finding comparison (new/persisting/resolved)** | Compare round N findings vs round N-1 by file + title, correct tagging | TDD |
| **Worktree hash computation and stale detection** | `review-orchestra stale` exits 0 when fresh, 1 when stale, 2 when no session | TDD |
| **Partial reviewer failure** | One reviewer fails, other succeeds — CLI returns partial results with error metadata | TDD |
| **Session auto-expiry** | Session warns/expires when scope base changes; requires reset (no force-continue) | TDD |

### Eval updates

| Eval dimension | Current | Supervised |
|----------------|---------|------------|
| **Reviewer precision/recall** | Unchanged — CLI still runs reviewers | Unchanged |
| **Severity accuracy** | Unchanged — consolidation still computes P-levels | Unchanged |
| **Fix success** | Scored by eval harness after fixer runs | Deleted — no fixer. |
| **New: finding comparison accuracy** | N/A | Eval that new/persisting/resolved tags are correct across rounds |
| **New: supervised loop e2e** | N/A | Synthetic scenario: run skill, verify findings presented correctly, verify re-review detects resolved findings. LLM eval (skill behavior is non-deterministic). |

The supervised loop's critical integration point (present → decide → fix → re-review) lives in SKILL.md and is not unit-testable. Contract tests verify the CLI↔skill interface. The e2e eval validates the loop behavior with LLM-as-judge.
