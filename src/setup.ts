import {
  checkNodeVersion,
  checkPackageRoot,
  checkGit,
  checkCliOnPath,
  checkBinary,
  checkBinaryHealth,
  checkClaudeHome,
  checkSkillSymlink,
  checkSchemaFile,
  checkGitignore,
} from "./checks.js";
import type { CheckResult } from "./checks.js";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  appendFileSync,
  realpathSync,
  lstatSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";

// --- Fix action functions ---
// These are the ONLY side-effect functions in setup.

/**
 * Create the skill symlink at ~/.claude/skills/review-orchestra → <packageRoot>/skill.
 * If the symlink already exists but is stale (realpathSync mismatch), removes and recreates it.
 * Creates ~/.claude/skills/ directory if it doesn't exist.
 */
function createSkillSymlink(packageRoot: string): void {
  const skillsDir = join(homedir(), ".claude", "skills");
  const symlinkPath = join(skillsDir, "review-orchestra");
  const target = join(packageRoot, "skill");

  // Create ~/.claude/skills/ if missing
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
  }

  // Detect what (if anything) is at the symlink path. lstatSync (not
  // existsSync) is required so broken symlinks are still seen — otherwise
  // existsSync follows the link and returns false, leaving the stale link
  // in place and causing symlinkSync to EEXIST.
  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(symlinkPath);
  } catch {
    // Path doesn't exist — nothing to remove
  }

  if (existing) {
    if (!existing.isSymbolicLink()) {
      // A real file or directory occupies the symlink path. Refuse to
      // touch it — unlinkSync would throw EISDIR for directories, and
      // silently overwriting a real file the user put here would be a
      // surprise. Surface a clear error so the user can resolve manually.
      throw new Error(
        `Cannot create skill symlink at ${symlinkPath}: a non-symlink ${existing.isDirectory() ? "directory" : "file"} already exists there. Remove it manually and re-run setup.`,
      );
    }
    try {
      const actualReal = realpathSync(symlinkPath);
      const expectedReal = realpathSync(target);
      if (actualReal === expectedReal) {
        return; // Already correct — idempotent
      }
    } catch {
      // realpathSync failed — treat as stale/broken
    }
    // Remove stale or broken symlink
    unlinkSync(symlinkPath);
  }

  // Create new symlink
  symlinkSync(target, symlinkPath);
}

/**
 * Append .review-orchestra/ to .gitignore. Creates the file if it doesn't exist.
 */
function addToGitignore(): void {
  const gitignorePath = join(process.cwd(), ".gitignore");

  if (existsSync(gitignorePath)) {
    appendFileSync(gitignorePath, "\n.review-orchestra/\n");
  } else {
    appendFileSync(gitignorePath, ".review-orchestra/\n");
  }
}

// --- Checklist (same structure as doctor) ---

interface CheckEntry {
  label: string;
  run: () => CheckResult;
  /** Check names whose failure causes this check to be skipped */
  dependsOn?: string[];
  /** Name of the fixable check — matches values in the fix dispatch table */
  fixable?: string;
}

function buildChecklist(packageRoot: string): CheckEntry[] {
  return [
    {
      label: "Node version",
      run: () => checkNodeVersion(),
    },
    {
      label: "Package root",
      run: () => checkPackageRoot(packageRoot),
    },
    {
      label: "git",
      run: () => checkGit(),
    },
    {
      label: "review-orchestra on PATH",
      run: () => checkCliOnPath(),
    },
    {
      label: "claude binary",
      run: () => checkBinary("claude"),
    },
    {
      label: "codex binary",
      run: () => checkBinary("codex"),
    },
    {
      label: "claude health",
      run: () => checkBinaryHealth("claude"),
    },
    {
      label: "codex health",
      run: () => checkBinaryHealth("codex"),
    },
    {
      label: "~/.claude/",
      run: () => checkClaudeHome(),
    },
    {
      label: "Skill symlink",
      run: () => checkSkillSymlink(packageRoot),
      dependsOn: ["claude-home", "package-root"],
      fixable: "skill-symlink",
    },
    {
      label: "Schema file",
      run: () => checkSchemaFile(packageRoot),
      dependsOn: ["package-root"],
    },
    {
      label: ".gitignore",
      run: () => checkGitignore(),
      fixable: "gitignore",
    },
  ];
}

