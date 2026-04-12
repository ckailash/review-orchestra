# review-orchestra

Multi-model code review orchestration for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Runs multiple AI reviewers (Claude + Codex by default) in parallel, consolidates findings, and presents them to the user. The orchestrator Claude fixes code directly with user guidance in a supervised loop.

## How it works

```
          +-------------------+
          |  Detect Scope     |  git diff / branch diff / PR diff
          +--------+----------+
                   |
          +--------v----------+
          |  Parallel Review   |  Claude + Codex (headless, concurrent)
          +--------+----------+
                   |
          +--------v----------+
          |  Consolidate       |  Dedup, classify confidence × impact, compute P-level
          +--------+----------+
                   |
          +--------v----------+
          |  Return findings   |  ReviewResult JSON → skill → user
          +-------------------+
```

1. **Scope detection** — auto-detects uncommitted changes, branch diff vs main, or open PR diff.
2. **Parallel review** — launches all configured reviewers as headless CLI processes concurrently.
3. **Consolidation** — deduplicates findings across reviewers, classifies each on two axes (confidence × impact), computes a P-level (P0–P3), tags pre-existing issues outside the diff, and compares findings against previous rounds.
4. **Return findings** — the CLI returns a `ReviewResult` JSON on stdout. The skill presents findings to the user, who decides what to fix.

After receiving findings, the orchestrator Claude (who wrote the code and has full context) fixes issues directly with user guidance. The user controls what gets fixed and when to re-review.

## Installation

### Prerequisites

