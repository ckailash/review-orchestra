# Cook (rjcorwin/cook) — Competitive Analysis

**Date:** 2026-03-29
**Repo:** https://github.com/rjcorwin/cook
**Site:** https://rjcorwin.github.io/cook/
**Package:** `@let-it-cook/cli` v5.0.0

---

## What Cook Is

Cook is a **general-purpose workflow orchestration CLI for AI code agents** (Claude Code, Codex, OpenCode). It treats agent orchestration as a DSL problem — a composable grammar for chaining LLM calls with iteration, review gates, and parallel execution.

It is **not** a code review tool. Code review is one possible workflow expressible in its grammar, but Cook has no domain-specific review intelligence (no findings schema, no severity classification, no dedup, no diff awareness).

---

## How It Works

### The Grammar

CLI args are parsed left-to-right into a recursive AST. Operators wrap everything to their left:

```bash
cook "Implement dark mode"                          # single LLM call
cook "Implement dark mode" x3                       # repeat 3 times sequentially
cook "Implement dark mode" review                   # work -> review -> gate loop
cook "Implement dark mode" x3 review                # 3 passes, then review loop
cook "Implement dark mode" review x3                # review loop, repeated 3 times
cook "Implement dark mode" review v3 pick "least lines"  # review, then race 3 parallel copies, pick best
cook "JWT auth" vs "Session auth" pick "best security"   # two different approaches in parallel
```

### AST Node Types

| Node | Purpose |
|------|---------|
| `work` | Single LLM call |
| `repeat` | Sequential repetition of inner node N times |
| `review` | Work -> review -> gate loop (binary DONE/ITERATE verdict) |
| `ralph` | Outer task-progression gate (reads project state, picks next task) |
| `composition` | Parallel branches in git worktrees + resolver |

### Resolvers (for parallel composition)

| Resolver | Behaviour |
|----------|-----------|
| `pick` | LLM judge reads all results, selects winner. Winner branch merged. |
| `merge` | LLM synthesises all results into new implementation in fresh worktree. |
| `compare` | LLM writes comparison doc. No branch merged. |

### Key Components

| File | Lines | Purpose |
|------|-------|---------|
| `src/parser.ts` | ~500 | CLI args -> recursive AST |
| `src/executor.ts` | ~600 | Recursive AST walker, dispatches to step executors |
| `src/loop.ts` | ~100 | The work -> review -> gate iteration loop |
| `src/runner.ts` | ~30 | `AgentRunner` interface + `RunnerPool` factory |
| `src/native-runner.ts` | ~100 | Spawns agent CLIs as child processes |
| `src/race.ts` | ~120 | Git worktree management, judge prompts |
| `src/template.ts` | ~60 | COOK.md template rendering |
| `src/config.ts` | ~130 | Config loading from `.cook/config.json` |
| `src/cli.ts` | ~300 | CLI entry point, init/doctor/rebuild commands |
| `src/ui/*.tsx` | ~200 | Ink/React terminal UI with animations |

**Total:** ~2,100 lines of TypeScript. Lean codebase.

### Tech Stack

- TypeScript + ESM, bundled with tsup
- Ink + React 19 for terminal UI
- dockerode (optional) for Docker sandbox
- Node.js 20+
- Zero automated tests

---

## What's Good

### 1. Composable Grammar (the killer idea)

The left-to-right operator composition is genuinely elegant. Each operator wraps everything to its left into a group. Multiple operators nest like parentheses. This means arbitrarily complex workflows are expressible in a single CLI command without any configuration files.

**Takeaway:** Treating agent orchestration as a language design problem produces a surprisingly expressive tool with minimal code.

### 2. Parser -> AST -> Executor Architecture

Clean interpreter pattern. Parser produces typed AST nodes, executor pattern-matches and recurses. The separation means you can reason about parsing independently of execution. The whole thing is ~1,100 lines for both.

### 3. Git Worktree Isolation

For parallel composition (`vN`, `vs`), each branch runs in its own git worktree — real filesystem isolation without Docker overhead. Each parallel run gets a real copy of the repo, makes real changes, and the resolver picks/merges the winner back. Config files are copied to worktrees.

**Takeaway:** We could use worktrees for our fix step — fix in a worktree, review the fix, merge back if clean. Avoids the "fixer breaks something and we have to undo" problem.

### 4. Per-Step Agent/Model Configuration

```json
{
  "steps": {
    "work":   { "agent": "codex",  "model": "gpt-5-codex" },
    "review": { "agent": "claude", "model": "opus" },
    "gate":   {}
  }
}
```

Each step can use a different agent and model. Work with cheap/fast models, review with expensive/thorough ones. CLI flags override config per-step (`--review-agent claude --review-model opus`).

**Takeaway:** We have reviewer-level config but could be more granular. Using Haiku for gate/verdict decisions is smart cost optimisation.

### 5. COOK.md Template

User-editable Markdown file with `${variable}` interpolation. Users customise the framing once, every step/iteration gets the project-specific context. The template is the single point of project customisation.

### 6. Dual Distribution (CLI + Skill)

Ships both a CLI binary and a Claude Code skill (`no-code/SKILL.md`) where the parent Claude agent acts as the orchestrator with no install. Zero-friction onboarding for Claude Code users.

### 7. Ralph (Outer Task Loop)

