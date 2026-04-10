# review-orchestra

**Multi-model code review orchestration for Claude Code.**

A Claude Code skill that runs multiple AI reviewers (Claude + Codex by default) in parallel, consolidates findings, and presents them to the user. The orchestrator Claude fixes code directly with user guidance in a supervised loop.

**Status:** Alpha
**Updated:** 2026-04-08

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

This project automates the review and consolidation, and streamlines the fix loop.

## Architecture

### Core Concept

A Claude Code **skill** is the entry point. It orchestrates the workflow but delegates all heavy lifting:

- **Reviewers** run as headless CLI processes (parallel, via shell)
- **Consolidation** is done by the CLI (deterministic dedup, P-level computation, pre-existing tagging)
- **Fixing** is done by the orchestrator Claude directly using Edit/Write tools, guided by user decisions. No headless fixer process.
- **State** is tracked in a session-based JSON file on disk, persisting across multiple CLI invocations

See `docs/plans/supervised-flow.md` for the full supervised flow design.

### Why TypeScript (not shell scripts)

- **Target audience is developers.** They have Node/npm. `npm install` is nothing to them.
- **The orchestration is inherently stateful.** Round tracking, configurable thresholds, reviewer registry, output normalization — this is a state machine. TypeScript makes state machines natural.
- **JSON handling.** The entire pipeline is JSON in and out. TypeScript with typed interfaces is clean; shell + `jq` is fragile.
- **Trust & readability.** A typed `ReviewOrchestrator` class with `run()` → `consolidate()` → `return ReviewResult` reads like documentation.
- **Pluggability.** A reviewer interface in TypeScript is far cleaner than templated shell command strings.

### Component Overview

```
review-orchestra/
├── README.md
├── LICENSE (MIT)
├── package.json
├── tsconfig.json
├── src/
│   ├── orchestrator.ts               # Main orchestration: preflight → reviewers → consolidate → return ReviewResult
│   ├── reviewers/
│   │   ├── types.ts                  # Reviewer interface
│   │   ├── claude.ts                 # Claude headless reviewer
│   │   ├── codex.ts                  # Codex headless reviewer
│   │   ├── command.ts                # Command template parsing
│   │   ├── prompt.ts                 # Review prompt builder
│   │   └── index.ts                  # Registry / factory
│   ├── consolidator.ts              # Dedup, classify, merge findings
│   ├── scope.ts                     # Diff scope auto-detection
│   ├── config.ts                    # Configuration loading & defaults
│   ├── types.ts                     # Shared types (Finding, Round, SessionState, etc.)
│   ├── state.ts                     # Session-based state tracking (file-based JSON)
│   ├── reviewer-parser.ts           # Parse/normalize reviewer output
│   ├── parse-args.ts                # Natural language CLI argument parsing
│   ├── process.ts                   # Process spawning with streaming
│   ├── toolchain.ts                 # Project tech stack detection
│   ├── preflight.ts                 # Validates required binaries
│   ├── checks.ts                    # Shared check functions for setup/doctor
│   ├── setup.ts                     # Setup command (runs checks + fixes)
│   ├── doctor.ts                    # Doctor command (runs checks + reports)
│   ├── json-utils.ts                # JSON extraction & envelope unwrapping
│   └── log.ts                       # Logging utilities
├── schemas/
│   └── findings.schema.json          # JSON schema for structured findings output
├── config/
│   └── default.json                  # Default configuration (reviewers, thresholds)
├── skill/
│   └── SKILL.md                      # Claude Code skill entry point (supervised flow)
├── prompts/
│   └── review.md                     # Template for reviewer agents
├── test/                             # Unit/integration tests (Vitest)
│   ├── scope.test.ts
│   ├── consolidator.test.ts
│   ├── config.test.ts
│   ├── state.test.ts
│   ├── orchestrator.test.ts
│   ├── cli.test.ts
│   ├── reviewer-parser.test.ts
│   ├── json-utils.test.ts
│   ├── toolchain.test.ts
│   ├── preflight.test.ts
│   ├── checks.test.ts
│   ├── setup.test.ts
│   ├── doctor.test.ts
│   └── security.test.ts
├── evals/                            # LLM eval harness
│   ├── repos/                        # Synthetic repos with planted bugs
│   ├── golden/                       # Expected findings per synthetic repo
│   ├── judge.ts                      # LLM-as-judge scoring
│   └── run-eval.ts                   # Eval pipeline runner
└── examples/
    └── sample-findings.json
```

## Workflow (Step by Step)

