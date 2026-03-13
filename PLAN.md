# review-orchestra

**Multi-model automated code review orchestration for Claude Code.**

A Claude Code skill that runs multiple AI reviewers (Claude + Codex by default) in parallel, consolidates findings, spawns a fixer agent, re-reviews, and loops until the code is clean — with the human only involved for ambiguous decisions.

**Status:** Alpha
**Updated:** 2026-03-14

---

## Problem

Manually orchestrating multi-model code review is tedious:
1. Copy review prompt into headless Claude
2. Copy review prompt into Codex
3. Wait for both
4. Read both outputs, mentally consolidate
5. Fix issues
6. Repeat until clean
7. Do this across 3 different pieces of work simultaneously

This project automates the entire loop.

## Architecture

### Core Concept

A Claude Code **skill** is the entry point. It orchestrates the workflow but delegates all heavy lifting:

- **Reviewers** run as headless CLI processes (parallel, via shell)
- **Consolidation** is done by the orchestrator Claude (the one running the skill)
- **Fixes** are done by a separate headless Claude instance (keeps orchestrator context clean)
- **State** is tracked in a JSON file on disk
- **Loop** continues until the stop condition is met
- **No fixer isolation for v1** — fixer edits files in place. The review loop itself catches regressions. Users should commit or stash before running.

### Why TypeScript (not shell scripts)

- **Target audience is developers.** They have Node/npm. `npm install` is nothing to them.
- **The orchestration is inherently stateful.** Round tracking, configurable thresholds, reviewer registry, output normalization — this is a state machine. TypeScript makes state machines natural.
- **JSON handling.** The entire pipeline is JSON in and out. TypeScript with typed interfaces is clean; shell + `jq` is fragile.
- **Trust & readability.** A typed `ReviewOrchestrator` class with `runRound()` → `consolidate()` → `fix()` → `checkStopCondition()` reads like documentation.
- **Pluggability.** A reviewer interface in TypeScript is far cleaner than templated shell command strings.

### Component Overview

```
review-orchestra/
├── README.md
├── LICENSE (MIT)
├── package.json
├── tsconfig.json
├── src/
│   ├── orchestrator.ts               # Main orchestration loop / state machine
│   ├── reviewers/
│   │   ├── types.ts                  # Reviewer interface
│   │   ├── claude.ts                 # Claude headless reviewer
│   │   ├── codex.ts                  # Codex headless reviewer
│   │   └── index.ts                  # Registry / factory
│   ├── consolidator.ts              # Dedup, classify, merge findings
│   ├── fixer.ts                     # Spawns headless Claude for fixes
│   ├── scope.ts                     # Diff scope auto-detection
│   ├── config.ts                    # Configuration loading & defaults
│   ├── types.ts                     # Shared types (Finding, Round, etc.)
│   └── state.ts                     # Round state tracking (file-based JSON)
├── schemas/
│   └── findings.schema.json          # JSON schema for structured findings output
├── config/
│   └── default.json                  # Default configuration (reviewers, thresholds)
├── skill/
│   └── SKILL.md                      # Claude Code skill entry point
├── prompts/
│   ├── review.md                     # Template for reviewer agents
│   ├── consolidate.md                # Template for consolidation
│   └── fix.md                        # Template for fixer agent
├── test/                             # Unit/integration tests (Vitest)
│   ├── scope.test.ts
│   ├── consolidator.test.ts
│   ├── config.test.ts
│   └── state.test.ts
├── evals/                            # LLM eval harness
│   ├── repos/                        # Synthetic repos with planted bugs
│   ├── golden/                       # Expected findings per synthetic repo
│   ├── judge.ts                      # LLM-as-judge scoring
│   └── run-eval.ts                   # Eval pipeline runner
└── examples/
    └── sample-findings.json
```

## Workflow (Step by Step)

### Phase 1: Scope Detection
Auto-detects the state of the repo:
- **Uncommitted changes on any branch** → `git diff` (staged + unstaged)
- **Committed on branch vs main** → `git diff main...HEAD`
- **Open PR** → `gh pr diff`

User can override with explicit paths: `/review-orchestra src/auth/ src/api/` to only review files in those directories (filtered on top of the auto-detected diff).

Output: a diff or list of changed files that becomes the review target.

### Phase 2: Parallel Review
The orchestrator launches all configured reviewers in parallel:

```bash
# Claude (default reviewer 1)
claude -p "$REVIEW_PROMPT" \
  --allowedTools "Read,Grep,Glob,Bash" \
  --output-format json > $STATE_DIR/claude-round-N.json &

# Codex (default reviewer 2)
codex exec "$REVIEW_PROMPT" \
  --output-schema ./schemas/findings.schema.json \
  -o $STATE_DIR/codex-round-N.json &

wait  # Both finish
```

