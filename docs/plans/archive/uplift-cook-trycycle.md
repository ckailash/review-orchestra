# Plan: Uplift Plans with Cook + Trycycle Ideas

**Status:** Completed — all work items expanded into individual plans
**Priority:** Pre-implementation — update plan docs before building
**Written:** 2026-03-29
**Inputs:** [Cook analysis](../research/cook-analysis.md), [Trycycle analysis](../research/trycycle-analysis.md)

---

## Context

We analysed two competitor projects — Cook (general-purpose agent workflow DSL) and Trycycle (full-lifecycle dev skill). Both have ideas that would make review-orchestra stronger, both for us and for external users. This plan maps the best ideas to our two remaining plan docs (supervised-flow, learnings-and-visibility) + architecture.md, adds new work items, and establishes implementation order. (Checkpointing was folded into supervised-flow step 3.)

## Current Outstanding Work

| Plan | Status | Priority |
|------|--------|----------|
| Supervised Flow | Planned, not started | Next |
| ~~Checkpointing~~ | Folded into supervised-flow step 3 | N/A |
| Learnings & Visibility | Planned, not started | Pre-release |

Core pipeline is ~60% complete (scope, parallel review, consolidation, state, tests). Auto mode (fixer loop) is broken and being deleted.

---

## Ideas to Adopt (8 of 12)

### From Cook
- **C1. ~~Worktree isolation for auto-mode fixer~~** — No longer applicable. Auto mode deleted. If auto mode is rebuilt later, reconsider.
- **C2. Per-step model config** — Fixer model override in config (partially done for reviewers already).
- **C3. Setup + doctor commands** — `review-orchestra setup` for first-time install, `review-orchestra doctor` for diagnosing broken installs.

### From Trycycle
- **T1. Fresh agent principle (documented)** — We already do this. Document it explicitly + add test guardrail.
- **T2. Expected/observed framing** — Extend Finding type with `expected`/`observed` fields. Higher quality reviews.
- **T3. Evidence fields** — Optional `evidence: string[]` on Finding. "Show your work."
- **T4. Design intent context** — Add commit messages to review prompt. Enables `design_intent` category.
- **T5. Fix guardrails** — "Do not weaken tests to resolve findings" in fix prompts.

### Ideas NOT Adopted
- **C4. Competing fix strategies (`vs`)** — Doubles cost, re-review loop already catches bad fixes.
- **C5. Skill-only mode (no npm)** — CLI does deterministic work (P-levels, dedup, hashing) that can't live in a prompt.
- **T6. Template AST** — Two prompt files with string concat. Overengineering.

---

## Changes Per Existing Plan

### 1. architecture.md

**Decisions table** — Add rows:

| Decision | Choice | Rationale |
|---|---|---|
| Fresh agent principle | Reviewers have no prior-round memory | Prevents context fatigue. buildReviewPrompt must not include prior findings. |
| Finding framing | expected/observed/suggestion (optional) | Forces reviewers to articulate problem + desired state. |
| Evidence on findings | Optional `evidence: string[]` | "Show your work." Improves trust. |
| ~~Fixer isolation (auto)~~ | ~~Git worktree~~ | ~~No longer applicable — auto mode deleted~~ |
| Fix guardrails | Explicit anti-patterns in fix prompt | "Do not weaken tests", "do not refactor beyond the finding." |
| Setup command | `review-orchestra setup` | First-time install: creates skill symlink, checks prereqs, gets you running. |
| Doctor command | `review-orchestra doctor` | Diagnoses broken installs: what's wrong, how to fix it. |
| Design intent context | Commit messages in review prompt | Reviewers can detect intent mismatches. |

**Findings schema** — Add optional fields: `expected`, `observed` (string), `evidence` (string[]).

**Component overview** — Add `src/doctor.ts`.

**CLI subcommands** — Add `setup`, `doctor`.

**Config** — Fixer model config no longer applicable (auto mode deleted). Per-reviewer model config already exists.

**For Open Source** — Add: npm publish, `review-orchestra setup` in getting-started, `review-orchestra doctor` for troubleshooting.

### 2. supervised-flow.md

**Role separation section** — Add "Fresh Agent Principle" subsection documenting WHY reviewers are fresh (Trycycle insight) and the constraint that `buildReviewPrompt` must not include prior findings.

**SKILL.md Step 2 (Present)** — Update finding presentation to show expected/observed when populated (not just title/description).

**SKILL.md Step 5 (Fix)** — Add guardrails: "Do not weaken existing tests to resolve findings. If a finding says a test is wrong, verify the test's intent is correct before modifying it."

**"What this does NOT change" section** — Remove "Review prompt -- unchanged". Review prompt WILL change (expected/observed framing, commit context).

**Implementation order** — Insert new step between 1 and 2: "Update Finding type, review prompt, and schema with expected/observed/evidence fields and commit context."

### 3. ~~checkpointing.md~~ (deleted — folded into supervised-flow.md)

Crash recovery (partial reviewer resume, atomic state writes) is now a subsection of supervised-flow.md step 3 (session model rewrite). No standalone plan needed.

### 4. learnings-and-visibility.md

**findings.jsonl format** — Extend with `expected`, `observed`, `evidence` fields.

**New Feature 3: Run Visualizer** — Static HTML page reading `.review-orchestra/` artifacts. Shows phase timeline, findings per round with severity badges, resolution tracking. CLI: `review-orchestra viz`. Priority: post-release, but data contract defined now.

