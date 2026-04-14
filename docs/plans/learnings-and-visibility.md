# Learnings & Visibility — Feature Plan

**Status:** Partially complete (steps 1-5 done; distillation command and visualizer deferred)
**Priority:** Pre-release — critical for user trust
**Written:** 2026-03-14
**Updated:** 2026-04-07 — uplifted after consolidated review (Claude + Codex): removed auto-mode fix infrastructure, aligned findings.jsonl with finding-quality and supervised-flow plans, fixed storage scope, reframed visibility for supervised mode, added Feature 3 deferral

---

## Problem

Two gaps that block trust in the system:

1. **No learning loop** — findings from reviews disappear after each run. Patterns across runs aren't captured. No mechanism to turn recurring findings into rules that prevent the same bugs from being written.

2. **Poor visibility during review execution** — while reviewers run in parallel, the user gets no feedback unless they press Ctrl+O to check background task output. Even though supervised rounds are short (1-3 minutes), knowing which reviewer is done and which is still running matters for user trust.

---

## Feature 1: Learnings Storage & Distillation

### Storage Architecture

```
~/.review-orchestra/              # user-scope (cross-project learnings)
├── findings.jsonl                # append-only, all findings across all projects
└── learnings.md                  # distilled rules, LLM-generated, human-reviewed

<project>/.review-orchestra/      # project-scope (per-session review artifacts, existing)
├── session.json                  # current session state (includes per-round reviews + consolidated)
├── state.lock                    # PID file for concurrent-run prevention
├── progress.json                 # live reviewer status (deleted on round complete)
├── round-1-claude-raw.txt        # raw reviewer stdout, persisted before parsing
└── round-1-codex-raw.txt
```

### Scope: user-level by default

The supported install mode (per archive/setup-doctor.md) creates a user-level skill symlink at `~/.claude/skills/review-orchestra`. Findings are stored at user scope:

- `~/.review-orchestra/findings.jsonl` — cross-project finding history for distillation
- `~/.review-orchestra/learnings.md` — distilled rules

Per-session review artifacts (round data, consolidated findings) remain project-scoped in `<project>/.review-orchestra/` — this is the existing layout from architecture.md and archive/supervised-flow.md.

**Deferred: project-scope findings.** A future project-scope install mode (skill at `.claude/skills/`) could store findings at `.review-orchestra/findings.jsonl` for project-local distillation. This requires adding project-scope install support to archive/setup-doctor.md first — the install story must drive storage scope, not the other way around.

### findings.jsonl format

One JSON object per line. Each finding includes run context:

```jsonl
{"timestamp":"2026-03-14T10:00:00Z","project":"/home/user/code/myapp","sessionId":"20260314-100000","round":1,"finding":{"id":"r1-f-001","file":"src/auth.ts","line":42,"confidence":"verified","impact":"critical","category":"security","title":"SQL injection via unsanitized user input","expected":"Database queries use parameterized inputs ($1 placeholders) for all user-provided values","observed":"userId is interpolated directly into the SQL query string via template literal","description":"The userId parameter comes from the request URL and is attacker-controlled.","suggestion":"Use parameterized queries: db.query('SELECT * FROM users WHERE id = $1', [userId])","evidence":["Line 42: `db.query(`SELECT * FROM users WHERE id = ${userId}`)` — userId comes from req.params without validation"],"reviewer":"claude"},"status":"new","resolved_in_round":null}
```

Key fields beyond the finding itself:
- `project` — which repo
- `sessionId` — session that produced this finding
- `round` — which round the finding was first detected in
- `status` — `new` or `persisting` (matches the canonical `ReviewResult` model from archive/supervised-flow.md where these are the only two statuses on active findings)
- `resolved_in_round` — populated retroactively: when a subsequent round's `resolvedFindings` array contains this finding (matched by file + title), this field is set to that round number. Null if the finding is still active or the session ended before re-review. This is a findings.jsonl enrichment — the `ReviewResult` itself doesn't carry this field, but findings.jsonl needs it for cross-session distillation.
- `expected` — desired state (optional, from archive/finding-quality-enhancement plan)
- `observed` — actual state (optional)
- `evidence` — supporting evidence array (optional)

**Alignment with `ReviewResult`:** In the canonical model (architecture.md, archive/supervised-flow.md), active findings have status `new` or `persisting`. Resolved findings appear in a separate `resolvedFindings` array — they are not tagged `status: "resolved"` in the main findings list. findings.jsonl follows this: each line is written when a finding first appears (status `new`) or persists across rounds (status `persisting`). Resolution is tracked via `resolved_in_round` being backfilled, not via a status change.

Finding IDs are round-scoped for new findings (`r1-f-001`) and stable for persisting findings (per archive/supervised-flow.md). This matches the `Finding` type defined in the archive/finding-quality-enhancement plan.

### Distillation

Command: `review-orchestra distill` or `/review-orchestra distill`

Reads findings.jsonl, groups by category/pattern, identifies recurring issues, produces `learnings.md`.

**Data sources:** Distillation works from the enriched finding fields — not from fix diffs. In supervised mode, the orchestrator Claude fixes code directly in conversation; there are no captured patches to learn from. Instead, distill leverages:

- **Finding patterns** — recurring titles, categories, and file patterns across projects
- **Expected/observed framing** — when populated, these fields articulate what "correct" looks like, giving distill better signal for rule generation than title + description alone
- **Evidence** — reviewer-provided evidence strengthens the "why" behind generated rules
- **Round outcomes** — `status` and `resolved_in_round` fields show which findings were actually resolved across rounds, giving a signal for which categories of issues the team consistently fixes (vs. skips)