### Phase 3: Consolidation
The orchestrator Claude reads both review outputs and consolidates:
- Deduplicates findings (same file:line, same issue)
- Classifies each finding on two axes (see Severity Classification below)
- Computes derived P-level (P0–P3)
- Tags findings as `pre-existing` if the file:line is not within the diff hunks
- Produces a single consolidated findings list as JSON
- Writes to `$STATE_DIR/consolidated-round-N.json`

### Phase 4: Stop Condition Check
Default: **keep looping while any P0 or P1 findings remain** (that are not pre-existing).

Pre-existing findings are reported in the final summary but never keep the loop going.

Users override via natural language: "fix quality issues too" → extends to P2.

Safety valve: max rounds (default 5) to prevent infinite loops.

If stop condition met → jump to Phase 7.

### Phase 5: Fix
The orchestrator spawns a **separate headless Claude** to do fixes:

```bash
claude -p "$FIX_PROMPT" \
  --allowedTools "Read,Grep,Glob,Bash,Edit,Write" \
  --output-format json > $STATE_DIR/fix-round-N.json
```

The fix prompt includes:
- The consolidated findings list
- Instructions to fix ALL findings at or above the threshold (no shortcuts, no prioritizing only top ones)
- Instructions to flag any finding that requires an architectural decision or is ambiguous

No fixer isolation for v1 — edits happen in place. The next review round catches regressions.

### Phase 6: Re-Review
Loop back to Phase 2 with fresh reviewer instances. New round number. The reviewers see the current state of the code (post-fix), not the original.

### Phase 7: Escalation (if needed)
During any phase, if the orchestrator or fixer encounters:
- Ambiguous findings where the fix direction is unclear
- Architectural decisions that could go multiple ways
- Conflicting reviewer opinions on the same code

The orchestrator **pauses the loop** and surfaces these to the user with context. The user decides, and the loop resumes.

### Phase 8: Handoff
When the loop completes (stop condition met), the orchestrator:
1. Produces a summary of all rounds (findings found, fixed, remaining, pre-existing)
2. Hands off to the main Claude thread
3. Suggests next action based on repo state:
   - Uncommitted → "Ready to commit"
   - Branch → "Ready to create PR" or "Ready to push"
   - PR → "Ready to merge"

## Severity Classification

### Two-Axis System

Reviewers classify each finding on two independent axes:

**Confidence** — How sure is this a real issue?
- `verified` — reproduced or provably wrong
- `likely` — strong evidence, high confidence
- `possible` — might be an issue, needs investigation
- `speculative` — a hunch, not proven

**Impact** — If real, how bad is it?
- `critical` — security holes, data loss, crashes
- `functional` — broken behavior, logic bugs, edge cases that break things
- `quality` — maintainability, readability, performance
- `nitpick` — style, naming, formatting

### Derived P-Level

The P-level is computed from confidence × impact:

| | Critical | Functional | Quality | Nitpick |
|---|---|---|---|---|
| **Verified** | P0 | P1 | P2 | P3 |
| **Likely** | P0 | P1 | P2 | P3 |
| **Possible** | P1 | P2 | P3 | P3 |
| **Speculative** | P2 | P3 | P3 | P3 |

This means:
- A verified critical edge case = P0 (gets fixed)
- A likely functional bug = P1 (gets fixed)
- A possible security issue = P1 (gets fixed)
- A speculative style nitpick = P3 (reported, not fixed by default)

### Pre-Existing Findings

During consolidation, each finding is checked against the diff hunks. If the file:line was not changed in this diff, the finding is tagged `pre_existing: true`. Pre-existing findings:
- Are reported in the final summary under a separate section
- Never count toward the stop condition
- Are never sent to the fixer

## Pluggable Reviewer Interface

### TypeScript Interface

```typescript
interface Reviewer {
  name: string;
  review(prompt: string, scope: DiffScope): Promise<Finding[]>;
}
```

### Configuration (config/default.json)

```json
{
  "reviewers": {
    "claude": {
      "enabled": true,
      "command": "claude -p \"{prompt}\" --allowedTools \"Read,Grep,Glob,Bash\" --output-format json",
      "outputFormat": "json"
    },
    "codex": {
      "enabled": true,
      "command": "codex exec \"{prompt}\" --output-schema {schemaPath} -o {outputFile}",
      "outputFormat": "json"
    }
  },
  "thresholds": {
    "stopAt": "p1",
    "maxRounds": 5
  },
  "escalation": {
    "pauseOnAmbiguity": true,
    "pauseOnConflict": true
  }
}
```