---

## New Work Items (3)

### NEW-1: Setup + Doctor Commands

**Rationale:** Two purpose-built commands. `setup` gets you running on day one. `doctor` diagnoses what broke later.

**`review-orchestra setup`** — First-time install:
- Creates skill symlink (`~/.claude/skills/review-orchestra -> <package>/skill`)
- Checks prereqs (Node >= 20, git, reviewer binaries on PATH)
- Adds `.review-orchestra/` to `.gitignore` if missing
- Runs basic auth check (can `claude`/`codex` execute?)
- Output: step-by-step progress ("Created symlink... Checked binaries... Ready.")
- Exit 0 if setup complete, exit 1 if something couldn't be resolved

**`review-orchestra doctor`** — Diagnose broken installs:
- Checks everything `setup` checks, but does NOT modify anything
- Reports what's wrong and HOW TO FIX each issue
- Example: "claude binary not found on PATH. Install with: npm install -g @anthropic-ai/claude-code"
- Example: "Skill symlink missing. Run: review-orchestra setup"
- Example: "codex auth failing. Run: codex auth login"
- Output: checklist with pass/fail per check + remediation for failures
- Exit 0 if all healthy, exit 1 if issues found

**Implementation:**
- New files: `src/setup.ts`, `src/doctor.ts` (shared check functions, different actions)
- New CLI subcommands: `setup`, `doctor`
- Test: `test/setup.test.ts`, `test/doctor.test.ts` (TDD)
- Can be built in parallel with supervised flow

### NEW-2: Finding Quality Enhancement

**Rationale:** Trycycle's expected/observed framing and evidence fields produce higher quality reviews. Commit context enables design-intent mismatch detection.

- Extend `Finding` in `src/types.ts`: add `expected?`, `observed?`, `evidence?`
- Update `schemas/findings.schema.json` with optional fields
- Restructure `prompts/review.md` output format to request expected/observed/suggestion
- Update `src/reviewer-parser.ts` normalisation for new fields
- Add commit context to `buildReviewPrompt()` via `git log --oneline base..HEAD`
- Add `design_intent` to suggested review categories
- **Must be done BEFORE supervised SKILL.md rewrite** (presentation depends on these fields)

### NEW-3: Better Install Story

**Rationale:** Getting the tool installed should be one command. Current process requires clone + npm install + manual symlink.

- Prepare `package.json` for npm publish (`files` field, verify `bin`)
- `setup` subcommand handles symlink creation (see NEW-1)
- Target: `npm install -g review-orchestra && review-orchestra setup`
- Priority: pre-release, alongside learnings work

---

## Implementation Order

### Phase A: Foundation (before supervised flow)
1. **NEW-2: Finding quality enhancement** — types, schema, review prompt, parser
2. **T5: Fix guardrails** — add to SKILL.md (prompts/fix.md deleted with auto mode)

### Phase B: Supervised flow (existing plan, enhanced)
3. **supervised-flow.md implementation** — 10-step plan, with enhancements:
   - Architecture.md updated with new decisions (step 1)
   - SKILL.md uses expected/observed presentation + fix guardrails (step 7)
   - Fresh agent principle documented (step 1)

### Phase C: Doctor + install (parallelisable with Phase B)
4. **NEW-1: Setup + doctor commands**
5. **NEW-3: Better install story** (npm publish prep, `setup` handles symlink)

### Phase D: ~~Checkpointing~~ (folded into supervised-flow step 3)
6. ~~checkpointing.md~~ — crash recovery is now part of supervised-flow.md session model rewrite

### Phase E: Learnings & visibility (enhanced)
7. **learnings-and-visibility.md** — existing plan + enhanced findings format + run visualizer spec

### Phase F: Polish
8. Run visualizer implementation
9. README rewrite with getting-started guide
10. Per-step model defaults

---

## Files to Modify

### Plan docs (this uplift)
- `docs/plans/architecture.md` — decisions table, schema, components, CLI, config, open-source
- `docs/plans/supervised-flow.md` — fresh agent principle, SKILL.md presentation, fix guardrails, impl order
- ~~`docs/plans/checkpointing.md`~~ — deleted, content folded into supervised-flow.md step 3
- `docs/plans/learnings-and-visibility.md` — findings.jsonl format, run visualizer feature

### Source (Phase A: finding quality)
- `src/types.ts` — Finding type extension
- `schemas/findings.schema.json` — optional new fields
- `prompts/review.md` — expected/observed format, commit context, design_intent category
- `skill/SKILL.md` — fix guardrails (prompts/fix.md deleted with auto mode)
- `src/reviewer-parser.ts` — normalise new fields
- `src/reviewers/*.ts` — buildReviewPrompt with commit context

### Source (Phase C: setup + doctor)
- `src/setup.ts` (new)
- `src/doctor.ts` (new)
- `src/cli.ts` — subcommand routing
- `test/setup.test.ts` (new)
- `test/doctor.test.ts` (new)
- `package.json` — npm publish prep

## Verification

After updating plan docs:
- `npm run build` succeeds (no source changes yet, just plan docs)
- Each plan doc is internally consistent (no contradictions between them)
- Architecture.md decisions table has no duplicate/conflicting entries
- All "immediately applicable" ideas from both research docs are accounted for in a plan
