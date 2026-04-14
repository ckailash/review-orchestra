import { binaryExists } from "./checks.js";
import { parseCommand } from "./reviewers/command";
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

    const { bin: binary } = parseCommand(reviewerConfig.command);
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

  // LLM finding comparison preflight: when method=llm and the claude CLI
  // is missing, the run will either fall back to heuristic matching (warn)
  // or fail at comparison time (error) depending on the fallback policy.
  if (config.findingComparison?.method === "llm") {
    if (!binaryExists("claude")) {
      if (config.findingComparison.fallback === "error") {
        errors.push(
          "LLM finding comparison requires claude CLI but it is not on PATH, " +
            "and findingComparison.fallback is set to \"error\". " +
            "Install claude or set fallback to \"heuristic\".",
        );
      } else {
        warnings.push(
          "LLM finding comparison requires claude CLI; falling back to heuristic matching",
        );
      }
    }
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
