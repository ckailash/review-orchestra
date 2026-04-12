# Open-Source Readiness Report

**Date:** 2026-04-12
**Package:** review-orchestra v0.1.0
**Target:** npm publish + public GitHub repository

---

## 1. First-Run Experience

**Status: FAIL**

| Check | Result |
|-------|--------|
| `npm install` works | PASS |
| `npm run build` produces dist/cli.js | PASS |
| dist/cli.js has shebang | PASS |
| `npm link` works (bin entry correct) | PASS |
| `review-orchestra setup` works | PASS |
| Getting-started flow clear | FAIL |

**Issues:**

- **README only shows clone-from-source workflow.** No `npm install -g` path. A user installing from npm would have no guidance.
  - `README.md:40-50` — restructure to show both npm global install and from-source workflows.
- **`review-orchestra setup` not mentioned in Installation section.** It auto-creates the skill symlink, validates environment, and checks binaries — but users are told to do a manual `ln -s` instead.
  - `README.md:46-50` — replace manual symlink instructions with `review-orchestra setup`.
- **No `prepublishOnly` script.** Publishing could ship stale/missing dist/.
  - `package.json` — add `"prepublishOnly": "npm run build"`.

---

## 2. README.md

**Status: PASS (with fixes needed)**

| Check | Result |
|-------|--------|
| Describes what the tool does | PASS |
| Architecture diagram | PASS |
| CLI examples correct | PASS |
| Skill invocation documented | PASS |
| Prerequisites listed | PASS |
| Configuration documented | PASS |
| Severity model documented | PASS |
| Installation instructions accurate | FAIL — see section 1 |

**Issues:**

- Installation section needs restructuring (see section 1).
- `--allowed-tools` in the example config should be `--allowedTools` to match canonical Claude Code CLI docs.
  - `README.md` line in Configuration section.

---

## 3. SKILL.md

**Status: PASS**

| Check | Result |
|-------|--------|
| Supervised flow makes sense | PASS |
| Step numbers clear and sequential | PASS |
| No references to non-existent features | PASS |
| LLM-followable instructions | PASS |

No issues found. The 7-step supervised flow accurately reflects actual CLI behavior. All referenced commands, flags, and JSON fields exist.

---

## 4. Configuration

**Status: PASS (minor fix)**

| Check | Result |
|-------|--------|
| config/default.json well-structured | PASS |
| findingComparison makes sense | PASS |
| Reviewer commands correct | PASS (minor) |

**Issues:**

- `config/default.json:5` — `--allowed-tools` should be `--allowedTools` per canonical Claude Code CLI docs. Both forms likely work, but the camelCase form is documented.
- `src/config.ts:30` — same change for the hardcoded default.

---

## 5. Package.json

**Status: FAIL**

| Check | Result |
|-------|--------|
| `bin` entry correct | PASS |
| `files` field set | FAIL — missing entirely |
| License field set (MIT) | PASS |
| LICENSE file exists | FAIL — missing |
| No unnecessary bundled deps | PASS (zero runtime deps, intentional) |
| `npm pack --dry-run` looks right | FAIL — 177 files, 1.4MB |
| Repository/homepage URL | FAIL — missing |
| prepublishOnly script | FAIL — missing |

**Critical issues:**

- **No `files` field.** `npm pack` includes 177 files (1.4MB) — ships `.factory/`, `.claude/`, `docs/`, `evals/`, `test/`, `src/`, and dev configs. Fix: add `"files": ["dist/", "config/", "prompts/", "schemas/", "skill/", "README.md", "LICENSE"]`.
- **No LICENSE file.** `package.json` declares MIT but there's no actual license text. Must create `LICENSE` with MIT text.
- **No `repository` field.** npm and GitHub won't link properly.
- **No `prepublishOnly` script.** Risk of publishing stale dist.

---

## 6. Code Quality

**Status: PASS (one fix needed)**

