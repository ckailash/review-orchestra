import { execFileSync } from "child_process";
import type { Config } from "./types";

interface BinaryInfo {
  name: string;
  binary: string;
  installHint: string;
}

const KNOWN_BINARIES: Record<string, BinaryInfo> = {
  claude: {
    name: "Claude Code CLI",
    binary: "claude",
    installHint: "Install from https://docs.anthropic.com/en/docs/claude-code",
  },
  codex: {
    name: "Codex CLI",
    binary: "codex",
    installHint: "Install with: npm install -g @openai/codex",
  },
};

const VALID_BINARY_PATTERN = /^[a-zA-Z0-9._\-/]+$/;

function binaryExists(binary: string): boolean {
  if (!VALID_BINARY_PATTERN.test(binary)) return false;
  try {
    execFileSync("which", [binary], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function extractBinary(command: string): string {
  return command.trim().split(/\s+/)[0];
}

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  disabledReviewers: string[];
}

export function runPreflight(config: Config): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const disabledReviewers: string[] = [];

  let enabledCount = 0;

  for (const [name, reviewerConfig] of Object.entries(config.reviewers)) {
    if (!reviewerConfig.enabled) continue;
    enabledCount++;

    const binary = extractBinary(reviewerConfig.command);
    const exists = binaryExists(binary);

    if (!exists) {
      const known = KNOWN_BINARIES[name];
      const hint = known ? ` ${known.installHint}` : "";
      warnings.push(
        `Reviewer "${name}" requires "${binary}" but it's not on PATH. Disabling.${hint}`
      );
      disabledReviewers.push(name);
    }
  }

  // Fail only if zero reviewers remain
  const remainingCount = enabledCount - disabledReviewers.length;
  if (remainingCount === 0 && enabledCount > 0) {
    errors.push(
      "No reviewers available. All enabled reviewers are missing their required binaries."
    );
  }

  if (enabledCount === 0) {
    errors.push("No reviewers are enabled in the configuration.");
  }

  // git is a hard requirement
  if (!binaryExists("git")) {
    errors.push("git is required but not found on PATH.");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    disabledReviewers,
  };
}
