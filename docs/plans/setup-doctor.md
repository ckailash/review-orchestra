# Setup + Doctor Commands — Feature Plan

**Status:** Complete
**Priority:** Phase C — parallelisable with supervised flow
**Written:** 2026-03-30

---

## Problem

Getting review-orchestra running requires installing the package, and symlinking `skill/` into `~/.claude/skills/review-orchestra`. None of this is documented well enough for someone who isn't the author. When something breaks — a binary goes missing after an upgrade, the symlink gets stale, Node drops below v20 — there's no way to diagnose the issue short of reading the source.

The existing `src/preflight.ts` runs binary validation at orchestration start, but it's coupled to the review pipeline (takes a `Config` object, checks reviewer commands). It doesn't cover the full install surface (symlink, Node version, `.gitignore`) and it can't be run standalone.

Two commands fix this:
- **`setup`** — gets a new user from zero to running, or repairs a broken install
- **`doctor`** — tells you what's wrong and how to fix it, without touching anything

### Install modes

There are two install modes. Both must put `review-orchestra` on PATH because the skill invokes it as a bare command (`review-orchestra $ARGUMENTS` in SKILL.md).

| Mode | Steps | Who |
|------|-------|-----|
| **npm global** | `npm install -g review-orchestra` | End users |
| **Local clone** | `git clone` → `npm install` → `npm link` | Contributors / development |

`npm install -g` registers the `bin` entry from `package.json` onto PATH automatically. For local clones, `npm link` is required — plain `npm install` installs deps but doesn't create the PATH symlink. The `setup` command validates this (see `cli-on-path` check below) and tells the user what to run if the binary isn't reachable.

**Local clone without `npm link` is a developer error, not a supported state.** Setup detects it and provides the fix command; it cannot fix it automatically (requires elevated permissions on some systems).

**Limitation of the `cli-on-path` check:** The check uses `which` to resolve the binary, which reflects the current process's PATH. This can false-pass if setup itself is run via `npx`, a temporary shell wrapper, or any context that injects PATH entries that won't be present when the skill invokes `review-orchestra` later. This is a known limitation — there is no reliable way to predict what PATH Claude Code's skill runner will see at invocation time. The check catches the common failure mode (clone without link) but is not a guarantee. The check's remediation hint notes this: "Ensure review-orchestra is installed globally or linked, not just available via npx."

## Design

### Shared check infrastructure

Both commands run the same checks. A check is a pure function that inspects one aspect of the install and returns a structured result:

```typescript
type CheckStatus = "pass" | "fail" | "warn";

interface CheckResult {
  name: string;           // e.g. "node-version", "skill-symlink"
  status: CheckStatus;
  message: string;        // human-readable: what was found
  remediation?: string;   // how to fix (only on fail/warn)
}
```

The check functions are stateless and side-effect-free. They read the environment (PATH, filesystem, process.version) but never modify it.

### Check catalogue