| Check | Result |
|-------|--------|
| TODO/FIXME/HACK comments | PASS — zero found |
| Hardcoded author paths in src/ | PASS — none |
| Hardcoded author paths in test/ | FAIL — 26 occurrences |
| API keys/tokens/secrets | PASS — none |
| Console.log debugging | PASS — all intentional |
| Commented-out code | PASS — none |
| Personal information | PASS — none |

**Issues:**

- **`test/findings-store.test.ts`** — 26 occurrences of `/tmp/test-project` and similar author-specific paths in test fixtures. Replace with generic paths like `/tmp/test-project`.

---

## 7. Documentation Gaps

**Status: FAIL**

| Check | Result |
|-------|--------|
| CONTRIBUTING.md exists | FAIL — missing |
| CHANGELOG.md exists | FAIL — missing |
| CODE_OF_CONDUCT.md exists | FAIL — missing |
| LICENSE file exists | FAIL — missing |
| docs/plans/ useful for contributors | MIXED |
| docs/research/ appropriate for public | FAIL — competitive analysis |
| docs/audit-report.md appropriate for public | WARN — internal audit |

**Critical issues:**

- **No LICENSE file.** Must create MIT license.
- **No CONTRIBUTING.md.** Standard for open-source projects.

**Non-blocking issues:**

- `docs/research/` contains competitive analysis of rival tools (Cook, Trycycle). Not appropriate for a public repo. Should be removed or excluded from publishing.
- `docs/audit-report.md` is an internal pre-release audit. Low value for contributors.
- `docs/plans/` — `architecture.md` and `supervised-flow.md` are valuable. Other completed plans are marginal.
- No CHANGELOG.md (low priority for v0.1.0).

---

## 8. .gitignore Completeness

**Status: FAIL**

| Check | Result |
|-------|--------|
| `.factory/` gitignored | FAIL — not ignored, 71 files tracked |
| `.claude/` fully gitignored | FAIL — 2 files tracked (CLAUDE.md, settings.json) |
| `.review-orchestra/` gitignored | PASS |
| `.DS_Store` ignored | FAIL — missing |
| `.env` ignored | FAIL — missing |
| `coverage/` ignored | FAIL — missing |

**Critical issues:**

- **`.factory/` not in .gitignore** and 71 files are tracked. This is a Factory-internal directory that must not ship in a public repo. Fix: add `.factory/` to .gitignore and `git rm -r --cached .factory/`.
- **`.claude/settings.json` tracked in git.** Contains developer-specific tool permissions. Fix: add to .gitignore and untrack.

**Non-critical issues:**

- Missing common patterns: `.DS_Store`, `.env`, `.env.*`, `*.log`, `coverage/`.

---

## Summary

### Blocking (must fix before release)

| # | Issue | File(s) |
|---|-------|---------|
| 1 | No `files` field in package.json — npm publishes 177 files | `package.json` |
| 2 | No LICENSE file | repo root |
| 3 | `.factory/` not gitignored, 71 files tracked | `.gitignore` |
| 4 | Author-specific paths in test fixtures | `test/findings-store.test.ts` |
| 5 | `.claude/settings.json` tracked | `.gitignore` |
| 6 | No CONTRIBUTING.md | repo root |
| 7 | No `repository` field in package.json | `package.json` |
| 8 | No `prepublishOnly` build script | `package.json` |
| 9 | README installation section incomplete | `README.md` |

### Non-blocking (recommended)

| # | Issue | File(s) |
|---|-------|---------|
| 10 | `--allowed-tools` → `--allowedTools` flag casing | `config/default.json`, `src/config.ts` |
| 11 | `docs/research/` contains competitive analysis | `docs/research/` |
| 12 | Missing .gitignore patterns (.DS_Store, .env, coverage/) | `.gitignore` |
| 13 | `docs/plans/learnings-and-visibility.md` has author path in example | `docs/plans/` |
| 14 | No CHANGELOG.md | repo root |
