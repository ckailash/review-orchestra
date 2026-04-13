import type { PLevel } from "./types";

// --- Subcommand detection ---

const SUBCOMMANDS = new Set(["review", "reset", "stale", "setup", "doctor"]);

export type Subcommand = "review" | "reset" | "stale" | "setup" | "doctor";

export interface SubcommandResult {
  subcommand: Subcommand;
  remaining: string[];
}

/**
 * Detect the subcommand from raw argv (process.argv.slice(2)).
 * If the first non-option argument is a recognized subcommand, strip it
 * and return the rest. Otherwise default to "review" and pass everything through.
 */
export function detectSubcommand(argv: string[]): SubcommandResult {
  if (argv.length === 0) {
    return { subcommand: "review", remaining: [] };
  }

  const first = argv[0];
  if (SUBCOMMANDS.has(first)) {
    return { subcommand: first as Subcommand, remaining: argv.slice(1) };
  }

  // Not a recognized subcommand — default to review, pass all args through
  return { subcommand: "review", remaining: argv };
}

// Heuristics for routing bare model names to the correct reviewer.
// These do NOT resolve model IDs — the CLI tools handle that.
const CLAUDE_MODEL_PATTERN = /^(opus|sonnet|haiku|claude)/i;
const OPENAI_MODEL_PATTERN = /^(o[134]|gpt|codex)/i;

// Matches git refs: HEAD~N, HEAD^N, SHAs (7+ hex chars), ranges (ref..ref)
function isGitRef(token: string): boolean {
  // Ranges: abc..def or abc...def — require non-dot chars on both sides
  if (/^[^.]+\.{2,3}[^.]+$/.test(token)) return true;
  // HEAD with optional ~N or ^N
  if (/^HEAD([~^]\d*)*$/i.test(token)) return true;
  // Bare SHA (7-40 hex characters)
  if (/^[0-9a-f]{7,40}$/i.test(token)) return true;
  return false;
}

function inferReviewerForModel(modelName: string): string {
  if (CLAUDE_MODEL_PATTERN.test(modelName)) return "claude";
  if (OPENAI_MODEL_PATTERN.test(modelName)) return "codex";
  // Unknown model family — default to claude
  return "claude";
}

export interface ParsedArgs {
  paths: string[];
  commitRef?: string;
  stopAt?: PLevel;
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

  // Threshold: "fix everything" → p3, "fix quality issues too" → p2
  if (/fix\s+(everything|all)/i.test(remaining)) {
    result.stopAt = "p3";
    remaining = remaining.replace(/fix\s+(everything|all)/gi, "").trim();
  } else if (/fix\s+quality/i.test(remaining)) {
    result.stopAt = "p2";
    remaining = remaining.replace(/fix\s+quality\s*(issues?)?\s*(too)?/gi, "").trim();
  }

  // Reviewer selection: "skip codex", "only use claude", "only claude"
  // Constrained to avoid greedy matches — require end-of-string or whitespace boundary
  let skipMatch;
  while ((skipMatch = remaining.match(/\bskip\s+(\w+)(?=\s|$)/i))) {
    result.disabledReviewers.push(skipMatch[1].toLowerCase());
    remaining = remaining.replace(skipMatch[0], "").trim();
  }

  const onlyMatch = remaining.match(/\bonly\s+(?:use\s+)?(\w+)(?=\s|$)/i);
  if (onlyMatch) {
    result.onlyReviewer = onlyMatch[1].toLowerCase();
    remaining = remaining.replace(onlyMatch[0], "").trim();
  }

  // Model selection: "use opus for claude", "use o3 for codex", "use opus"
  // Model names are passed through verbatim — the reviewer CLIs resolve them.
  // Loop to handle multiple model assignments in one input.
  let modelForMatch;
  while ((modelForMatch = remaining.match(/use\s+([\w.-]+)\s+for\s+(\w+)/i))) {
    result.models[modelForMatch[2].toLowerCase()] = modelForMatch[1];
    remaining = remaining.replace(modelForMatch[0], "").trim();
  }
  // Bare model name without "for <reviewer>" — infer target from model name
  const modelMatch = remaining.match(/use\s+([\w.-]+)/i);
  if (modelMatch) {
    const modelName = modelMatch[1];
    const target = inferReviewerForModel(modelName);
    result.models[target] = modelName;
    remaining = remaining.replace(modelMatch[0], "").trim();
  }

  // Git ref detection: HEAD~N, SHA, ranges (abc..def), etc.
  // Must come before path detection since SHAs could be mistaken for dotfiles
  const tokens = remaining.split(/\s+/).filter(Boolean);
  const nonRefTokens: string[] = [];
  for (const token of tokens) {
    if (isGitRef(token)) {
      result.commitRef = token;
    } else {
      nonRefTokens.push(token);
    }
  }

  // Remaining tokens that look like paths
  for (const token of nonRefTokens) {
    if (token.includes("/") || token.includes(".") || /^(src|lib|test|app|pkg)$/i.test(token)) {
      result.paths.push(token);
    }
  }

  return result;
}