#### Phase 1: Scope Detection
Auto-detects the state of the repo:
- **Uncommitted changes on any branch** → `git diff` (staged + unstaged)
- **Committed on branch vs main** → `git diff main...HEAD`
- **Open PR** → `gh pr diff` *(planned — `detectScope()` does not produce this scope type yet)*

User can override with explicit paths: `/review-orchestra src/auth/ src/api/` to only review files in those directories (filtered on top of the auto-detected diff).

Output: a diff or list of changed files that becomes the review target.

During scope detection, recent commit messages are captured for developer intent context:
- For `branch` scope: `git log --oneline ${baseBranch}..HEAD`
- For `uncommitted` scope: `git log --oneline -10 HEAD` (last 10 commits for context)
- For `commit` scope: `git log --oneline ${from}${separator}${to}`

These are stored as a `commitMessages?: string` field on `DiffScope` and included in the review prompt under a "Recent Commits (developer intent)" section.

#### Phase 2: Parallel Review
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

#### Phase 3: Consolidation
The CLI consolidates both review outputs:
- Deduplicates findings by `file:line:title.toLowerCase()` — two findings with the same key are considered the same issue regardless of which reviewer produced them. When severities differ, the higher-severity finding wins. When severities are equal, the finding with more populated optional fields (`expected`, `observed`, `evidence`) wins the tie-break.
- Classifies each finding on two axes (see Severity Classification below)
- Computes derived P-level (P0–P3)
- Assigns round-scoped IDs (`r1-f-001`, `r2-f-003`)
- Tags findings as `pre-existing` if the file:line is not within the diff hunks
- Compares against previous round's findings: tags current findings as `new` or `persisting`, and produces a separate `resolvedFindings` list
- Records worktree hash for stale-detection
- Produces a single consolidated findings list as JSON
- Writes to `$STATE_DIR/consolidated-round-N.json`

### Supervised Flow

After Phase 3, the CLI returns the consolidated `ReviewResult` JSON to the skill. The orchestrator presents findings to the user and enters the supervised loop (see `docs/plans/supervised-flow.md`):

- **Phase 4: Present** — Orchestrator shows findings grouped by severity with progressive disclosure
- **Phase 5: User decides** — User selects which findings to fix (by ID, severity band, or "all")
- **Phase 6: Confirm** — Orchestrator echoes back planned actions, waits for confirmation
- **Phase 7: Fix** — Orchestrator fixes code directly using Edit/Write tools
- **Phase 8: Re-review** — If requested, run `review-orchestra review` again (back to Phase 2)
- **Phase 9: Handoff** — Summarize session, suggest next action

Escalation is implicit: the user sees all findings and decides.

### Handoff
When the loop completes (clean review or user is satisfied), the orchestrator:
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
- In supervised mode: the user can explicitly request fixing a pre-existing finding — the orchestrator allows it with a note that the finding is pre-existing

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
    "stopAt": "p1"
  }
}
```

`thresholds.stopAt` is used to suggest which findings to fix (the skill presents it as a recommendation). The user controls the loop and decides when to stop.

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
/review-orchestra                                  # supervised mode, auto-detect scope
/review-orchestra src/auth/ src/api/               # only review these paths
/review-orchestra fix quality issues too            # extend threshold to P2
/review-orchestra only use claude                   # single reviewer
/review-orchestra skip codex                       # disable a reviewer
```

CLI subcommands:
```bash
review-orchestra review                            # run reviewers + consolidate, return findings
review-orchestra review src/services/              # with scope args
review-orchestra review only claude                # natural language filtering
review-orchestra stale                             # check if worktree changed since last review (exit 0=fresh, 1=stale, 2=no session)
review-orchestra reset                             # clear session state
review-orchestra setup                             # first-time install + repair broken install
review-orchestra doctor                            # diagnose issues without modifying anything
```

Smart defaults (no arguments needed for the common case):
- Supervised mode (user controls the loop)
- Auto-detect diff scope
- Both Claude + Codex reviewers
- Stop at P1 (all critical + functional issues fixed) — suggestion, not enforcement
- Keep all round/session artifacts

## Findings Schema