- Node.js >= 20
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
- [Codex CLI](https://github.com/openai/codex) (`codex`) — optional, can be disabled

### Setup

```bash
# Clone and install
git clone https://github.com/anthropics/review-orchestra.git
cd review-orchestra
npm install
npm run build

# Symlink the skill into Claude Code
ln -s "$(pwd)/skill" ~/.claude/skills/review-orchestra
```

## Usage

Invoke via the `/review-orchestra` skill in Claude Code. Arguments are natural language — no flags.

```
/review-orchestra                                  # auto-detect scope, all defaults
/review-orchestra src/auth/ src/api/               # only review these paths
/review-orchestra fix quality issues too            # extend threshold to P2
/review-orchestra only use claude                   # single reviewer
/review-orchestra skip codex                       # disable a specific reviewer
```

**Defaults** (when no arguments are provided):
- Auto-detect diff scope
- Both Claude + Codex reviewers
- Stop-at threshold: P1 (all critical + functional issues recommended for fixing)

### CLI subcommands

```bash
review-orchestra review                            # run reviewers + consolidate, return findings (default)
review-orchestra review src/services/              # with scope args
review-orchestra review only claude                # natural language filtering
review-orchestra stale                             # check if worktree changed since last review (exit 0=fresh, 1=stale, 2=no session)
review-orchestra reset                             # clear session state
review-orchestra setup                             # first-time install + repair broken install
review-orchestra doctor                            # diagnose issues without modifying anything
```

Running with no subcommand (just scope args) is equivalent to `review-orchestra review`.

### Supervised workflow

The CLI runs review + consolidation and returns a `ReviewResult` JSON. The skill then enters the supervised loop:

1. **Review** — run `review-orchestra review` (spawns reviewers, consolidates, returns findings)
2. **Present** — skill shows findings grouped by severity with progressive disclosure
3. **User decides** — user selects which findings to fix (by ID, severity band, or "all")
4. **Confirm** — skill echoes back planned actions, waits for confirmation
5. **Fix** — orchestrator Claude fixes code directly using Edit/Write tools
6. **Re-review** — if requested, run `review-orchestra review` again (back to step 1)
7. **Done** — summarize session, suggest next action (commit, push, PR)

The user controls the loop at every step. Escalation is implicit: the user sees all findings and decides.

### Session artifacts

All round data is stored in `.review-orchestra/` in the project root:

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

#### Session state (`session.json`)

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
      "findings": [ "..." ],
      "startedAt": "2026-03-15T14:30:22Z"
    },
    {
      "number": 2,
      "worktreeHash": "abc123",
      "findings": [ "..." ],
      "startedAt": "2026-03-15T14:35:10Z"
    }
  ],
  "startedAt": "2026-03-15T14:30:22Z"
}
```

Key fields:
- `sessionId` — timestamp-based unique ID (e.g. `20260315-143022`)
- `status` — `active` (accepting new rounds), `expired` (scope base changed, requires reset), or `completed` (user explicitly ended session)
- `scope` — the diff scope detected at session creation
- `currentRound` — current round number
- `worktreeHash` — per-round snapshot for stale-detection (SHA-256 over HEAD, staged changes, unstaged changes, and untracked files)
- `rounds[]` — per-round artifacts: round number, worktree hash, findings, timestamp
- `startedAt` — session creation timestamp

Session lifecycle:
- `review-orchestra review` → creates or continues session, runs reviewers + consolidation, returns findings
- `review-orchestra reset` → clears the session (equivalent to `rm -rf .review-orchestra/`)
- Session auto-expires if the scope base changes (e.g., new commits on main) — stale session warning, user must reset and start fresh

## Configuration

Configuration lives in `config/default.json`:

```json
{
  "reviewers": {
    "claude": {
      "enabled": true,
      "command": "claude -p - --allowed-tools \"Read,Grep,Glob,Bash\" --output-format json",
      "outputFormat": "json"
    },
    "codex": {
      "enabled": true,
      "command": "codex exec - --output-last-message {outputFile} --json",
      "outputFormat": "json"
    }
  },
  "thresholds": {
    "stopAt": "p1"
  }
}
```

### Thresholds

| Setting | Default | Description |
|---|---|---|
| `stopAt` | `p1` | Suggests which findings to fix. `p0` = critical only, `p1` = critical + functional, `p2` = + quality, `p3` = fix everything. The user controls the loop and decides when to stop. |

### Finding comparison

Cross-round finding comparison uses LLM-based semantic matching by default (via Claude Haiku). This handles renamed files, shifted line numbers, and reworded descriptions across review rounds. On LLM failure or timeout, it falls back to heuristic matching (`file + title.toLowerCase()`). Configure via `findingComparison` in `config/default.json`:

| Setting | Default | Description |
|---|---|---|
| `method` | `"llm"` | Comparison method: `"llm"` for semantic matching, `"heuristic"` for file+title matching |
| `model` | `"claude-haiku-4-5"` | Model to use for LLM comparison |
| `timeoutMs` | `60000` | Timeout for LLM comparison call (ms) |
| `fallback` | `"heuristic"` | Fallback method when LLM fails |

### Severity model

Findings are classified on two independent axes, then a P-level is derived:

| | Critical | Functional | Quality | Nitpick |
|---|---|---|---|---|
| **Verified** | P0 | P1 | P2 | P3 |
| **Likely** | P0 | P1 | P2 | P3 |
| **Possible** | P1 | P2 | P3 | P3 |
| **Speculative** | P2 | P3 | P3 | P3 |

Pre-existing findings (outside the diff hunks) are tagged and excluded from recommendations. In supervised mode, the user can explicitly request fixing a pre-existing finding.

## Component overview

```
review-orchestra/
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
│   ├── types.ts                     # Shared types (Finding, Round, SessionState, ReviewResult, etc.)
│   ├── state.ts                     # SessionManager: session-based state tracking
│   ├── worktree-hash.ts             # Worktree hash computation and stale detection
│   ├── finding-comparison.ts        # Cross-round finding comparison (new/persisting/resolved)
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
├── config/
│   └── default.json                  # Default configuration (reviewers, thresholds)
├── skill/
│   └── SKILL.md                      # Claude Code skill entry point (supervised flow)
├── prompts/
│   └── review.md                     # Template for reviewer agents
├── schemas/
│   └── findings.schema.json          # JSON schema for structured findings output
├── test/                             # Unit/integration tests (Vitest)
└── evals/                            # LLM eval harness
```

The orchestrator (`src/orchestrator.ts`) runs a single pass: preflight → parallel reviewers → consolidation → finding comparison → return `ReviewResult`. There is no loop — the user controls re-review decisions via the skill.

State is managed by `SessionManager` (`src/state.ts`), which tracks sessions across multiple CLI invocations. Each invocation creates or continues a session, persisting round artifacts and worktree hashes for stale-detection and finding comparison.

## Adding custom reviewers

Any CLI tool that accepts a prompt and produces output can be a reviewer. Implement the `Reviewer` interface:

```typescript
// src/reviewers/types.ts
interface Reviewer {
  name: string;
  review(prompt: string, scope: DiffScope): Promise<Finding[]>;
}
```

Or add a generic reviewer via config — any command with a `{prompt}` placeholder works:

```json
{
  "reviewers": {
    "my-linter": {
      "enabled": true,
      "command": "my-tool review \"{prompt}\"",
      "outputFormat": "json"
    }
  }
}
```

The consolidator normalizes different output formats into the standard findings schema. Custom reviewers registered in config are handled by the `GenericReviewer` class, which executes the command and parses the output.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Language | TypeScript | Target audience is devs. Types, state machines, JSON handling all better in TS. |
| Mode | Supervised only | User controls the loop — better fix accuracy, no autonomous mistakes. |
| Fixer | Orchestrator Claude | Wrote the code, has full context, can interact with user mid-fix. |
| Consolidation | CLI (deterministic code) | Dedup, P-level, pre-existing tagging. No LLM needed. |
| Session persistence | Session-based state with worktree hashes | Supports multi-invocation supervised loop. Round-scoped finding IDs prevent collisions. |
| Finding IDs | Round-scoped (`r1-f-001`) | Prevents collisions across review rounds. User can reference specific findings. |
| Finding comparison | LLM-based semantic matching (haiku) with heuristic fallback | Handles renamed files, shifted line numbers, reworded descriptions. Haiku is fast/cheap. Heuristic fallback ensures reliability. |
| Arguments | Natural language | Idiomatic for Claude Code skills. No `--flags`. LLM parses intent. |
| Severity | Two-axis (confidence × impact) → P0–P3 | Familiar P-levels as shorthand, nuanced classification underneath. |
| Pre-existing | Tag and exclude from recommendations | Reported but don't block. User can override in supervised mode. |
| Default threshold | P1 | Critical + functional issues recommended for fixing. Users extend via natural language. |

## Tests and evals

```bash
# Lint (type-check)
npm run lint

# Unit/integration tests (Vitest)
npm test

# Run all evals (LLM-as-judge against synthetic repos)
npm run eval

# Run a single eval fixture
npm run eval -- sql-injection

# Override the judge model
npm run eval -- --judge-model claude-sonnet-4-6
```

Tests cover deterministic components (scope detection, consolidator, config, session management, reviewer parser, finding comparison, worktree hashing, CLI subcommands) using TDD. LLM-facing components (reviewer adapters, orchestrator wiring) have integration tests. The eval harness uses synthetic repos with planted bugs and LLM-as-judge scoring for precision, recall, and severity accuracy.

## License

MIT