### Adding a Custom Reviewer

Any CLI command that:
1. Accepts a prompt (via `{prompt}` placeholder in the command template)
2. Outputs findings (JSON preferred, text acceptable)

...can be a reviewer. The consolidator normalizes different output formats into the standard findings schema.

## Skill Invocation UX

Skill name: `/review-orchestra`

Arguments are **natural language via `$ARGUMENTS`** — no `--flags`. The orchestrator LLM parses the intent.

```yaml
argument-hint: "[paths...] [options in plain english]"
```

Examples:
```
/review-orchestra                                  # all defaults, auto-detect scope
/review-orchestra src/auth/ src/api/               # only review these paths
/review-orchestra fix quality issues too            # extend threshold to P2
/review-orchestra only use claude, max 3 rounds    # single reviewer, round limit
/review-orchestra skip codex                       # disable a reviewer
```

Smart defaults (no arguments needed for the common case):
- Auto-detect diff scope
- Both Claude + Codex reviewers
- Stop at P1 (all critical + functional issues fixed)
- Max 5 rounds
- Pause on ambiguity
- Keep all round artifacts

## Findings Schema

```json
{
  "findings": [
    {
      "id": "f-001",
      "file": "src/auth/middleware.ts",
      "line": 42,
      "confidence": "verified",
      "impact": "critical",
      "severity": "p0",
      "category": "security",
      "title": "SQL injection via unsanitized user input",
      "description": "The `userId` parameter is interpolated directly into the SQL query without parameterization.",
      "suggestion": "Use parameterized queries: `db.query('SELECT * FROM users WHERE id = $1', [userId])`",
      "reviewer": "claude",
      "pre_existing": false
    }
  ],
  "metadata": {
    "reviewer": "claude",
    "round": 1,
    "timestamp": "2026-03-13T10:00:00Z",
    "files_reviewed": 12,
    "diff_scope": "branch:feat/auth vs main"
  }
}
```

## State & Round History

All artifacts are stored in `.review-orchestra/` in the project root:

```
.review-orchestra/
├── state.json                        # Current orchestration state
├── round-1/
│   ├── claude-review.json
│   ├── codex-review.json
│   ├── consolidated.json
│   └── fix-report.json
├── round-2/
│   ├── claude-review.json
│   ├── codex-review.json
│   ├── consolidated.json
│   └── fix-report.json
└── summary.json                      # Final summary after completion
```

Everything is kept. Never auto-deleted. Users can `rm -rf .review-orchestra/` when done. Add `.review-orchestra/` to `.gitignore`.

## Testing & Evals

Two distinct concerns:

### Unit/Integration Tests (deterministic code) — TDD

Standard Vitest tests for the TypeScript orchestrator logic. **These are written test-first (TDD):** write the test, watch it fail, implement the code, watch it pass.

TDD applies to all deterministic components:
- Scope detection
- Consolidator (dedup, P-level computation, pre-existing tagging)
- Config loading, defaults, overrides
- State management (round tracking)
- Reviewer output parsing/normalization

```
test/
├── scope.test.ts               # Diff scope auto-detection
├── consolidator.test.ts        # Dedup, P-level computation, pre-existing tagging
├── config.test.ts              # Config loading, defaults, overrides
├── state.test.ts               # Round state tracking
└── reviewer-parser.test.ts     # Output normalization from different reviewer formats
```

These test the mechanical parts — no LLM calls, fully deterministic.

### LLM-Facing Components — test-after

The reviewer adapters, orchestrator loop, fixer spawning, and escalation logic are not TDD candidates — their outputs aren't deterministic and you'd end up mocking everything. Write these components first, then add integration tests that verify the wiring works (e.g., "does the orchestrator call reviewers, read output, call consolidator, check stop condition in the right order?"). Use the eval harness for validating the intelligence.

### Evals (LLM judgment quality)

Follows the pattern established by the Martian Code Review Benchmark and CodeRabbit's evaluation framework:

```
evals/
├── repos/
│   ├── sql-injection/          # Synthetic repo with planted security bugs
│   │   ├── src/                # The buggy code
│   │   └── README.md           # What bugs are planted and why
│   ├── logic-errors/           # Synthetic repo with planted logic bugs
│   │   ├── src/
│   │   └── README.md
│   └── mixed-severity/         # Synthetic repo with mix of P0–P3 issues
│       ├── src/
│       └── README.md
├── golden/
│   ├── sql-injection.json      # Expected findings (natural language, not file:line)
│   ├── logic-errors.json
│   └── mixed-severity.json
├── judge.ts                    # LLM-as-judge: compares actual vs golden findings
├── run-eval.ts                 # Runs full pipeline against synthetic repos, scores results
└── results/                    # Historical eval results for regression tracking
```