// --- Main setup function ---

/**
 * Run all checks and fix what can be fixed.
 * - Creates skill symlink when missing or stale
 * - Appends .review-orchestra/ to .gitignore when missing
 * - Reports unfixable failures with remediation hints
 * - Output to stderr with [setup] prefix
 * - Idempotent: safe to run repeatedly
 * - process.exit(0) if no failures remain, process.exit(1) if unfixable failures
 */
export async function runSetup(packageRoot: string): Promise<void> {
  const checklist = buildChecklist(packageRoot);
  const failedCheckNames = new Set<string>();
  let unfixableFailCount = 0;
  let warnCount = 0;
  let fixCount = 0;

  for (const entry of checklist) {
    // Check dependencies — skip if any dependency failed
    if (entry.dependsOn) {
      const depFailed = entry.dependsOn.some((dep) => failedCheckNames.has(dep));
      if (depFailed) {
        process.stderr.write(`[setup] ${entry.label}... SKIP (dependency failed)\n`);
        continue;
      }
    }

    const result: CheckResult = entry.run();

    // Track failed checks for dependency resolution
    if (result.status === "fail") {
      failedCheckNames.add(result.name);
    }

    // Attempt fix for fixable checks that failed or warned
    // (gitignore warns when entry is missing; skill-symlink fails when broken)
    if ((result.status === "fail" || result.status === "warn") && entry.fixable) {
      const fixed = attemptFix(entry.fixable, packageRoot);
      if (fixed) {
        fixCount++;
        // Remove from failed set — it's been fixed
        failedCheckNames.delete(result.name);
        continue;
      }
    }

    // Format output for non-fixable results
    if (result.status === "pass") {
      const detail = result.message ? ` (${result.message})` : "";
      process.stderr.write(`[setup] Checking ${entry.label}... OK${detail}\n`);
    } else if (result.status === "fail") {
      unfixableFailCount++;
      process.stderr.write(`[setup] Checking ${entry.label}... FAIL: ${result.message}\n`);
      if (result.remediation) {
        process.stderr.write(`        ${result.remediation}\n`);
      }
    } else if (result.status === "warn") {
      warnCount++;
      process.stderr.write(`[setup] Checking ${entry.label}... WARN: ${result.message}\n`);
      if (result.remediation) {
        process.stderr.write(`        ${result.remediation}\n`);
      }
    }
  }

  // Summary line
  process.stderr.write("\n");
  if (unfixableFailCount === 0 && warnCount === 0 && fixCount === 0) {
    process.stderr.write("Setup complete. All checks passed.\n");
  } else {
    const parts: string[] = [];
    if (fixCount > 0) {
      parts.push(`${fixCount} ${fixCount === 1 ? "issue" : "issues"} fixed`);
    }
    if (warnCount > 0) {
      parts.push(`${warnCount} ${warnCount === 1 ? "warning" : "warnings"}`);
    }
    if (unfixableFailCount > 0) {
      parts.push(`${unfixableFailCount} unfixable ${unfixableFailCount === 1 ? "failure" : "failures"}`);
    }
    process.stderr.write(`Setup complete. ${parts.join(", ")}.\n`);
  }

  process.exit(unfixableFailCount > 0 ? 1 : 0);
}

/**
 * Attempt to fix a known fixable issue.
 * Returns true if the fix was applied, false otherwise.
 */
function attemptFix(
  fixable: string,
  packageRoot: string,
): boolean {
  switch (fixable) {
    case "skill-symlink": {
      process.stderr.write(`[setup] Creating skill symlink... `);
      try {
        createSkillSymlink(packageRoot);
        // Re-run check to validate the fix actually worked
        const recheck = checkSkillSymlink(packageRoot);
        if (recheck.status !== "pass") {
          process.stderr.write(`FAIL: ${recheck.message}\n`);
          return false;
        }
        process.stderr.write("Done\n");
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`FAIL: ${msg}\n`);
        return false;
      }
    }
    case "gitignore": {
      process.stderr.write(`[setup] Adding .review-orchestra/ to .gitignore... `);
      try {
        addToGitignore();
        process.stderr.write("Done\n");
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`FAIL: ${msg}\n`);
        return false;
      }
    }
    default:
      return false;
  }
}