```json
{
  "findings": [
    {
      "id": "r1-f-001",
      "file": "src/auth/middleware.ts",
      "line": 42,
      "confidence": "verified",
      "impact": "critical",
      "severity": "p0",
      "category": "security",
      "title": "SQL injection via unsanitized user input",
      "description": "The `userId` parameter is interpolated directly into the SQL query without parameterization.",
      "expected": "Database queries use parameterized inputs ($1 placeholders) for all user-provided values",
      "observed": "userId is interpolated directly into the SQL query string via template literal",
      "suggestion": "Use parameterized queries: `db.query('SELECT * FROM users WHERE id = $1', [userId])`",
      "evidence": [
        "src/auth/middleware.ts:42 — `db.query(`SELECT * FROM users WHERE id = ${userId}`)`",
        "userId originates from req.params.id (line 38) — attacker-controlled input"
      ],
      "reviewer": "claude",
      "pre_existing": false,
      "status": "new"
    }
  ],
  "metadata": {
    "sessionId": "20260315-143022",
    "round": 1,
    "worktreeHash": "abc123def456",
    "timestamp": "2026-03-15T14:30:22Z",
    "files_reviewed": 12,
    "diff_scope": "branch:feat/auth vs main"
  }
}
```

### Finding Fields

| Field | Required | Type | Purpose |
|-------|----------|------|---------|
| `id` | Yes | string | Round-scoped ID (`r1-f-001`) |
| `file` | Yes | string | File path |
| `line` | Yes | number | Line number |
| `confidence` | Yes | enum | How sure: verified, likely, possible, speculative |
| `impact` | Yes | enum | How bad: critical, functional, quality, nitpick |
| `severity` | Yes | enum | Derived P-level (p0-p3) |
| `category` | Yes | string | Issue type: security, logic, performance, error_handling, design_intent, etc. |
| `title` | Yes | string | One-line summary (used for dedup and display) |
| `description` | Yes | string | Context, explanation, impact |
| `expected` | No | string | Desired state — what should the code do? |
| `observed` | No | string | Actual state — what does the code do? |
| `suggestion` | Yes | string | How to fix |
| `evidence` | No | string[] | Supporting evidence: code snippets, traces, logical arguments |
| `reviewer` | Yes | string | Which reviewer found it |
| `pre_existing` | Yes | boolean | Whether file:line is outside the diff hunks |
| `status` | Yes | string | `new` or `persisting` |

The `expected`, `observed`, and `evidence` fields are optional. They improve finding quality but are not required — style nitpicks and naming issues often don't have a meaningful expected/observed state. Reviewers that produce these fields naturally get higher quality scores.

Finding IDs are round-scoped (`r1-f-001`, `r2-f-003`) to prevent collisions across rounds. The `status` field on each finding in the main `findings` array is one of:
- `new` — first time this finding appears
- `persisting` — appeared in a previous round and still present (matched by normalized file + title)

Resolved findings (in previous round but not current) are returned in a separate `resolvedFindings` array in the `ReviewResult`, not mixed into the main findings list. This avoids ambiguity about whether a "resolved" entry is actionable.

**Matching heuristic:** Findings are compared across rounds by `file + title.toLowerCase()`. This is best-effort — see `docs/plans/supervised-flow.md` for known limitations. The `[new]`/`[persisting]` tags are presentation aids for user orientation, not policy inputs.

## State & Round History

All artifacts are stored in `.review-orchestra/` in the project root:

```
.review-orchestra/
├── session.json                      # Current session state (ID, scope, rounds, hashes)
├── round-1/
│   ├── claude-review.json
│   ├── codex-review.json
│   └── consolidated.json
└── round-2/
    ├── claude-review.json
    ├── codex-review.json
    └── consolidated.json
```

Everything is kept. Never auto-deleted. Users can `rm -rf .review-orchestra/` or `review-orchestra reset` when done. Add `.review-orchestra/` to `.gitignore`.

Session state (`session.json`) structure:

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

Key fields:
- `sessionId` — timestamp-based unique ID
- `status` — `active` (accepting new rounds), `expired` (scope base changed, requires reset), or `completed` (user explicitly ended session)
- `scope` — the diff scope detected at session creation
- `currentRound` — current round number
- `worktreeHash` — per-round snapshot for stale-detection. Covers HEAD, staged changes, unstaged changes, and untracked files (see `docs/plans/supervised-flow.md` for precise definition)
- `rounds[]` — per-round artifacts: round number, worktree hash, findings, timestamp
- `startedAt` — session creation timestamp

Session lifecycle:
- `review-orchestra review` → creates or continues session, runs reviewers + consolidation, returns findings
- `review-orchestra reset` → clears the session (equivalent to `rm -rf .review-orchestra/`)
- Session auto-expires if the scope base changes (e.g., new commits on main) — stale session warning, user must reset and start fresh. No force-continue: old findings are unreliable when the base has moved.

