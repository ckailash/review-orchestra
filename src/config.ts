import type { Config, ReviewerConfig } from "./types";

export const DEFAULT_CONFIG: Config = {
  reviewers: {
    claude: {
      enabled: true,
      command:
        'claude -p - --allowed-tools "Read,Grep,Glob,Bash" --output-format json',
      outputFormat: "json",
    },
    codex: {
      enabled: true,
      command:
        "codex exec - --output-last-message {outputFile} --json",
      outputFormat: "json",
    },
  },
  thresholds: {
    stopAt: "p1",
    maxRounds: 5,
  },
  escalation: {
    pauseOnAmbiguity: true,
    pauseOnConflict: true,
  },
};

export function loadConfig(
  overrides?: Partial<{
    reviewers: Record<string, Partial<ReviewerConfig>>;
    thresholds: Partial<Config["thresholds"]>;
    escalation: Partial<Config["escalation"]>;
  }>
): Config {
  if (!overrides) return { ...DEFAULT_CONFIG };

  const reviewers = { ...DEFAULT_CONFIG.reviewers };
  if (overrides.reviewers) {
    for (const [name, partial] of Object.entries(overrides.reviewers)) {
      if (reviewers[name]) {
        reviewers[name] = { ...reviewers[name], ...partial };
      } else {
        reviewers[name] = partial as ReviewerConfig;
      }
    }
  }

  return {
    reviewers,
    thresholds: { ...DEFAULT_CONFIG.thresholds, ...overrides.thresholds },
    escalation: { ...DEFAULT_CONFIG.escalation, ...overrides.escalation },
  };
}