An outer loop that reads project state and picks the next task. Combined with review inner loop: "do task -> review -> gate -> next task" until plan is done. Turns any inner workflow into an autonomous task runner.

### 8. The Doctor Command

`cook doctor` checks Docker daemon, agent CLIs on PATH, auth credentials for each agent, env var passthrough config. Comprehensive readiness check. More thorough than our `preflight.ts`.

---

## What's Weak

### 1. No Structured Findings

The review step produces free-text output. The gate just pattern-matches for "DONE" or "ITERATE" keywords in the LLM output. There is:
- No findings schema
- No dedup across reviewers
- No severity classification
- No P-levels or confidence/impact axes
- No pre-existing vs new finding distinction
- No round-over-round finding comparison

The gate is binary pass/fail with zero semantic understanding of what the issues are or whether they were fixed. For code review, this is the fundamental limitation.

### 2. No Deterministic Consolidation

Everything is LLM-in, LLM-out. When running multiple reviewers (via `vs`), there's no deterministic merge — the `pick` resolver asks an LLM "which is best?" For code review, you want to *combine* findings from multiple reviewers, not pick one set.

### 3. No Diff Awareness

Cook has no concept of changesets, diffs, or hunks. You pass a prompt, the agent does whatever. This means:
- Can't scope review to what changed
- Can't distinguish pre-existing issues from new ones
- Can't track which findings were fixed across rounds
- Can't detect stale reviews after code changes

### 4. Template System Uses `new Function()`

`template.ts` does `new Function(...Object.keys(ctx), 'return \`${escaped}\`')` — essentially `eval()` with escaping. Works but is a code injection vector if COOK.md contains untrusted content. Ironic for a project that offers Docker sandboxing for agents.

### 5. Global Singleton EventEmitter

`loopEvents` is a module-level singleton. The composition executor works around this by creating per-branch emitters, but non-composition paths use the global. Will break if someone nests compositions or runs concurrent flows.

### 6. ~200 Lines of Duplicated Executor Code

`executeBranchForComposition` mirrors most logic from `executeWork`, `executeReview`, `executeRepeat`, and `executeRalph` because it needs branch-specific emitters instead of the global one. Could be unified by parameterising the emitter.

### 7. Zero Automated Tests

The `tests/` directory contains only manual test run results in markdown. For a tool with this much compositional complexity (parser edge cases, executor recursion, worktree lifecycle), the absence of unit tests is a significant risk.

### 8. OpenCode Support Incomplete

`NativeRunner` throws for OpenCode ("not supported in native mode"). Docker is the only path. Limits the "three-agent" claim in practice.

### 9. Session Logs Scale Poorly

Logs are append-only markdown. For long runs (ralph with many tasks), these grow large. The template instructs agents to "read the session log for full context" — feeding potentially huge logs into the context window.

---

## What We Can Learn

### Immediately Applicable

1. **Git worktree isolation for fix step** — Fix in a worktree, review the fix, merge if clean. Avoids the "fixer introduces regressions" problem without Docker overhead.

2. **Per-step model configuration** — Use expensive models for review, cheap models for gate/verdict. We could add this to our reviewer config.

3. **Doctor command improvements** — Cook's `cook doctor` is more comprehensive than our preflight. Add auth credential checks, env var validation.

### Worth Considering

4. **`vs` for competing fix strategies** — Run conservative and aggressive fix approaches in parallel, pick the one that passes re-review. Useful for complex fixes where the right approach isn't obvious.

5. **Dual distribution (CLI + skill-only)** — A no-install skill-only mode for users who don't want `npm install`. The orchestrator Claude does everything.

### Conceptually Interesting (Not Actionable Now)

6. **Composable CLI grammar** — The operator composition concept is powerful but our purpose-built pipeline is stronger for code review. If we ever generalise beyond review, this pattern is worth revisiting.

7. **Ralph-style task progression** — An outer loop for working through a plan file task by task, with review gates per task. Could be interesting for "review and fix this entire backlog" scenarios.

---

## Positioning

| Dimension | Cook | Review Orchestra |
|-----------|------|-----------------|
| **Type** | Horizontal primitive (general-purpose agent DSL) | Vertical solution (purpose-built code review) |
| **Review intelligence** | None (binary pass/fail gate) | Structured findings, severity classification, dedup, pre-existing tagging |
| **Diff awareness** | None | Auto-detect scope (uncommitted, branch, PR), hunk-level pre-existing checks |
| **Consolidation** | LLM-based (pick/merge) | Deterministic (dedup, P-level, cross-round comparison) |
| **Parallelism** | Git worktrees for any workflow | Parallel reviewer spawning |
| **Iteration** | Composable operators (xN, review, ralph) | Round-based loop with configurable stop conditions |
| **Agent support** | Claude, Codex, OpenCode | Claude, Codex (pluggable interface) |
| **Sandbox** | Docker or native agent sandbox | None (trusts agent sandboxes) |
| **Tests** | None (manual only) | Vitest TDD + eval harness |
| **TUI** | Ink/React with animations | Skill output (no standalone TUI) |

The projects are **complementary more than competitive**. Cook gives you the loop; we give you the intelligence inside the loop. You could theoretically build review-orchestra on top of Cook's primitives, but you'd still need all our domain-specific logic (consolidator, scope detection, findings schema, P-levels). For the specific problem of multi-model code review, our approach is fundamentally more capable.
