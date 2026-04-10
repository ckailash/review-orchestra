# Trycycle (danshapiro/trycycle) — Competitive Analysis

**Date:** 2026-03-29
**Repo:** https://github.com/danshapiro/trycycle
**Author:** Dan Shapiro
**Stars:** 97
**License:** MIT
**Lineage:** Adapted from [superpowers](https://github.com/obra/superpowers) by Jesse Vincent

---

## What Trycycle Is

Trycycle is a **full-lifecycle AI development skill** — not just review, but plan -> strengthen -> build -> test -> review -> fix, end to end. It works as a plugin for Claude Code, Codex CLI, Kimi CLI, and OpenCode.

The core idea: you say "Trycycle: build me X" and it handles the entire implementation workflow autonomously. Planning with iterative refinement, test strategy, implementation with TDD, and multi-round review with fresh agents each round.

It is **much broader in scope** than review-orchestra. We focus on the review+fix loop; Trycycle attempts to automate the entire development lifecycle from planning through to PR creation.

---

## How It Works

### The 11-Step Workflow

Trycycle enforces a rigid, sequential workflow defined in SKILL.md:

1. **Parse user request** — Extract intent
2. **Worktree setup** — Create isolated git worktree (or reuse with `--no-worktree`)
3. **Test strategy** — Propose testing approach, get user approval
4. **Canary marking** — Tag the conversation transcript for later retrieval
5. **Context gathering** — Read repo state, existing tests, architecture
6. **Planning (initial)** — Fresh subagent creates implementation plan
7. **Planning (edit loop)** — Up to 5 rounds: fresh reviewer critiques plan, fresh editor refines it, until marked "READY"
8. **Test plan reconciliation** — Align test plan with approved implementation plan
9. **Implementation** — Persistent subagent executes plan with red/green/refactor TDD
10. **Review loop** — Up to 8 rounds: fresh reviewer finds issues, implementation agent fixes them
11. **Finishing** — Present options: merge locally, create PR, keep as-is, or discard

### The "Hill Climber" Pattern

The key architectural insight. Each planning/review round spawns a **fresh agent** with no memory of previous rounds. This prevents context accumulation and stale reasoning. The fresh agent only sees:
- The current state of the plan/code
- The conversation transcript (injected via template)
- Structured observations from previous rounds

This is analogous to simulated annealing — each fresh perspective can identify issues that a context-loaded agent would miss.

### Agent Architecture

| Agent Type | Lifecycle | Purpose |
|-----------|-----------|---------|
| Planning (initial) | Ephemeral | Creates first implementation plan |
| Planning (editor) | Ephemeral per round | Refines plan based on review feedback |
| Planning (reviewer) | Ephemeral per round | Critiques plan, identifies issues |
| Test strategy | Ephemeral | Proposes testing approach |
| Test plan | Ephemeral | Creates concrete test plan from strategy + impl plan |
| Implementation | **Persistent** | Executes plan with TDD, persists across fix cycles |
| Post-impl reviewer | Ephemeral per round | Reviews code, produces structured observations |

The implementation agent is the only persistent one — it accumulates context as it builds. All reviewers and planners are disposable.

### Orchestration Layer (Python)

The orchestrator is a Python layer (~1,200 lines across 3 files) that:
- **`run_phase.py`** — Prepares and dispatches individual phases (builds prompts, resolves transcripts, invokes subagent runner)
- **`subagent_runner.py`** — Multi-backend agent dispatcher with session management, timeout handling, and reply extraction (supports Claude, Codex, Kimi, OpenCode)
- **`review_observations.py`** — Parses structured review output from XML-tagged JSON blocks

### Prompt Template System

Templates live in `subagents/prompt-*.md` and use `{PLACEHOLDER}` substitution with conditional blocks (`{{#if VAR}}...{{else}}...{{/if}}`). The `prompt_builder/` module:
- `template_ast.py` — Proper AST-based template parser (tokenize -> parse -> render)
- `build.py` — Resolves bindings from `--set`, `--set-file`, and transcript lookups
- `validate_rendered.py` — Validates no unsubstituted placeholders remain, required tags are non-empty

### Transcript Threading

A distinctive feature: Trycycle captures the parent conversation transcript and injects it into subagent prompts. This means planning and review agents see the user's original request and all prior discussion. The mechanism varies by host:
- **Claude Code** — Canary-based lookup (marks conversation with unique string, searches JSONL logs)
- **Codex CLI** — Thread ID lookup in session JSONL
- **Kimi CLI** — Session directory lookup via MD5-hashed workdir path
- **OpenCode** — SQLite database query

### Structured Review Observations

The review output format (`review_observations.py`) is a proper schema with:

```json
{
  "status": "issues_found",
  "observations": [
    {
      "id": "obs-1",
      "severity": "critical|major|minor|nit",
      "category": "correctness|security|performance|edge_case|...",
      "expected": "what should happen",
      "observed": "what actually happens",
      "where": { "file": "...", "line": 42, "symbol": "..." },
      "evidence": { "commands": [...], "stdout_excerpt": "..." }
    }
  ]
}
```

Severities: `critical`, `major`, `minor`, `nit`
Categories: `correctness`, `security`, `performance`, `edge_case`, `error_handling`, `missing_test`, `behavior`, `implementation_plan_mismatch`, `test_plan_mismatch`, `other`

Blocking threshold: `critical` and `major` observations block progress.

---

## Key Components

| Path | Language | Lines | Purpose |
|------|----------|-------|---------|
| `SKILL.md` | Markdown | ~800 | Main orchestrator skill (the 11-step workflow) |
| `subskills/trycycle-planning/SKILL.md` | Markdown | ~300 | Planning subagent instructions |
| `subskills/trycycle-executing/SKILL.md` | Markdown | ~200 | Implementation subagent instructions |
| `subskills/trycycle-finishing/SKILL.md` | Markdown | ~150 | Branch completion flow |
| `orchestrator/run_phase.py` | Python | ~250 | Phase preparation and dispatch |
| `orchestrator/subagent_runner.py` | Python | ~600 | Multi-backend agent runner |
| `orchestrator/review_observations.py` | Python | ~200 | Structured review output parser |
| `orchestrator/prompt_builder/template_ast.py` | Python | ~130 | Template AST parser |
| `orchestrator/prompt_builder/build.py` | Python | ~90 | Template renderer CLI |
| `orchestrator/prompt_builder/validate_rendered.py` | Python | ~80 | Prompt validation |
| `orchestrator/user-request-transcript/` | Python | ~400 | Transcript extraction per host |
| `subagents/prompt-*.md` | Markdown | ~600 | Prompt templates for each phase |
| `trycycle_explorer/` | Python+HTML | ~500 | Static site builder for visualising runs |
| `tests/` | Python | ~600 | Automated tests (unittest) |

**Total:** ~4,000 lines (Python + Markdown). Heavier than Cook (~2,100 lines) but covers far more surface area.

---

## What's Good

### 1. The Fresh Agent Pattern

The most important idea in the project. Each review/planning round spawns a fresh agent with no memory of prior rounds. This:
- Prevents context window pollution from accumulating review history
- Avoids the "reviewer gets tired" problem where agents stop finding issues after seeing the same code repeatedly
- Each fresh reviewer brings genuinely independent perspective
- The reviewer has no sunk-cost bias toward previous fixes

**Takeaway:** We should consider whether our re-review rounds benefit from fresh context or suffer from stale context. Currently our reviewers see the same prompt each round but accumulate no inter-round state (since they're headless CLI calls). We're accidentally getting this benefit already, but Trycycle is *intentional* about it.

### 2. Structured Review Observations Schema

The `review_observations.py` parser enforces a proper schema with:
- Severity levels (critical/major/minor/nit)
- Rich categories including plan/test mismatch detection
- Evidence fields (commands run, stdout excerpts, artifacts)
- Location tracking (file, line, symbol)
- Strict validation with clear error messages

This is closer to our findings schema than Cook's binary pass/fail. The `expected`/`observed` framing is particularly good — it forces the reviewer to articulate both what should happen and what actually happens, which produces higher-quality observations than just "this is wrong."

**Takeaway:** The `expected`/`observed` pattern is worth adopting. It's more structured than our current `title`/`description`/`suggestion` triplet and forces the reviewer to be specific about both the problem and the desired state.

### 3. Plan-Review Loop Before Implementation

The planning phase runs up to 5 rounds of plan creation -> review -> refinement before any code is written. This catches architectural issues early when they're cheap to fix, rather than discovering them during code review when the implementation agent has already committed to an approach.

### 4. Test-First as a Hard Requirement

The implementation subagent is explicitly instructed to follow red/green/refactor. The skill enforces: "Continue until all required automated checks pass for legitimate reasons" and explicitly prohibits weakening tests to make them pass. This is a real guardrail.

### 5. Multi-Backend Transcript Threading

The transcript system is clever engineering. By injecting the parent conversation into subagent prompts, each subagent has full context of what the user asked for and what's been discussed. The per-host extraction (JSONL for Codex, canary-search for Claude, SQLite for OpenCode) is messy but necessary given how different each host's session storage is.

### 6. Proper Template AST

Unlike Cook's `new Function()` eval, Trycycle has a real template parser with tokenisation, AST construction, and rendering. It supports conditionals (`{{#if VAR}}...{{else}}...{{/if}}`), placeholder substitution, and validation that no unsubstituted placeholders remain. Much safer.

### 7. The Explorer

`trycycle_explorer/` builds a static HTML site for visualising run histories — phases, observations, decisions. This is useful for debugging and demonstrating the system. Sample data files show different workflow patterns.

### 8. Automated Tests That Test Real Orchestration

The test suite (`tests/`) creates fake agent binaries, fake transcript files, temp directories, and runs `run_phase.py` end-to-end as subprocess calls. This tests the actual orchestration wiring, not just individual functions. Includes tests for each host backend (Codex, Claude canary, Kimi, OpenCode).

---

## What's Weak

### 1. Massive SKILL.md — Orchestration via Prompt

The 11-step workflow is encoded in ~800 lines of Markdown instructions in SKILL.md. The parent Claude/Codex agent reads these instructions and follows them. This means:
- The orchestration logic is non-deterministic (the host agent might skip steps, misinterpret instructions, or drift)
- No programmatic state machine — the "state" is the LLM's working memory
- Debugging is hard because there's no execution log of which step the orchestrator is on
- The workflow can't be tested deterministically

Our approach (TypeScript state machine with explicit `runRound()` -> `consolidate()` -> `fix()` -> `checkStopCondition()`) is fundamentally more reliable.

### 2. No Deterministic Consolidation

When multiple observations come in, there's no dedup. Each review round produces independent observations. If round 3's reviewer reports the same issue as round 1's reviewer, there's no mechanism to detect this — it's up to the implementation agent to notice.

Compare with our consolidator: deterministic dedup by file+title, cross-round comparison with new/persisting/resolved tags, pre-existing detection against diff hunks.

### 3. No Diff Awareness

Like Cook, Trycycle has no concept of "what changed." The review prompt sends the implementation plan and tells the reviewer to look at the code, but there's no scoping to the changeset. Every review round examines the entire implementation, not just what changed since the last round.

For large implementations, this means reviewers waste tokens re-examining code that was already approved.

### 4. Single-Reviewer Per Round

Each review round uses one reviewer agent. There's no multi-model reviewing — you don't get Claude's perspective alongside Codex's perspective on the same code. The fresh-agent pattern compensates somewhat (each round gets fresh eyes), but you miss the multi-model diversity benefit.

### 5. Python + Markdown Hybrid is Awkward

The orchestration logic is split between:
- SKILL.md (the workflow, in natural language)
- Python scripts (prompt building, agent dispatch, observation parsing)
- Subskill SKILL.md files (phase-specific instructions)
- Prompt template Markdown files (the actual prompts)

Understanding how the system works requires reading across 4 different file types in 4 different directories. There's no single entry point that shows the full flow.

### 6. Rigid Sequential Workflow

The 11-step process is fixed. You can't skip planning if you already have a plan. You can't skip test strategy if you already have tests. You can't run review without first running implementation. Every invocation walks the full pipeline.

Cook's composability and our mode-gated architecture are both more flexible here.

### 7. No Parallel Execution

All phases run sequentially — plan, then build, then review. There's no concept of running multiple agents in parallel. The review loop is strictly serial: reviewer -> fixer -> reviewer -> fixer.

### 8. Overkill for "Just Review My Code"

If you just want someone to review your existing code, Trycycle insists on planning, test strategy, implementation, and then review. It's designed for greenfield "build this for me" workflows, not for reviewing existing changes.

Our tool does one thing and does it well: review existing code, consolidate findings, fix iteratively.

### 9. Host-Dependent Transcript Extraction is Fragile

The transcript system relies on:
- Codex's JSONL session format
- Claude's JSONL project log format
- Kimi's share directory + context.jsonl format
- OpenCode's SQLite database schema

Any of these could break with a version update. The canary system for Claude Code (injecting a unique string to find the conversation) is clever but brittle.

---

## What We Can Learn

### Immediately Applicable

1. **Fresh agents per review round** — Each review round should consider spawning fresh headless agents rather than relying on the same process. Since our reviewers are already headless CLI calls with no inter-round state, we're already doing this implicitly. But we should be intentional about it and document it as a design decision.

2. **Expected/observed observation framing** — Our findings use `title`/`description`/`suggestion`. Trycycle's `expected`/`observed` framing is more structured and forces higher-quality reviews. Consider adding `expected` and `observed` fields to our findings schema.

3. **Plan-mismatch as a review category** — Trycycle has `implementation_plan_mismatch` and `test_plan_mismatch` categories. We could add a `design_intent_mismatch` category for when code doesn't match the stated PR description or commit message intent.

4. **Evidence fields on findings** — Trycycle's observations can include `commands`, `stdout_excerpt`, `stderr_excerpt`, `traceback_excerpt`. Our findings could benefit from similar evidence fields to show the reviewer's work, not just their conclusion.

### Worth Considering

5. **Reviewer instructions that prohibit weakening tests** — Trycycle explicitly tells agents: "do not manufacture green by making good tests less demanding." We should include similar guardrails in our fix prompts to prevent the fixer from deleting or weakening tests to make findings go away.

6. **Template AST for prompt building** — If our prompt templates grow more complex, Trycycle's AST-based template system with conditionals and validation is a good pattern. Currently our prompts are simple enough that string interpolation works.

7. **Run visualiser** — The trycycle_explorer that builds a static site showing run history is useful for debugging and demos. We could add something similar for multi-round review sessions.

### Conceptually Interesting (Not Actionable Now)

8. **Full lifecycle orchestration** — If we ever expand beyond review to include planning and implementation phases, Trycycle's workflow is a reference architecture. But we should resist scope creep — our strength is doing review well.

9. **Transcript threading** — Injecting the parent conversation into subagent prompts so they have full user context. Useful if we ever need subagents to understand the user's broader intent, not just the review prompt.

---

## Positioning

| Dimension | Trycycle | Review Orchestra |
|-----------|----------|-----------------|
| **Scope** | Full dev lifecycle (plan -> build -> test -> review -> fix) | Code review + fix loop only |
| **Orchestration** | LLM-driven (SKILL.md instructions) | Deterministic state machine (TypeScript) |
| **Review model** | Single reviewer per round, fresh agent each time | Multiple reviewers in parallel (Claude + Codex) |
| **Findings schema** | Structured observations (severity, category, expected/observed, evidence) | Structured findings (confidence x impact -> P-level, pre-existing tagging) |
| **Consolidation** | None (single reviewer, no dedup needed) | Deterministic dedup, cross-round comparison |
| **Diff awareness** | None | Auto-detect scope (uncommitted, branch, PR), hunk-level pre-existing |
| **Agent backends** | Claude, Codex, Kimi, OpenCode | Claude, Codex (pluggable) |
| **Iteration** | Up to 8 review rounds (fresh reviewer each time) | Configurable rounds with stop conditions |
| **Tests** | Python unittest (~600 lines, real orchestration tests) | Vitest TDD + eval harness |
| **Language** | Python + Markdown prompts | TypeScript |
| **Flexibility** | Rigid 11-step pipeline | Mode-gated (supervised/auto), composable |

### Key Differentiator

Trycycle is a **build tool that reviews** — it automates the full development lifecycle and review is one phase of many. Review Orchestra is a **review tool that fixes** — it focuses entirely on review quality and fix iteration. Different problems, different solutions.

For users who want "build this feature for me end-to-end," Trycycle is more appropriate. For users who want "review what I already wrote and help me fix it," Review Orchestra is more appropriate. The tools don't meaningfully compete.

### Shared Insight

Both projects recognise that **fresh agent context per review round** produces better reviews than accumulating context. Both use structured observation schemas with severity levels. Both enforce iteration until blocking issues are resolved. The core review-loop pattern is converging across projects.
