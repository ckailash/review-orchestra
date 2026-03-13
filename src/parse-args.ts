import type { PLevel } from "./types";

// Heuristics for routing bare model names to the correct reviewer.
// These do NOT resolve model IDs — the CLI tools handle that.
const CLAUDE_MODEL_PATTERN = /^(opus|sonnet|haiku|claude)/i;
const OPENAI_MODEL_PATTERN = /^(o[134]|gpt|codex)/i;

function inferReviewerForModel(modelName: string): string {
  if (CLAUDE_MODEL_PATTERN.test(modelName)) return "claude";
  if (OPENAI_MODEL_PATTERN.test(modelName)) return "codex";
  // Unknown model family — default to claude
  return "claude";
}

export interface ParsedArgs {
  paths: string[];
  stopAt?: PLevel;
  maxRounds?: number;
  disabledReviewers: string[];
  onlyReviewer?: string;
  models: Record<string, string>;
  dryRun: boolean;
}

export function parseArgs(input: string): ParsedArgs {
  const result: ParsedArgs = {
    paths: [],
    disabledReviewers: [],
    models: {},
    dryRun: false,
  };

  if (!input) return result;
  let remaining = input;

  // Dry run
  if (/--dry-run|\bdry run\b/i.test(remaining)) {
    result.dryRun = true;
    remaining = remaining.replace(/--dry-run/g, "").replace(/\bdry run\b/gi, "").trim();
  }

  // Max rounds: "max 3 rounds"
  const roundsMatch = remaining.match(/max\s+(\d+)\s+rounds?/i);
  if (roundsMatch) {
    result.maxRounds = parseInt(roundsMatch[1], 10);
    remaining = remaining.replace(roundsMatch[0], "").trim();
  }

  // Threshold: "fix everything" → p3, "fix quality issues too" → p2
  if (/fix\s+(everything|all)/i.test(remaining)) {
    result.stopAt = "p3";
    remaining = remaining.replace(/fix\s+(everything|all)/gi, "").trim();
  } else if (/fix\s+quality/i.test(remaining)) {
    result.stopAt = "p2";
    remaining = remaining.replace(/fix\s+quality\s*(issues?)?\s*(too)?/gi, "").trim();
  }

  // Reviewer selection: "skip codex", "only use claude"
  const skipMatch = remaining.match(/skip\s+(\w+)/i);
  if (skipMatch) {
    result.disabledReviewers.push(skipMatch[1].toLowerCase());
    remaining = remaining.replace(skipMatch[0], "").trim();
  }

  const onlyMatch = remaining.match(/only\s+(?:use\s+)?(\w+)/i);
  if (onlyMatch) {
    result.onlyReviewer = onlyMatch[1].toLowerCase();
    remaining = remaining.replace(onlyMatch[0], "").trim();
  }

  // Model selection: "use opus for claude", "use o3 for codex", "use opus"
  // Model names are passed through verbatim — the reviewer CLIs resolve them.
  const modelForMatch = remaining.match(/use\s+([\w.-]+)\s+for\s+(\w+)/i);
  if (modelForMatch) {
    result.models[modelForMatch[2].toLowerCase()] = modelForMatch[1];
    remaining = remaining.replace(modelForMatch[0], "").trim();
  } else {
    const modelMatch = remaining.match(/use\s+([\w.-]+)/i);
    if (modelMatch) {
      const modelName = modelMatch[1];
      const target = inferReviewerForModel(modelName);
      result.models[target] = modelName;
      remaining = remaining.replace(modelMatch[0], "").trim();
    }
  }

  // Remaining tokens that look like paths
  for (const token of remaining.split(/\s+/).filter(Boolean)) {
    if (token.includes("/") || token.includes(".") || /^(src|lib|test|app|pkg)$/i.test(token)) {
      result.paths.push(token);
    }
  }

  return result;
}
