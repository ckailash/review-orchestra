import {
  checkNodeVersion,
  checkPackageRoot,
  checkGit,
  checkCliOnPath,
  checkBinary,
  checkAuth,
  checkClaudeHome,
  checkSkillSymlink,
  checkSchemaFile,
  checkGitignore,
} from "./checks.js";
import type { CheckResult } from "./checks.js";

// --- Display name mapping ---
// Maps check names to human-friendly labels for the [doctor] output.

interface CheckEntry {
  label: string;
  run: () => CheckResult;
  /** Check names whose failure causes this check to be skipped */
  dependsOn?: string[];
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
      label: "claude auth",
      run: () => checkAuth("claude"),
    },
    {
      label: "codex auth",
      run: () => checkAuth("codex"),
    },
    {
      label: "~/.claude/",
      run: () => checkClaudeHome(),
    },
    {
      label: "Skill symlink",
      run: () => checkSkillSymlink(packageRoot),
      dependsOn: ["claude-home", "package-root"],
    },
    {
      label: "Schema file",
      run: () => checkSchemaFile(packageRoot),
      dependsOn: ["package-root"],
    },
    {
      label: ".gitignore",
      run: () => checkGitignore(),
    },
  ];
}

// --- Output formatting ---

function formatStatus(status: "pass" | "fail" | "warn"): string {
  switch (status) {
    case "pass":
      return "PASS";
    case "fail":
      return "FAIL";
    case "warn":
      return "WARN";
  }
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

// --- Main doctor function ---

/**
 * Run all checks and report results to stderr.
 * Respects check dependencies: skip checks whose preconditions fail.
 * Exits 0 if all pass/warn-only, exits 1 if any check fails.
 */
export async function runDoctor(packageRoot: string): Promise<void> {
  const checklist = buildChecklist(packageRoot);
  const failedCheckNames = new Set<string>();
  let failCount = 0;
  let warnCount = 0;

  for (const entry of checklist) {
    // Check dependencies — skip if any dependency failed
    if (entry.dependsOn) {
      const depFailed = entry.dependsOn.some((dep) => failedCheckNames.has(dep));
      if (depFailed) {
        process.stderr.write(`[doctor] ${entry.label}: SKIP (dependency failed)\n`);
        continue;
      }
    }

    const result: CheckResult = entry.run();

    // Track failed checks for dependency resolution
    if (result.status === "fail") {
      failedCheckNames.add(result.name);
      failCount++;
    } else if (result.status === "warn") {
      warnCount++;
    }

    // Format output line
    const statusStr = formatStatus(result.status);
    const messagePart = result.status === "pass" ? ` (${result.message})` : ` — ${result.message}`;
    process.stderr.write(`[doctor] ${entry.label}: ${statusStr}${messagePart}\n`);

    // Show remediation for non-passing checks
    if (result.remediation && result.status !== "pass") {
      process.stderr.write(`         Fix: ${result.remediation}\n`);
    }
  }

  // Summary line
  process.stderr.write("\n");
  if (failCount === 0 && warnCount === 0) {
    process.stderr.write("All checks passed.\n");
  } else {
    const parts: string[] = [];
    if (failCount > 0) {
      parts.push(`${failCount} ${plural(failCount, "failure", "failures")}`);
    }
    if (warnCount > 0) {
      parts.push(`${warnCount} ${plural(warnCount, "warning", "warnings")}`);
    }
    const summary = parts.join(", ");
    if (failCount > 0) {
      process.stderr.write(`${summary}. Run 'review-orchestra setup' to fix.\n`);
    } else {
      process.stderr.write(`${summary}.\n`);
    }
  }

  process.exit(failCount > 0 ? 1 : 0);
}
