import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { Config, FindingComparisonConfig, ReviewerConfig } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));

function deepFreeze<T extends object>(obj: T): T {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

export const DEFAULT_FINDING_COMPARISON_CONFIG: FindingComparisonConfig = deepFreeze({
  method: "llm",
  model: "claude-haiku-4-5",
  timeoutMs: 60000,
  fallback: "heuristic",
});

export const DEFAULT_CONFIG: Config = deepFreeze({
  reviewers: {
    claude: {
      enabled: true,
      command:
        'claude -p - --allowedTools "Read,Grep,Glob,Bash" --output-format json',
      outputFormat: "json" as const,
    },
    codex: {
      enabled: true,
      command:
        "codex exec - --output-last-message {outputFile} --json",
      outputFormat: "json" as const,
    },
  },
  thresholds: {
    stopAt: "p1" as const,
  },
  findingComparison: DEFAULT_FINDING_COMPARISON_CONFIG,
});

function loadBaseConfig(): Config {
  try {
    const configPath = join(__dirname, "..", "config", "default.json");
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));

    const reviewers = { ...structuredClone(DEFAULT_CONFIG.reviewers) };
    if (parsed.reviewers) {
      for (const [name, partial] of Object.entries(parsed.reviewers)) {
        if (reviewers[name]) {
          reviewers[name] = { ...reviewers[name], ...(partial as Partial<ReviewerConfig>) };
        } else {
          reviewers[name] = { enabled: false, command: "", outputFormat: "json", ...(partial as Partial<ReviewerConfig>) };
        }
      }
    }

    return {
      reviewers,
      thresholds: { ...DEFAULT_CONFIG.thresholds, ...parsed.thresholds },
      findingComparison: { ...DEFAULT_FINDING_COMPARISON_CONFIG, ...parsed.findingComparison },
    };
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error("[review-orchestra] warning: config/default.json has invalid JSON, using defaults");
    }
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function loadConfig(
  overrides?: Partial<{
    reviewers: Record<string, Partial<ReviewerConfig>>;
    thresholds: Partial<Config["thresholds"]>;
    findingComparison: Partial<FindingComparisonConfig>;
  }>
): Config {
  const base = loadBaseConfig();
  if (!overrides) return base;

  const reviewers = { ...base.reviewers };
  if (overrides.reviewers) {
    for (const [name, partial] of Object.entries(overrides.reviewers)) {
      if (reviewers[name]) {
        reviewers[name] = { ...reviewers[name], ...partial };
      } else {
        reviewers[name] = { enabled: false, command: "", outputFormat: "json", ...partial };
      }
    }
  }

  return {
    reviewers,
    thresholds: { ...base.thresholds, ...overrides.thresholds },
    findingComparison: { ...base.findingComparison!, ...overrides.findingComparison },
  };
}