| Check | Pass | Fail | Warn |
|-------|------|------|------|
| **node-version** | Node >= 20 | Node < 20 or not found | — |
| **package-root** | `package.json` found at resolved root | Not found (corrupted install) | — |
| **git-on-path** | `git` resolves via `which` | Not found | — |
| **cli-on-path** | `review-orchestra` resolves via `which` | Not found — skill invokes bare `review-orchestra` | — |
| **claude-binary** | `claude` resolves via `which` | Not found | — |
| **codex-binary** | `codex` resolves via `which` | — | Not found (under default config, reviews will use claude only) |
| **claude-auth** | `claude --version` exits 0 | Non-zero exit or timeout | — |
| **codex-auth** | `codex --version` exits 0 | — | Non-zero exit (codex won't be usable) |
| **claude-home** | `~/.claude/` directory exists | Not found (Claude Code not installed) | — |
| **skill-symlink** | `~/.claude/skills/review-orchestra` exists and resolves (via `realpathSync`) to a valid `skill/` dir containing `SKILL.md` | Missing or broken | — |
| **schema-file** | `schemas/findings.schema.json` exists at package root | — | Missing (codex reviewer will fail at runtime) |
| **gitignore** | `.review-orchestra/` is in project `.gitignore` | — | Missing (only checked when inside a git repo) |

**codex checks are warnings, not failures — under the default config.** Codex is optional when claude is also enabled. A missing codex degrades functionality but doesn't block usage. Note: at runtime, if the user passes `only use codex` and codex is missing, `preflight.ts` correctly escalates to a failure (zero remaining reviewers). Setup/doctor check the default install surface, not user-specific invocation flags.

**Auth checks are lightweight.** Running `claude --version` and `codex --version` verifies the binary executes without errors. We don't test actual API auth (that would require network calls and API keys). If either command hangs, a 5-second timeout treats it as a failure.

**claude-home is a precondition of skill-symlink.** If `~/.claude/` doesn't exist, that's a sign Claude Code isn't installed. Setup reports a clear error with an install hint rather than attempting to create the directory structure speculatively. The skill-symlink check is skipped when claude-home fails.

**package-root validation.** The package root is resolved from `import.meta.url` (same as `cli.ts`). The check verifies `package.json` exists at the resolved path. If it doesn't — e.g. someone copied `dist/cli.js` outside the package tree — setup/doctor report: "Could not find package root. Ensure review-orchestra was installed via npm or npm link." Checks that depend on package root (skill-symlink, schema-file) are skipped when this fails.

**gitignore check only runs inside a git repo.** `setup` might be run globally (before cloning any project). The `.gitignore` check skips gracefully when there's no `.git` directory.

**No default-config check.** `config/default.json` is optional — `src/config.ts` falls back to in-code `DEFAULT_CONFIG` when the file is missing or unparseable. Checking or recreating it would be inconsistent with runtime behavior and would fail on global installs where the package tree may be read-only.

### Command behaviour

**`setup`** runs all checks, then fixes what it can:

| Check failed | Setup action |
|-------------|-------------|
| node-version too low | Report error, cannot fix |
| package-root not found | Report error, cannot fix |
| git not found | Report error, cannot fix |
| cli-on-path not found | Report error with hint: `npm install -g review-orchestra` (global) or `npm link` (local clone) |
| claude not found | Report error with install hint |
| codex not found | Report warning with install hint |
| claude-auth fails | Report error with hint |
| codex-auth fails | Report warning with hint |
| claude-home missing | Report error: "Install Claude Code first" with link |
| skill-symlink missing | Create `~/.claude/skills/review-orchestra` → `<package-root>/skill` |
| schema-file missing | Report warning (suggests reinstall — file should be in the package) |
| gitignore missing entry | Append `.review-orchestra/` to `.gitignore` (creates file if needed) |

Setup is **idempotent** — running it twice does no harm. Each action checks preconditions before acting:
- Symlink already exists and resolves to the right place (via `realpathSync`)? Skip.
- `.gitignore` already contains `.review-orchestra/`? Skip.

Output format (stderr):
```
[setup] Checking Node version... OK (v22.3.0)
[setup] Checking package root... OK
[setup] Checking git... OK
[setup] Checking review-orchestra on PATH... OK
[setup] Checking claude binary... OK
[setup] Checking codex binary... WARN: not found (npm install -g @openai/codex)
[setup] Checking ~/.claude/... OK
[setup] Creating skill symlink... Done
[setup] Checking schema file... OK
[setup] Adding .review-orchestra/ to .gitignore... Done

Setup complete. 1 warning (codex not found — reviews will use claude only).
```

Exit 0 if no failures (warnings are acceptable). Exit 1 if any check is `fail` and setup couldn't fix it.

**`doctor`** runs all checks and reports. It never modifies anything.

Output format (stderr):
```
[doctor] Node version: PASS (v22.3.0)
[doctor] Package root: PASS
[doctor] git: PASS
[doctor] review-orchestra on PATH: PASS
[doctor] claude binary: PASS
[doctor] codex binary: WARN — not found
         Fix: npm install -g @openai/codex
[doctor] claude auth: PASS
[doctor] ~/.claude/: PASS
[doctor] Skill symlink: FAIL — missing
         Fix: review-orchestra setup
[doctor] Schema file: PASS
[doctor] .gitignore: WARN — .review-orchestra/ not listed
         Fix: review-orchestra setup

1 failure, 1 warning. Run 'review-orchestra setup' to fix.
```

Exit 0 if all pass (warnings are acceptable). Exit 1 if any check is `fail`.

### Symlink handling

The skill symlink target is `<package-root>/skill` where `<package-root>` is the directory containing `package.json`. This works for both install methods:

- **npm global install** (`npm install -g review-orchestra`): package-root is wherever npm installs global packages (e.g. `/usr/local/lib/node_modules/review-orchestra`)
- **Local clone** (`git clone` + `npm link`): package-root is the clone directory

The setup command resolves the package root at runtime using the same approach as `cli.ts` (walking up from `import.meta.url` or `__dirname`). It does not hardcode paths.

If `~/.claude/skills/` doesn't exist, setup creates it. The `claude-home` check (see check catalogue) must pass first — if `~/.claude/` doesn't exist, setup reports an error with a Claude Code install hint rather than creating the directory structure speculatively.

**Validation uses `realpathSync`, not raw link text.** When checking an existing symlink, both the actual target and expected target are resolved to their real paths via `fs.realpathSync()` before comparison. This correctly handles:
- Relative symlinks (`../../review-orchestra/skill`)
- Symlinks through intermediate directory links
- Paths with `..` segments

If the resolved real paths don't match (e.g. user switched from clone to npm global), setup removes the stale symlink and creates a new one. Doctor reports it as a failure with the stale target path and the expected target path.

### Relationship to preflight.ts

`preflight.ts` currently validates reviewer binaries at orchestration start. It takes a `Config` and checks that each enabled reviewer's command binary exists on PATH. This is a subset of what the new checks cover.

**Plan: refactor preflight to import shared helpers from `checks.ts`, but keep preflight's config-driven logic intact.**

After the check functions exist, `preflight.ts` can delegate its low-level binary validation to them. However:
- Preflight is called with a `Config` — it checks the *configured* reviewers, not a hardcoded list
- The new checks validate `claude` and `codex` by name — they don't know about custom reviewers or command overrides
- Preflight's "disable reviewer and continue" behaviour is specific to the review pipeline
- A reviewer named "claude" might have a custom command (`/opt/custom/my-claude -p ...`), so checking by reviewer name instead of by extracted binary would silently miss the real command

**Approach:** `checks.ts` exports low-level helpers — `binaryExists(binary: string): boolean` and the `VALID_BINARY_PATTERN` constant. `preflight.ts` imports these instead of defining its own copies. Preflight continues to call `extractBinary()` on each reviewer's configured command and passes the result to the shared `binaryExists()`. No special-casing by reviewer name.

The setup/doctor checks (`checkBinary("claude")`, `checkBinary("codex")`) use these same helpers internally but are hardcoded to the default binary names — they check the default install surface, not the user's runtime config. This is intentional: setup/doctor answers "is the default toolchain installed?", not "will your specific config work?" (that's preflight's job).

This refactor is **step 7** in implementation order — done last, after both commands work, to avoid breaking the existing pipeline during development.

### CLI routing

Add `setup` and `doctor` as subcommands in `cli.ts`. **Subcommand dispatch must happen before `parseArgs()` and `detectScope()`** — these assume review-mode context and will misinterpret or fail for setup/doctor.

The dispatch logic checks `process.argv[2]` as the first step in `main()`:

```typescript
const subcommand = process.argv[2];

if (subcommand === "setup") {
  await runSetup(PACKAGE_ROOT);
  return;
}
if (subcommand === "doctor") {
  await runDoctor(PACKAGE_ROOT);
  return;
}

// Existing flow: parseArgs, loadConfig, detectScope, orchestrate
const rawArgs = process.argv.slice(2).join(" ").trim();
const args = parseArgs(rawArgs);
// ...
```

**Bare invocation must remain the supervised default.** The skill invokes `review-orchestra $ARGUMENTS` (SKILL.md:14) — with no subcommand, natural-language args go straight to `parseArgs()`. Introducing subcommands must not break this. `setup` and `doctor` are intercepted before `parseArgs()` because they must not enter the review pipeline at all.

**Note on current state:** `cli.ts` currently has no subcommand dispatcher. All args go through `parseArgs()` which handles natural-language review arguments, not subcommands. The `review`, `stale`, `reset`, and `auto` subcommands listed in the architecture doc (architecture.md:307-314) are planned but not yet implemented. This plan adds `setup` and `doctor` as the first dispatched subcommands. A full subcommand dispatcher (covering `review`, `stale`, `reset`, `auto`) is a separate task — for now, anything that isn't `setup` or `doctor` falls through to the existing `parseArgs()` flow.

```
review-orchestra setup     # NEW: first-time install + repair
review-orchestra doctor    # NEW: diagnose issues
review-orchestra review    # planned: run reviewers + consolidate (architecture.md)
review-orchestra stale     # planned: check worktree freshness (architecture.md)
review-orchestra reset     # planned: clear session (architecture.md)
review-orchestra auto      # planned: autonomous loop (architecture.md)
review-orchestra <args>    # bare invocation = current behavior (parseArgs + review)
```

`setup` and `doctor` work outside of a git repo. They do not call `parseArgs()`, `detectScope()`, or `loadConfig()`.

## Implementation order

1. **`src/checks.ts`** — shared check functions and low-level helpers. Exports:
   - Low-level: `binaryExists(binary: string): boolean`, `VALID_BINARY_PATTERN`
   - Checks: `checkNodeVersion()`, `checkPackageRoot(packageRoot)`, `checkGit()`, `checkCliOnPath()`, `checkBinary(name)`, `checkAuth(binary)`, `checkClaudeHome()`, `checkSkillSymlink(packageRoot)`, `checkSchemaFile(packageRoot)`, `checkGitignore()`
   - All checks return `CheckResult`. Pure reads, no side effects.
   - `checkSkillSymlink` uses `fs.realpathSync()` to compare resolved paths, not raw link text.
   - `checkClaudeHome` is a precondition of `checkSkillSymlink` — callers skip the symlink check if claude-home fails.
   - `checkPackageRoot` verifies `package.json` exists at the resolved root — callers skip dependent checks (symlink, schema) if this fails.

2. **`test/checks.test.ts`** — TDD. Write tests first for every check function. Mock `which`, `execFileSync`, `fs.existsSync`, `fs.readlinkSync`, `fs.realpathSync`, `fs.readFileSync`, `process.version`. Cover: pass cases, fail cases, warn cases, edge cases (stale symlink via realpath mismatch, relative symlinks that resolve correctly, gitignore with comments, no git repo, missing `~/.claude/`, missing `package.json` at root).

3. **`src/doctor.ts`** — runs all checks, formats output, sets exit code. Respects check dependencies (skips symlink if claude-home failed, skips symlink/schema if package-root failed).

4. **`test/doctor.test.ts`** — TDD. Tests verify: all-pass produces exit 0, any fail produces exit 1, warnings alone produce exit 0, output format includes remediation for failures, dependent checks skipped when precondition fails. Mock the check functions (not the underlying system calls — doctor's job is formatting, not checking).

5. **`src/setup.ts`** — runs all checks, then performs fix actions for fixable failures. Each fix action is a separate function: `createSkillSymlink()`, `addToGitignore()`. No `ensureConfig()` — config is optional with in-code defaults. Tests verify idempotency.

6. **`test/setup.test.ts`** — TDD. Tests verify: creates symlink when missing, skips symlink when present and valid (realpath match), replaces stale symlink (realpath mismatch), appends to gitignore, doesn't duplicate gitignore entry, reports unfixable failures (node, git, cli-on-path, claude-home), exit codes. No config-related tests.

7. **Refactor `src/preflight.ts`** — import `binaryExists` and `VALID_BINARY_PATTERN` from `checks.ts`. Remove the local copies. Preflight continues to use `extractBinary()` on configured commands — no special-casing by reviewer name. Verify existing `test/preflight.test.ts` still passes. No behaviour change.

8. **Wire into `src/cli.ts`** — add `setup` and `doctor` subcommand dispatch as the **first check** in `main()`, before `parseArgs()`. Bare invocation (no subcommand) continues into the existing review flow unchanged.

9. **Rebuild, lint, test** — `npm run build && npm run lint && npm test`.

## What this does NOT change

- Review pipeline — `setup` and `doctor` are standalone commands, they don't affect `review`, `auto`, `stale`, or `reset`
- Reviewer adapters — unchanged
- Consolidation — unchanged
- Scope detection — unchanged
- State management — unchanged
- Config loading for reviews — `loadConfig()` in `config.ts` is unchanged. `checks.ts` does not inspect config at all — it checks the default install surface, not reviewer settings
- Existing tests — no existing test should break. `preflight.test.ts` continues to pass after the step 7 refactor (only internal imports change, not behavior)

## Testing strategy

All three new source files are deterministic (no LLM calls, no network beyond `which`). TDD applies.

| Test file | What it covers | Approach |
|-----------|---------------|----------|
| `test/checks.test.ts` | Each check function in isolation | Mock system calls (`which`, `fs.existsSync`, `fs.realpathSync`, `fs.readlinkSync`, `fs.readFileSync`, `process.version`). Every check has pass/fail/warn cases. Edge cases: stale symlinks (realpath mismatch), relative symlinks that resolve correctly, gitignore with existing entries, missing `.git` dir, missing `~/.claude/`, missing `package.json` at root, `review-orchestra` not on PATH. |
| `test/doctor.test.ts` | Doctor command output formatting, exit codes, and check dependency skipping | Mock the check functions (inject `CheckResult[]`). Verify stderr output format, exit code logic (0 for all-pass/warn-only, 1 for any fail). Verify dependent checks are skipped when preconditions fail (e.g., symlink skipped when claude-home fails). |
| `test/setup.test.ts` | Setup fix actions and idempotency | Mock fs operations (`mkdirSync`, `symlinkSync`, `unlinkSync`, `appendFileSync`, etc.) and check functions. Verify: each action called when check fails, not called when check passes. Verify idempotency: stale symlink replaced (realpath comparison), gitignore entry not duplicated. No config-related tests. |
| `test/preflight.test.ts` | Existing tests still pass after refactor | No new tests needed — existing coverage validates the refactor didn't break anything. Only the import source changes (from local to `checks.ts`). |

### What's NOT tested

- Actual system state (real symlinks, real binaries) — that's integration/e2e territory. The check functions are thin wrappers around system calls; mocking the calls is sufficient.
- Auth check timeout behaviour — difficult to test reliably in unit tests. Verified manually during dogfood.
- Runtime config interactions (e.g., "only use codex" with codex missing) — that's preflight's domain, already covered by `test/preflight.test.ts`.

## File-level changes summary

### New files
| File | Purpose |
|------|---------|
| `src/checks.ts` | Shared check functions (all checks, `CheckResult` type) |
| `src/setup.ts` | Setup command (runs checks + fixes) |
| `src/doctor.ts` | Doctor command (runs checks + reports) |
| `test/checks.test.ts` | TDD tests for check functions |
| `test/setup.test.ts` | TDD tests for setup actions |
| `test/doctor.test.ts` | TDD tests for doctor reporting |

### Modified files
| File | Change |
|------|--------|
| `src/cli.ts` | Add `setup` and `doctor` subcommand dispatch as first check in `main()`, before `parseArgs()` |
| `src/preflight.ts` | Import `binaryExists` and `VALID_BINARY_PATTERN` from `checks.ts`, remove local copies (step 7, after commands work) |