#### Golden findings format

Golden findings are **natural language descriptions** of expected issues, not exact file:line matches. The LLM judge determines semantic equivalence — "same underlying issue?" not "same line number."

```json
{
  "fixture": "sql-injection",
  "expected_findings": [
    {
      "description": "User input interpolated directly into SQL query without parameterization",
      "expected_impact": "critical",
      "expected_confidence": "verified"
    }
  ]
}
```

#### LLM-as-judge scoring

A separate Claude call compares actual findings to golden findings:
- **Precision**: What fraction of reported findings are real issues? (not hallucinated)
- **Recall**: What fraction of planted bugs were found?
- **Severity accuracy**: Did it classify confidence and impact correctly?
- **Fix success**: After the fix round, did the issue actually get resolved?

Key insight from CodeRabbit's eval framework: **precision matters more than recall.** A tool that finds 5 real issues beats one that reports 15 where 10 are noise. We optimize for high precision first.

#### Running evals

```bash
npm run eval                    # Run all synthetic repos
npm run eval -- sql-injection   # Run one fixture
npm run eval -- --judge-model claude-sonnet-4-6  # Override judge model
```

Results are saved to `evals/results/` with timestamps for regression tracking.

## Implementation Order

1. **Project scaffolding** — `package.json`, `tsconfig.json`, Vitest config, basic structure
2. **Types** — `Finding`, `Round`, `DiffScope`, `Config`, `Reviewer` interface
3. **Scope detection** (`src/scope.ts`) — TDD: write tests first, then implement
4. **Findings schema** (`schemas/findings.schema.json`)
5. **Reviewer output parser** — TDD: tests for normalizing Claude/Codex output into findings schema
6. **Reviewer implementations** — Claude adapter, Codex adapter (test-after: integration tests for wiring)
7. **Review prompt template** (`prompts/review.md`)
8. **Consolidator** — TDD: tests for dedup, P-level computation, pre-existing tagging, then implement
9. **State manager** — TDD: tests for round tracking, file-based JSON, then implement
10. **Config system** — TDD: tests for loading defaults, user overrides, then implement
11. **Fixer** — spawns headless Claude with fix prompt (test-after)
12. **Orchestrator** — the main loop tying it all together (test-after: integration tests for flow)
12. **SKILL.md** — the Claude Code skill entry point
13. **Escalation handling**
14. **Handoff summary**
15. **Eval synthetic repos** — small repos with planted bugs + golden findings
16. **Eval harness** — `judge.ts`, `run-eval.ts`, `npm run eval`
17. **README + install instructions + examples**

## Decisions Made

| Decision | Choice | Rationale |
|---|---|---|
| Language | TypeScript | Target audience is devs. Types, state machines, JSON handling all better in TS. |
| Fixer isolation | None (v1) | Fixer edits in place. Review loop catches regressions. Keep it simple. |
| Round history | Keep everything | Cheap storage, invaluable for debugging. User deletes when done. |
| Skill name | `/review-orchestra` | Avoids conflict with built-in `/review`. Clear what it does. |
| Arguments | Natural language | Idiomatic for Claude Code skills. No `--flags`. LLM parses intent. |
| Severity | Two-axis (confidence × impact) → P0–P3 | Familiar P-levels as shorthand, nuanced classification underneath. |
| Pre-existing findings | Tag and exclude from stop condition | Diff-hunk check during consolidation. Reported but don't block. |
| Default stop condition | P1 (all P0 + P1 fixed) | Critical + functional issues always fixed. Users extend via natural language. |
| Default reviewers | Claude + Codex | Pluggable interface for adding more. |
| Model selection | Pass-through to CLIs | No hardcoded model list. Verbatim model names passed via `--model` flag. Heuristic routing for bare names (opus→claude, o3→codex). |
| Tests | Vitest for deterministic code | Standard, no LLM calls needed |
| Evals | LLM-as-judge + golden synthetic repos | Follows Martian benchmark pattern. Precision > recall. |

## For Open Source

- MIT license
- README with clear install instructions (symlink skill into `~/.claude/skills/`)
- `npm install` for the TypeScript orchestrator
- Demo GIF or video showing a full review cycle
- Contribution guide for adding new reviewer adapters
- Example custom reviewer implementations
