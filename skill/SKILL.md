---
name: review-orchestra
description: Multi-model code review orchestration — runs Claude + Codex reviewers in parallel, consolidates findings, auto-fixes, and loops until clean.
argument-hint: "[paths...] [options in plain english]"
---

# Review Orchestra

You invoke a multi-model code review pipeline. The `review-orchestra` CLI handles all orchestration — your job is to run it and present the results.

## Step 1: Run the CLI

```bash
review-orchestra $ARGUMENTS
```

The CLI accepts natural language arguments:
- **Paths**: `src/auth/ src/api/` — only review these directories
- **Threshold**: `fix quality issues too` → extends to P2; `fix everything` → P3
- **Reviewer selection**: `only use claude`, `skip codex`
- **Max rounds**: `max 3 rounds`
- **Model selection**: `use opus for claude`, `use o3 for codex`
- **Dry run**: `dry run` — shows what would happen without running reviews
- No arguments = all defaults (auto-detect scope, both reviewers, stop at P1, max 5 rounds)

Status updates are printed to stderr. The final JSON summary is printed to stdout.

## Step 2: Present results

Parse the JSON summary from stdout and present to the user:

1. **Rounds** — how many review-fix cycles ran
2. **Fixed** — how many findings were auto-fixed
3. **Remaining** — any findings that couldn't be fixed (show details: file, line, title, severity)
4. **Pre-existing** — issues in unchanged code (informational, under a separate heading)
5. **Escalations** — findings needing human decisions. Present each with its options and ask the user to decide.
6. **Suggested action** — what to do next (commit, push, create PR, merge)

## Step 3: Fixing Guidelines

When fixing findings, follow these guardrails to avoid common overcorrection patterns:

1. Do not weaken or delete existing tests to resolve a finding. If a finding says a test is wrong, verify the test's intent before modifying it.
2. Do not add new features, abstractions, or utilities beyond what is needed to fix the specific finding.
3. Do not refactor code that is not directly part of the finding. Stay surgical.
4. If a fix requires changing the public API or type signatures, escalate rather than proceeding.

## Error handling

If the CLI exits with a non-zero code, read stderr and present the error. Common issues:
- "No changes detected" — nothing to review
- "Diff is too large" — suggest narrowing scope with paths
- Preflight failures — missing CLI tools (claude, codex)
