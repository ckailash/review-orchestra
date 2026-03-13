# review-orchestra

Multi-model automated code review orchestration for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Runs multiple AI reviewers (Claude + Codex by default) in parallel, consolidates findings, spawns a fixer agent, re-reviews, and loops until the code is clean. The human only gets involved for ambiguous decisions.

## How it works

```
          +-------------------+
          |  Detect Scope     |  git diff / branch diff / PR diff
          +--------+----------+
                   |
          +--------v----------+
     +--->|  Parallel Review   |  Claude + Codex (headless, concurrent)
     |    +--------+----------+
     |             |
     |    +--------v----------+
     |    |  Consolidate       |  Dedup, classify confidence x impact, compute P-level
     |    +--------+----------+
     |             |
     |    +--------v----------+
     |    |  Stop Condition    |  No P0/P1 findings remaining?
     |    +--------+----------+
     |         |         |
     |        yes        no
     |         |         |
     |    +----v---+  +--v-----------+
     |    | Report |  | Fix (headless |
     |    +--------+  |  Claude)      |
     |                +--+-----------+
     |                   |
     +-------------------+  (re-review with fresh instances)
```

1. **Scope detection** -- auto-detects uncommitted changes, branch diff vs main, or open PR diff.
2. **Parallel review** -- launches all configured reviewers as headless CLI processes concurrently.
3. **Consolidation** -- deduplicates findings across reviewers, classifies each on two axes (confidence x impact), computes a P-level (P0--P3), and tags pre-existing issues outside the diff.
4. **Stop condition** -- stops when no actionable findings remain at or above the threshold (default: P1). Pre-existing findings are reported but never block.
5. **Fix** -- spawns a separate headless Claude to fix all actionable findings. The fixer edits files in place.
6. **Re-review** -- loops back to step 2 with fresh reviewer instances. Safety valve: max 5 rounds (configurable).
7. **Escalation** -- pauses the loop and surfaces ambiguous findings, conflicting reviewer opinions, or architectural decisions to the user.
8. **Handoff** -- reports a summary and suggests the next action (commit, push, create PR, or merge).

## Installation

### Prerequisites

- Node.js >= 20
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
- [Codex CLI](https://github.com/openai/codex) (`codex`) -- optional, can be disabled

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

Invoke via the `/review-orchestra` skill in Claude Code. Arguments are natural language -- no flags.

```
/review-orchestra                                  # auto-detect scope, all defaults
/review-orchestra src/auth/ src/api/               # only review these paths
/review-orchestra fix quality issues too            # extend fix threshold to P2
/review-orchestra only use claude, max 3 rounds    # single reviewer, custom round limit
/review-orchestra skip codex                       # disable a specific reviewer
```

**Defaults** (when no arguments are provided):
- Auto-detect diff scope
- Both Claude + Codex reviewers
- Stop at P1 (all critical + functional issues fixed)
- Max 5 rounds
- Pause on ambiguity

### State artifacts

All round data is stored in `.review-orchestra/` in the project root:

```
.review-orchestra/
├── state.json
├── round-1/
│   ├── claude-review.json
│   ├── codex-review.json
│   ├── consolidated.json
│   └── fix-report.json
├── round-2/
│   └── ...
└── summary.json
```

Add `.review-orchestra/` to your `.gitignore`. Delete it when you're done: `rm -rf .review-orchestra/`.

## Configuration

Configuration lives in `config/default.json`:

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

### Thresholds

| Setting | Default | Description |
|---|---|---|
| `stopAt` | `p1` | Stop looping when no findings at or above this level remain. `p0` = critical only, `p1` = critical + functional, `p2` = + quality, `p3` = fix everything. |
| `maxRounds` | `5` | Safety valve. Loop exits after this many rounds regardless of remaining findings. |

### Severity model

Findings are classified on two independent axes, then a P-level is derived:

| | Critical | Functional | Quality | Nitpick |
|---|---|---|---|---|
| **Verified** | P0 | P1 | P2 | P3 |
| **Likely** | P0 | P1 | P2 | P3 |
| **Possible** | P1 | P2 | P3 | P3 |
| **Speculative** | P2 | P3 | P3 | P3 |

Pre-existing findings (outside the diff hunks) are tagged and excluded from the stop condition.

## Adding custom reviewers

Any CLI tool that accepts a prompt and produces output can be a reviewer. Implement the `Reviewer` interface:

```typescript
// src/reviewers/types.ts
interface Reviewer {
  name: string;
  review(prompt: string, scope: DiffScope): Promise<Finding[]>;
}
```

Or add a generic reviewer via config -- any command with a `{prompt}` placeholder works:

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

Tests cover deterministic components (scope detection, consolidator, config, state, reviewer parser) using TDD. LLM-facing components (orchestrator loop, fixer, escalation) have integration tests. The eval harness uses synthetic repos with planted bugs and LLM-as-judge scoring for precision, recall, severity accuracy, and fix success.

## License

MIT