**Trade-off acknowledged:** Without fixer diffs, distill cannot generate verified "when you see X, apply this exact code change" recipes. The `suggestion` field (reviewer-provided) is the closest proxy, but it's a recommendation, not a proven fix. This is acceptable — the goal of learnings is prevention rules for CLAUDE.md, not fix templates.

```markdown
# Learnings

## SQL Injection (seen 12 times across 4 projects, resolved 11 times)
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

## Feature 2: Within-Round Execution Visibility

### Problem

Claude Code's skill execution model: skill → bash command → output when done. During `review-orchestra review`, reviewers run in parallel for 1-3 minutes. The user gets no feedback on which reviewer finished first or whether one is hanging unless they press Ctrl+O to check stderr.

Note: the supervised flow already solves round-to-round visibility — the skill presents findings after each `review-orchestra review` invocation, the user decides, and the skill runs the next round. There's no multi-round opacity problem. The remaining gap is within a single review invocation.

### What we control

The CLI already emits status to stderr:
```
[review-orchestra] === Round 1 ===
[review-orchestra] claude: 15 findings
[review-orchestra] codex: 12 findings
[review-orchestra] Consolidated: 27 actionable, 0 pre-existing
```

### Improvements within our control

1. **Per-reviewer progress on stderr:**
   - `[review-orchestra] claude: reviewing... (started 30s ago)`
   - `[review-orchestra] codex: reviewing... (started 30s ago)`
   - `[review-orchestra] claude: done (15 findings, 45s)`
   - `[review-orchestra] codex: done (12 findings, 62s)`
   - `[review-orchestra] consolidating...`

2. **Elapsed time per reviewer** (but NOT estimates — per CLAUDE.md):
   ```
   [review-orchestra] review complete (claude 45s, codex 62s, consolidation 1s)
   ```

3. **Intermediate results file** — write a `.review-orchestra/progress.json` that updates in real-time during review. Shows which reviewers are running, which are done, and preliminary finding counts. Useful if the user checks via Ctrl+O or a separate terminal.

### What we DON'T control (Claude Code UX)

- How Claude Code surfaces stderr from running bash commands
- Whether there's a "streaming output" mode for skills
- Whether skills can push updates to the conversation mid-execution

---

## Feature 3: Run Visualizer — Deferred (data contract defined)

The uplift review proposed a run visualizer as Feature 3. Implementation is deferred to post-release, but the data contract is defined now so the artifact formats remain stable.

**Rationale for deferral:** Supervised sessions are short (typically 1-3 rounds) and low-artifact. The user sees findings in conversation after each round, decides what to fix, and re-reviews. The session summary in SKILL.md Step 7 provides the round-over-round narrative. A standalone visualizer adds minimal value today over stderr output (Feature 2), the SKILL.md session summary, and the artifacts already saved in `.review-orchestra/`.

**When to build:** When supervised sessions regularly exceed 3-4 rounds, or when users want to compare sessions across time ("how did this week's reviews compare to last week's?").

### Data contract

The visualizer reads two data sources, both already produced by Features 1 and 2:

**1. Per-session artifacts** (`<project>/.review-orchestra/`):

| File | What it provides |
|------|-----------------|
| `session.json` | Session ID, scope, round count, timestamps, worktree hashes, per-round `reviews`, `consolidated`, and `reviewerErrors` |
| `round-N-<reviewer>-raw.txt` | Raw reviewer stdout, persisted before parsing — preserved on parse failure as `*.raw.txt` and on codex subprocess failure as `*.failed` |
| `progress.json` | Within-round reviewer progress (transient — only present during active review) |
| `state.lock` | PID file for concurrent-run prevention (transient — present only while a `review` invocation is running) |
| `summary.json` | Final session summary (rounds completed, findings fixed/skipped/remaining) — produced by the visualizer, not by the CLI |

**2. Cross-project findings** (`~/.review-orchestra/findings.jsonl`):
- One line per finding with project, session, round, status, `resolved_in_round`
- Enables cross-session and cross-project trend views

### Visualizer spec (for future implementation)

- **Format:** Static HTML page generated by `review-orchestra viz`, self-contained (inline CSS/JS), openable in any browser
- **CLI:** `review-orchestra viz` — reads current project's `.review-orchestra/` artifacts, generates `review-orchestra-report.html`
- **CLI (cross-project):** `review-orchestra viz --all` — reads `~/.review-orchestra/findings.jsonl`, shows cross-project trends
- **Views:**
  - **Phase timeline** — horizontal timeline showing review and consolidation phases per round, with elapsed times per reviewer
  - **Findings per round** — grouped by severity with P0-P3 badges, showing new/persisting/resolved flow across rounds
  - **Resolution tracking** — which findings were resolved in which round, skip rate by category
  - **Cross-project trends** (--all only) — recurring categories, resolution rates, top file hotspots

---

## Implementation Order

1. findings.jsonl append (trivial — write one line per finding after each round, using enriched finding fields)
2. `~/.review-orchestra/` directory creation (trivial — ensure user-scope dir exists on first append)
3. Per-reviewer stderr progress (small — improve CLI logging within `review-orchestra review`)
4. Elapsed time per reviewer on stderr (small — timer around each reviewer spawn)
5. `progress.json` intermediate results file (small — write during review, clear on completion)
6. Distillation command (medium — LLM summarization of findings.jsonl with enriched fields)
7. `distill_every_n_runs` auto-trigger (small — counter in user-scope config)
