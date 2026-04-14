import { readFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
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

function mergeConfig(base: Config, parsed: Record<string, unknown>): Config {
  const reviewers: Record<string, ReviewerConfig> = {};
  for (const [name, cfg] of Object.entries(base.reviewers)) {
    reviewers[name] = { ...cfg };
  }
  if (parsed.reviewers) {
    for (const [name, partial] of Object.entries(parsed.reviewers as Record<string, Partial<ReviewerConfig>>)) {
      if (reviewers[name]) {
        reviewers[name] = { ...reviewers[name], ...partial };
        continue;
      }
      // New reviewer entry — only register it if the partial includes a
      // non-empty command. Synthesising `command: ""` would silently
      // create a broken reviewer that fails preflight in a confusing way.
      if (typeof partial.command === "string" && partial.command.trim() !== "") {
        reviewers[name] = {
          enabled: partial.enabled ?? false,
          command: partial.command,
          outputFormat: partial.outputFormat ?? "json",
          ...(partial.model !== undefined ? { model: partial.model } : {}),
        };
      } else {
        console.error(
          `[review-orchestra] warning: ignoring config entry for unknown reviewer "${name}" — no command provided`,
        );
      }
    }
  }

  return {
    reviewers,
    thresholds: { ...base.thresholds, ...(parsed.thresholds as Partial<Config["thresholds"]>) },
    findingComparison: { ...DEFAULT_FINDING_COMPARISON_CONFIG, ...base.findingComparison, ...(parsed.findingComparison as Partial<FindingComparisonConfig>) },
  };
}

function tryLoadJson(path: string, label: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error(`[review-orchestra] warning: ${label} has invalid JSON, skipping`);
    }
    return null;
  }
}

function loadBaseConfig(): Config {
  // 1. Package defaults
  let config = structuredClone(DEFAULT_CONFIG);

  // 2. Package config/default.json (overrides hardcoded defaults)
  const packageConfig = tryLoadJson(join(__dirname, "..", "config", "default.json"), "config/default.json");
  if (packageConfig) config = mergeConfig(config, packageConfig);

  // 3. Global user config: ~/.review-orchestra/config.json
  const globalConfig = tryLoadJson(join(homedir(), ".review-orchestra", "config.json"), "~/.review-orchestra/config.json");
  if (globalConfig) config = mergeConfig(config, globalConfig);

  // 4. Project config: .review-orchestra/config.json (cwd)
  const projectConfig = tryLoadJson(join(process.cwd(), ".review-orchestra", "config.json"), ".review-orchestra/config.json");
  if (projectConfig) config = mergeConfig(config, projectConfig);

  return config;
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
  return mergeConfig(base, overrides as Record<string, unknown>);
}
