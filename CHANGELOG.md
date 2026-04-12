# Changelog

## 0.1.0 (Unreleased)

### Added
- Multi-model code review orchestration (Claude + Codex in parallel)
- Supervised review loop with user-controlled fixing
- Two-axis severity classification (confidence × impact → P0-P3)
- Cross-round finding comparison via LLM semantic matching (haiku)
- Session persistence with worktree hash stale detection
- Pre-existing finding detection via diff hunk analysis
- Finding quality fields: expected/observed/evidence (optional)
- Design intent review via commit message context
- `review-orchestra setup` — first-time install and repair
- `review-orchestra doctor` — diagnose broken installs
- `review-orchestra review` — run reviewers and consolidate
- `review-orchestra stale` — check if files changed since last review
- `review-orchestra reset` — clear session state
- Cross-session finding storage (~/.review-orchestra/findings.jsonl)
- Real-time progress reporting (stderr + progress.json)
- Pluggable reviewer interface — any CLI tool can be a reviewer
- Natural language CLI arguments — no --flags needed