Finding IDs are round-scoped for new findings (`r1-f-001`, `r2-f-003`) to prevent collisions. Persisting findings keep their original ID across rounds — if `r1-f-007` is still present in round 2, it stays `r1-f-007 [persisting]`, not re-numbered. The round prefix tells you *when the finding was first detected*, not which round you're looking at.

Finding comparison: current findings tagged `new` / `persisting`; resolved findings (in previous round but not current) in a separate `resolvedFindings` array in the `ReviewResult`.

## Testing & Evals

Two distinct concerns:

### Unit/Integration Tests (deterministic code) — TDD

Standard Vitest tests for the TypeScript orchestrator logic. **These are written test-first (TDD):** write the test, watch it fail, implement the code, watch it pass.

TDD applies to all deterministic components:
- Scope detection
- Consolidator (dedup, P-level computation, pre-existing tagging, finding comparison)
- Config loading, defaults, overrides
- Session management (session creation/continuation, round tracking, worktree hashing)
- Reviewer output parsing/normalization
- Round-scoped finding ID generation
- Stale-detection logic
- CLI subcommand parsing and `ReviewResult` output contract
- Setup/doctor check functions

```
test/
├── scope.test.ts               # Diff scope auto-detection
├── consolidator.test.ts        # Dedup, P-level computation, pre-existing tagging
├── config.test.ts              # Config loading, defaults, overrides
├── state.test.ts               # Session + round state tracking
├── reviewer-parser.test.ts     # Output normalization from different reviewer formats
├── orchestrator.test.ts        # Orchestration: runs reviewers, consolidates, returns ReviewResult
├── cli.test.ts                 # CLI argument parsing, subcommands
├── json-utils.test.ts          # JSON extraction, envelope unwrapping
├── toolchain.test.ts           # Tech stack detection
├── preflight.test.ts           # Binary validation
├── checks.test.ts              # Setup/doctor check functions
├── setup.test.ts               # Setup command actions and idempotency
├── doctor.test.ts              # Doctor command reporting
└── security.test.ts            # Path validation, prompt escaping
```

These test the mechanical parts — no LLM calls, fully deterministic.

### LLM-Facing Components — test-after

The reviewer adapters and orchestrator wiring are not TDD candidates — their outputs aren't deterministic and you'd end up mocking everything. Write these components first, then add integration tests that verify the wiring works (e.g., "does the orchestrator call reviewers, read output, call consolidator in the right order?"). Use the eval harness for validating the intelligence.

The supervised loop's critical integration point (present → decide → fix → re-review) lives in SKILL.md and cannot be unit-tested. Contract tests verify the CLI↔skill interface (CLI outputs valid `ReviewResult` JSON). The supervised e2e eval validates loop behavior with LLM-as-judge.

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
- **Finding comparison accuracy** (multi-round): Are new/persisting/resolved tags correct across rounds?

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
2. **Types** — `Finding` (with optional `expected`, `observed`, `evidence`), `Round`, `DiffScope` (with optional `commitMessages`), `Config`, `Reviewer` interface
3. **Scope detection** (`src/scope.ts`) — TDD: write tests first, then implement
4. **Findings schema** (`schemas/findings.schema.json`)
5. **Reviewer output parser** — TDD: tests for normalizing Claude/Codex output into findings schema
6. **Reviewer implementations** — Claude adapter, Codex adapter (test-after: integration tests for wiring)
7. **Review prompt template** (`prompts/review.md`)
8. **Consolidator** — TDD: tests for dedup, P-level computation, pre-existing tagging, then implement
9. **State manager** — TDD: tests for round tracking, file-based JSON, then implement
10. **Config system** — TDD: tests for loading defaults, user overrides, then implement
11. **Orchestrator** — preflight → reviewers → consolidate → return `ReviewResult` (test-after: integration tests for flow)
12. **SKILL.md** — the Claude Code skill entry point (supervised flow with fix guardrails)
13. **Handoff summary**
14. **Setup + Doctor commands** — `review-orchestra setup` and `review-orchestra doctor`
15. **Eval synthetic repos** — small repos with planted bugs + golden findings
16. **Eval harness** — `judge.ts`, `run-eval.ts`, `npm run eval`
17. **README + install instructions + examples**

## Decisions Made

