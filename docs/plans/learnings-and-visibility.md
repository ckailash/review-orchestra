# Learnings & Visibility — Feature Plan

**Status:** Planned (not started)
**Priority:** Pre-release — critical for user trust
**Written:** 2026-03-14

---

## Problem

Two gaps that block trust in the system:

1. **No learning loop** — findings from reviews disappear after each run. Patterns across runs aren't captured. No mechanism to turn recurring findings into rules that prevent the same bugs from being written.

2. **Poor visibility during execution** — runs take 10-14 minutes. The user gets no feedback unless they press Ctrl+O to check background task output. For a system that modifies code autonomously across multiple rounds, this opacity is a dealbreaker.

---

## Feature 1: Learnings Storage & Distillation

### Storage Architecture

```
~/.review-orchestra/              # user-scope (default)
├── findings.jsonl                # append-only, all findings across all projects
└── learnings.md                  # distilled rules, LLM-generated, human-reviewed

<project>/.review-orchestra/      # project-scope
├── runs/
│   ├── 2026-03-14T10-00-00/
│   │   ├── state.json           # existing round/finding state
│   │   ├── fix-diffs/
│   │   │   ├── round-1.patch    # git diff after round 1 fixer
│   │   │   └── round-2.patch
│   │   └── summary.json
│   └── ...
├── findings.jsonl                # project-scoped findings (if installed at project scope)
└── learnings.md                  # project-scoped learnings
```

### Scope follows skill installation

- Skill at `~/.claude/skills/` → findings at `~/.review-orchestra/findings.jsonl`
- Skill at `.claude/skills/` → findings at `.review-orchestra/findings.jsonl`
- Let user choose scope at install time (add an install command or document both paths)

### findings.jsonl format

One JSON object per line. Each finding includes run context:

```jsonl
{"timestamp":"2026-03-14T10:00:00Z","project":"/Users/kailash/code/myapp","run_id":"2026-03-14T10-00-00","round":1,"finding":{"id":"f-001","file":"src/auth.ts","line":42,"confidence":"verified","impact":"critical","category":"security","title":"SQL injection","description":"...","suggestion":"...","reviewer":"claude"},"fix_applied":true,"fix_verified":true,"fix_diff":"--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ ...\n"}
```

Key fields beyond the finding itself:
- `project` — which repo
- `fix_applied` — did the fixer attempt this?
- `fix_verified` — was the finding absent in the next round?
- `fix_diff` — the actual code change (inline or reference to patch file)

### Fix diff capture

After each fixer pass, before the next review round:
```typescript
const patch = execSync("git diff").toString();
writeFileSync(`${runDir}/fix-diffs/round-${round}.patch`, patch);
```

Cheap, deterministic, no LLM calls. Gives us "when you see X, do Y" pairs.

### Distillation

Command: `review-orchestra distill` or `/review-orchestra distill`

Reads findings.jsonl, groups by category/pattern, identifies recurring issues, produces `learnings.md`:

```markdown
# Learnings

## SQL Injection (seen 12 times across 4 projects)
**Pattern:** String interpolation in SQL queries, especially with template literals.
**Rule:** Always use parameterized queries. Never interpolate user input into SQL strings.
**Suggested CLAUDE.md rule:**
> When writing database queries, always use parameterized queries ($1, $2 placeholders)
> with a params array. Never use string interpolation or template literals for user input.

## Path Traversal (seen 8 times across 3 projects)
...
```

- Does NOT auto-modify CLAUDE.md — outputs learnings.md for human review
- Recommends rules the user can copy into CLAUDE.md or agents.md
- Could suggest new skills for common fix patterns

### Trigger

- **Auto:** append findings to findings.jsonl after every run (zero cost)
- **On demand:** `review-orchestra distill` runs the LLM summarization
- **Configurable:** `distill_every_n_runs: 10` in config to auto-trigger periodically

---

## Feature 2: Execution Visibility

### Problem

Claude Code's skill execution model: skill → bash command → output when done.
During execution, stderr output exists but isn't surfaced well. Users see nothing
for 10-14 minutes unless they actively check.

### What we control

The CLI already emits status to stderr:
```
[review-orchestra] === Round 1 ===
[review-orchestra] claude: 15 findings
[review-orchestra] codex: 12 findings
[review-orchestra] Consolidated: 27 actionable, 0 pre-existing
[review-orchestra] Round 1 fixes applied
```

### Improvements within our control

1. **More granular status updates:**
   - `[review-orchestra] claude: reviewing... (started 30s ago)`
   - `[review-orchestra] codex: reviewing... (started 30s ago)`
   - `[review-orchestra] fixer: applying fixes for 15 findings...`
   - `[review-orchestra] Round 2: re-reviewing post-fix code...`

2. **Progress summary between rounds:**
   ```
   [review-orchestra] Round 1 complete: 27 findings, 27 sent to fixer
   [review-orchestra] Round 2 complete: 7 new findings (74% reduction), 7 sent to fixer
   [review-orchestra] Round 3 complete: 6 new findings, 2 remaining at P0/P1 threshold
   ```

3. **Elapsed time per phase** (but NOT estimates — per CLAUDE.md):
   ```
   [review-orchestra] Round 1 review: done (claude 45s, codex 62s)
   [review-orchestra] Round 1 fixes: done (38s)
   ```

4. **Intermediate results file** — write a `.review-orchestra/progress.json` that updates
   in real-time. A separate watcher process or the skill itself could poll this.

### What we DON'T control (Claude Code UX)

- How Claude Code surfaces stderr from running bash commands
- Whether there's a "streaming output" mode for skills
- Whether skills can push updates to the conversation mid-execution

### Investigate

- Does Claude Code stream stderr from bash commands in real-time, or buffer until completion?
- Can a skill use multiple sequential bash calls instead of one long-running call,
  so Claude Code shows progress between calls?
- Could the SKILL.md be restructured to run one round at a time via separate bash calls,
  giving Claude the ability to present intermediate results?

### Alternative: round-by-round skill execution

Instead of one long `review-orchestra` bash call, the SKILL.md could instruct Claude to:
1. Run `review-orchestra --round 1` → get findings
2. Present round 1 results to user
3. Run `review-orchestra --round 2 --continue` → get findings
4. Present round 2 results
5. ...until convergence

This gives natural visibility between rounds but adds complexity to the CLI
(needs `--continue` mode with state persistence). Trade-off worth exploring.

---

## Implementation Order

1. Fix diff capture (trivial — add git diff after fixer, save to run dir)
2. findings.jsonl append (trivial — write one line per finding after each run)
3. More granular stderr status updates (small — improve CLI logging)
4. Round-by-round execution mode investigation (research — test what Claude Code can do)
5. Distillation command (medium — LLM summarization of findings.jsonl)
6. Install-time scope selection (small — document or add install command)
