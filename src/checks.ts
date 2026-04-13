import { execFileSync } from "child_process";
import { existsSync, readFileSync, realpathSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// --- Types ---

export type CheckStatus = "pass" | "fail" | "warn";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  remediation?: string;
}

// --- Low-level helpers ---

/**
 * Regex for validating binary names — rejects shell metacharacters.
 * Matches names containing only alphanumerics, dots, underscores, hyphens, and slashes.
 */
export const VALID_BINARY_PATTERN = /^[a-zA-Z0-9._\-/]+$/;

/**
 * Check whether a binary exists on PATH using `which`.
 * Returns false for invalid binary names (shell metacharacters).
 */
export function binaryExists(binary: string): boolean {
  if (!VALID_BINARY_PATTERN.test(binary)) return false;
  try {
    execFileSync("which", [binary], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// --- Check functions ---
// All return CheckResult. Pure reads, no side effects.

/**
 * Check that the current Node.js version is >= 22.
 */
export function checkNodeVersion(): CheckResult {
  const version = process.version;
  const major = parseInt(version.slice(1).split(".")[0], 10);
  if (major >= 22) {
    return {
      name: "node-version",
      status: "pass",
      message: `Node ${version}`,
    };
  }
  return {
    name: "node-version",
    status: "fail",
    message: `Node ${version} — requires >= 22`,
    remediation: "Install Node.js 22 or later: https://nodejs.org/",
  };
}

/**
 * Check that package.json exists at the given package root.
 */
export function checkPackageRoot(packageRoot: string): CheckResult {
  const pkgPath = join(packageRoot, "package.json");
  if (existsSync(pkgPath)) {
    return {
      name: "package-root",
      status: "pass",
      message: `package.json found at ${packageRoot}`,
    };
  }
  return {
    name: "package-root",
    status: "fail",
    message: "package.json not found at package root",
    remediation:
      "Ensure review-orchestra was installed via npm or npm link.",
  };
}

/**
 * Check that git is on PATH.
 */
export function checkGit(): CheckResult {
  if (binaryExists("git")) {
    return {
      name: "git",
      status: "pass",
      message: "git found on PATH",
    };
  }
  return {
    name: "git",
    status: "fail",
    message: "git not found on PATH",
    remediation: "Install git: https://git-scm.com/",
  };
}

/**
 * Check that review-orchestra is on PATH.
 */
export function checkCliOnPath(): CheckResult {
  if (binaryExists("review-orchestra")) {
    return {
      name: "cli-on-path",
      status: "pass",
      message: "review-orchestra found on PATH",
    };
  }
  return {
    name: "cli-on-path",
    status: "fail",
    message: "review-orchestra not found on PATH",
    remediation:
      "Install globally: npm install -g review-orchestra, or link locally: npm link. Ensure it is not just available via npx.",
  };
}

/**
 * Check whether a named binary (claude or codex) exists on PATH.
 * For codex: missing is a warning (optional). For everything else: missing is a failure.
 */
export function checkBinary(name: string): CheckResult {
  const found = binaryExists(name);
  if (found) {
    return {
      name: `${name}-binary`,
      status: "pass",
      message: `${name} found on PATH`,
    };
  }

  // codex is optional — warn instead of fail
  const status: CheckStatus = name === "codex" ? "warn" : "fail";

  const hints: Record<string, string> = {
    claude:
      "Install from https://docs.anthropic.com/en/docs/claude-code",
    codex: "Install with: npm install -g @openai/codex",
  };

  return {
    name: `${name}-binary`,
    status,
    message: `${name} not found on PATH`,
    remediation: hints[name] ?? `Install ${name} and ensure it is on PATH.`,
  };
}

/**
 * Check binary health by running `<binary> --version` with a 5-second timeout.
 * Pass if exit 0. For claude: fail on error/timeout. For codex: warn on error/timeout.
 */
export function checkBinaryHealth(binary: string): CheckResult {
  const status: CheckStatus = binary === "codex" ? "warn" : "fail";

  try {
    execFileSync(binary, ["--version"], {
      timeout: 5000,
      stdio: "pipe",
    });
    return {
      name: `${binary}-health`,
      status: "pass",
      message: `${binary} --version succeeded`,
    };
  } catch {
    return {
      name: `${binary}-health`,
      status,
      message: `${binary} --version failed or timed out`,
      remediation: `Ensure ${binary} is properly installed and configured.`,
    };
  }
}

/**
 * Check that ~/.claude/ directory exists.
 */
export function checkClaudeHome(): CheckResult {
  const claudeDir = join(homedir(), ".claude");
  if (existsSync(claudeDir)) {
    return {
      name: "claude-home",
      status: "pass",
      message: "~/.claude/ exists",
    };
  }
  return {
    name: "claude-home",
    status: "fail",
    message: "~/.claude/ not found",
    remediation:
      "Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code",
  };
}

/**
 * Check that ~/.claude/skills/review-orchestra exists and resolves (via realpathSync)
 * to the expected <packageRoot>/skill directory.
 *
 * **Callers should skip this check when checkClaudeHome() fails.**
 */
export function checkSkillSymlink(packageRoot: string): CheckResult {
  const symlinkPath = join(
    homedir(),
    ".claude",
    "skills",
    "review-orchestra"
  );
  const expectedTarget = join(packageRoot, "skill");

  try {
    const actualReal = realpathSync(symlinkPath);
    const expectedReal = realpathSync(expectedTarget);

    if (actualReal === expectedReal) {
      const skillMd = join(actualReal, "SKILL.md");
      if (!existsSync(skillMd)) {
        return {
          name: "skill-symlink",
          status: "fail",
          message:
            "Skill symlink resolves correctly but SKILL.md is missing in target directory",
          remediation:
            "Verify the skill/ directory contains SKILL.md. Reinstall the package if needed.",
        };
      }
      return {
        name: "skill-symlink",
        status: "pass",
        message: "Skill symlink resolves correctly",
      };
    }

    return {
      name: "skill-symlink",
      status: "fail",
      message: `Skill symlink is stale: resolves to ${actualReal}, expected ${expectedReal}`,
      remediation: "Run: review-orchestra setup",
    };
  } catch {
    return {
      name: "skill-symlink",
      status: "fail",
      message: "Skill symlink missing or broken",
      remediation: "Run: review-orchestra setup",
    };
  }
}

/**
 * Check that schemas/findings.schema.json exists at the package root.
 */
export function checkSchemaFile(packageRoot: string): CheckResult {
  const schemaPath = join(packageRoot, "schemas", "findings.schema.json");
  if (existsSync(schemaPath)) {
    return {
      name: "schema-file",
      status: "pass",
      message: "findings.schema.json found",
    };
  }
  return {
    name: "schema-file",
    status: "warn",
    message: "schemas/findings.schema.json not found",
    remediation:
      "Schema file is missing. Reinstall the package or verify the installation.",
  };
}

/**
 * Check that .review-orchestra/ is in .gitignore.
 * Skips gracefully when there is no .git directory (not inside a git repo).
 */
export function checkGitignore(): CheckResult {
  const gitDir = join(process.cwd(), ".git");
  if (!existsSync(gitDir)) {
    return {
      name: "gitignore",
      status: "pass",
      message: "Not a git repo — skipped .gitignore check",
    };
  }

  const gitignorePath = join(process.cwd(), ".gitignore");
  if (!existsSync(gitignorePath)) {
    return {
      name: "gitignore",
      status: "warn",
      message: ".gitignore file not found",
      remediation:
        "Create .gitignore and add .review-orchestra/ to it, or run: review-orchestra setup",
    };
  }

  const content = readFileSync(gitignorePath, "utf-8");
  const lines = content.split("\n").map((l) => l.trim());
  const hasEntry = lines.some(
    (line) =>
      line === ".review-orchestra/" ||
      line === ".review-orchestra"
  );

  if (hasEntry) {
    return {
      name: "gitignore",
      status: "pass",
      message: ".review-orchestra/ is in .gitignore",
    };
  }

  return {
    name: "gitignore",
    status: "warn",
    message: ".review-orchestra/ not found in .gitignore",
    remediation:
      "Add .review-orchestra/ to .gitignore, or run: review-orchestra setup",
  };
}