| Decision | Choice | Rationale |
|---|---|---|
| Language | TypeScript | Target audience is devs. Types, state machines, JSON handling all better in TS. |
| Mode | Supervised only | User controls the loop — better fix accuracy, no autonomous mistakes. Auto mode deleted, not gated. |
| Fixer | Orchestrator Claude | Wrote the code, has full context, can interact with user mid-fix. Trades context cleanliness for accuracy. |
| Fixer isolation | None | Fixer edits in place. Review loop catches regressions. Keep it simple. |
| Consolidation location | CLI (not skill/LLM) | Deterministic code: dedup, P-level, pre-existing tagging. No reason to make the LLM do it. |
| Session persistence | Session-based state with worktree hashes | Supports multi-invocation supervised loop. Round-scoped finding IDs prevent collisions. Worktree hashes enable stale-detection. |
| Finding IDs | Round-scoped (`r1-f-001`) | Prevents collisions across review rounds. User can reference specific findings unambiguously. |
| Finding comparison | File + title matching across rounds | Tags current findings as new/persisting; resolved findings in separate array. Best-effort heuristic — presentation aid, not policy input. |
| Fresh agent principle | Reviewers have no prior-round memory | Fresh headless instances each round. The orchestrator (who wrote the code) is the worst reviewer of its own work — fresh eyes catch more. |
| Finding framing | Expected/observed/suggestion (optional) | Three optional lenses per finding: what should be (expected), what is (observed), how to fix (suggestion). Optional because not all finding types benefit equally. |
| Evidence on findings | Optional `evidence: string[]` | Free-form string array for supporting evidence. Lets reviewers show their work. Especially valuable for verified/security findings. |
| Design intent context | Commit messages in review prompt | Recent commit messages included in review prompt so reviewers can detect code that works but contradicts developer intent. Stored as `commitMessages` on `DiffScope`. |
| Fix guardrails | Explicit anti-patterns in SKILL.md | Don't weaken tests, don't add features, don't refactor beyond the finding, escalate API changes. Prevents common overcorrection patterns. |
| Round history | Keep everything | Cheap storage, invaluable for debugging. User deletes when done. |
| Skill name | `/review-orchestra` | Avoids conflict with built-in `/review`. Clear what it does. |
| Arguments | Natural language | Idiomatic for Claude Code skills. No `--flags`. LLM parses intent. |
| Severity | Two-axis (confidence × impact) → P0–P3 | Familiar P-levels as shorthand, nuanced classification underneath. |
| Pre-existing findings | Tag and exclude from recommendations | Diff-hunk check during consolidation. Reported but don't block. User can override in supervised mode. |
| Default stop condition | P1 (all P0 + P1 fixed) | Critical + functional issues always fixed. Users extend via natural language. This is a suggestion, not enforcement. |
| Default reviewers | Claude + Codex | Pluggable interface for adding more. |
| Model selection | Pass-through to CLIs | No hardcoded model list. Verbatim model names passed via `--model` flag. Heuristic routing for bare names (opus→claude, o3→codex). |
| Review prompt | File list only (reviewers read from disk) | Reviewers see current file state, not a stale diff. Avoids multi-round staleness bug. See "Future: Diff-in-prompt mode" below. |
| Setup command | `review-orchestra setup` | First-time install, symlink creation, gitignore setup. Idempotent — safe to run repeatedly. |
| Doctor command | `review-orchestra doctor` | Diagnose issues without modifying anything. Reports pass/fail/warn for each check with remediation hints. |
| Tests | Vitest for deterministic code | Standard, no LLM calls needed. |
| Evals | LLM-as-judge + golden synthetic repos | Follows Martian benchmark pattern. Precision > recall. |

## Future: Diff-in-prompt mode

The current review prompt sends only the file list and instructs reviewers to read files from disk. This works well for reviewers with file-reading capabilities (Claude has `Read,Grep,Glob,Bash`; Codex has sandbox file access) and naturally solves the multi-round staleness problem — reviewers always see the current state of the code.

A future alternative for "dumb pipe" reviewers (CLI tools that accept text in, return text out, with no file access):
- Pass the full diff in the prompt (the original v1 approach)
- Requires regenerating the diff before each round so reviewers see post-fix code
- `scope.diff` is already captured during scope detection — would need a `refreshScope()` function to regenerate it from the scope's base ref to the current working tree
- Trade-off: more universal (any CLI tool works) but hits token limits on large diffs and adds complexity to the round loop

Add this as an opt-in mode (e.g., `reviewerConfig.promptMode: "file-list" | "inline-diff"`) when a concrete use case for dumb-pipe reviewers appears. Don't build it speculatively.

## For Open Source

- MIT license
- README with clear install instructions (symlink skill into `~/.claude/skills/`)
- `npm install` for the TypeScript orchestrator
- Demo GIF or video showing a full review cycle
- Contribution guide for adding new reviewer adapters
- Example custom reviewer implementations
