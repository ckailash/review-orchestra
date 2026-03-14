# Checkpointing & Resume — Feature Plan

**Status:** Planned (not started)
**Priority:** Before learnings/visibility — makes the pipeline resilient so downstream features can trust run completion
**Written:** 2026-03-14

---

## Problem

A full pipeline run takes 15-20 minutes (two reviewers × 70 files + fixer). If anything crashes partway through — fixer timeout, codex error, user ctrl+c, machine sleep — the entire run restarts from scratch. Reviewer output that took 10 minutes to produce is thrown away.

This happened during dogfooding: codex completed a 676s review, then the fixer was killed by an inactivity timeout. Both reviewers had to re-run from scratch on the retry.

## Design

### State that already exists

`state.json` already tracks per-round data:
```json
{
  "status": "running",
  "currentRound": 2,
  "rounds": [
    {
      "number": 1,
      "phase": "completed",
      "reviews": {
        "claude": { "findings": [...], "metadata": {...} },
        "codex": { "findings": [...], "metadata": {...} }
      },
      "consolidated": [...],
      "fixReport": { "fixed": [...], "skipped": [...], "escalated": [...] }
    },
    {
      "number": 2,
      "phase": "fixing",
      "reviews": {
        "claude": { "findings": [...], "metadata": {...} }
      },
      "consolidated": [...],
      "fixReport": null
    }
  ]
}
```

Reviewer output is saved to state.json as each reviewer completes (orchestrator.ts line 148-157). This means partial progress is already persisted — we just don't read it back on startup.

### Resume logic

On startup, the orchestrator checks for an existing `state.json` with `status: "running"`:

1. **No state.json or status is "completed"/"failed"** → fresh run, start from round 1
2. **State exists with status "running"** → resume from where it left off

Resume picks up based on the last round's phase:

| Last round phase | What's saved | Resume action |
|---|---|---|
| `reviewing` | Some reviewers may have saved output | Re-run only reviewers whose output is missing |
| `consolidating` | All reviews saved | Re-run consolidation |
| `checking` | Consolidated findings saved | Re-check stop condition |
| `fixing` | Consolidated findings saved, no fix report | Re-run fixer only |
| `escalating` | Fix report saved | Re-run escalation |
| `completed` (round) | Everything for this round | Start next round |

### Partial reviewer recovery

The most valuable case: claude finished (output saved to state.json) but codex crashed. On resume:

```typescript
async runReviews(scope: DiffScope): Promise<Finding[]> {
  const currentRound = this.state.getCurrentRound();
  const savedReviews = currentRound?.reviews ?? {};

  // Only run reviewers whose output we don't already have
  const reviewersToRun = this.reviewers.filter(
    r => !(r.name in savedReviews)
  );

  if (reviewersToRun.length < this.reviewers.length) {
    const cached = Object.keys(savedReviews).join(", ");
    log(`resuming: using cached reviews from ${cached}`);
  }

  // Run only the missing reviewers
  const newResults = await Promise.allSettled(
    reviewersToRun.map(async (reviewer) => {
      const findings = await reviewer.review(this.reviewPrompt, scope);
      this.state.saveReview(reviewer.name, { findings, metadata: {...} });
      return findings;
    })
  );

  // Combine cached + new findings
  const allFindings: Finding[] = [];
  for (const [name, review] of Object.entries(savedReviews)) {
    allFindings.push(...review.findings);
  }
  for (const result of newResults) {
    if (result.status === "fulfilled") {
      allFindings.push(...result.value);
    }
  }
  return allFindings;
}
```

### User-facing behavior

**Automatic resume (default):**
```
$ review-orchestra src/services/
[review-orchestra] Found incomplete run (round 2, phase: fixing)
[review-orchestra] Resuming — cached reviews: claude, codex
[review-orchestra] Skipping to fixer...
```

**Force fresh start:**
```
$ review-orchestra src/services/ fresh
[review-orchestra] Discarding previous run, starting fresh
```

Or equivalently: `rm -rf .review-orchestra/` before running.

**Resume with scope mismatch:**
If the saved state's scope (files, type) doesn't match the current invocation, discard and start fresh. Don't try to resume a branch review with uncommitted scope args.

### State persistence points

State must be persisted (written to disk) at every phase transition, not just at the end. Current code persists in some places but not all. Ensure `state.persist()` is called:

- After each reviewer completes (already done)
- After consolidation
- After stop condition check
- After fixer completes
- After escalation
- After round completion
- On status transitions (running → completed/failed)

### Crash recovery edge cases

1. **Fixer modified files then crashed** — the files are partially fixed. The resume re-runs the fixer, which reads the current (partially fixed) files. This is fine — the fixer is idempotent in intent (fix these findings), and the reviewer in the next round catches any issues.

2. **State.json is corrupted (partial write)** — use atomic writes: write to `state.tmp.json`, then rename to `state.json`. Rename is atomic on POSIX.

3. **Two concurrent runs** — the state.ts lock mechanism (if working) prevents this. If not, first-writer-wins on state.json. Don't try to merge concurrent state.

4. **Scope changed between crash and resume** — detect by comparing saved scope (files, type, description) to current. If mismatch, log a warning and start fresh.

## Implementation

### Changes to orchestrator.ts

```typescript
async run(scope: DiffScope): Promise<OrchestratorSummary> {
  // Check for resumable state
  const existingState = this.state.tryLoad();
  if (existingState && existingState.status === "running") {
    if (this.scopeMatches(existingState.scope, scope)) {
      log(`resuming from round ${existingState.currentRound}, phase: ${this.getLastPhase(existingState)}`);
      return this.resumeRun(scope, existingState);
    } else {
      log(`scope mismatch — discarding previous run and starting fresh`);
    }
  }

  // Fresh run (existing code)
  this.state.start(scope);
  return this.runLoop(scope);
}
```

### Changes to state.ts

- Add `tryLoad(): OrchestrationState | null` — reads state.json if it exists, returns null if not
- Make `persist()` atomic (write to tmp, rename)
- Ensure `persist()` is called at every phase transition

### Changes to parse-args.ts

- Add `fresh` keyword detection → `result.fresh = true`
- Orchestrator checks `args.fresh` to skip resume logic

### New tests

- `test/checkpointing.test.ts`:
  - Resumes from saved reviewer output (skips completed reviewers)
  - Resumes from post-review phase (skips straight to fixer)
  - Detects scope mismatch and starts fresh
  - Handles corrupted state.json gracefully
  - `fresh` flag discards existing state
  - Atomic state writes survive mid-write crashes (write tmp + rename)

## Order of implementation

1. Atomic state persistence (write tmp + rename)
2. `tryLoad()` in state.ts
3. Resume logic in orchestrator.ts (phase detection, partial reviewer recovery)
4. `fresh` keyword in parse-args.ts
5. Tests
6. Rebuild + dogfood test (crash the fixer mid-run, verify resume works)

## What this does NOT cover

- **Cross-session resume** — this is same-session crash recovery only. If the user runs a different review later, the old state is discarded.
- **Distributed state** — no remote storage, no multi-machine coordination. State is local to `.review-orchestra/state.json`.
- **Undo fixer changes** — if the fixer partially modified files before crashing, the resume does not roll back those changes. The next review round handles it.
