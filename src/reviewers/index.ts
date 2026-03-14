import type { Config, DiffScope, Finding, ReviewerConfig } from "../types";
import type { Reviewer } from "./types";
import { ClaudeReviewer } from "./claude";
import { CodexReviewer } from "./codex";
import { parseReviewerOutput } from "../reviewer-parser";
import { buildReviewPrompt } from "./prompt";
import { parseCommand } from "./command";
import { log, logCommand, logTiming } from "../log";
import { spawnWithStreaming } from "../process";

export function createReviewers(config: Config, stateDir: string): Reviewer[] {
  const reviewers: Reviewer[] = [];

  for (const [name, reviewerConfig] of Object.entries(config.reviewers)) {
    if (!reviewerConfig.enabled) continue;

    switch (name) {
      case "claude":
        reviewers.push(new ClaudeReviewer(reviewerConfig));
        break;
      case "codex":
        reviewers.push(new CodexReviewer(reviewerConfig, stateDir));
        break;
      default:
        reviewers.push(new GenericReviewer(name, reviewerConfig));
        break;
    }
  }

  return reviewers;
}

class GenericReviewer implements Reviewer {
  readonly name: string;

  constructor(
    name: string,
    private config: ReviewerConfig
  ) {
    this.name = name;
  }

  async review(prompt: string, scope: DiffScope): Promise<Finding[]> {
    const fullPrompt = buildReviewPrompt(prompt, scope);

    const { bin, args: templateArgs } = parseCommand(this.config.command);
    const args = templateArgs.map(a => a.replace("{prompt}", fullPrompt));
    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    // Strip CLAUDECODE env var so headless processes don't think they're nested sessions
    const env = { ...process.env };
    delete env.CLAUDECODE;

    logCommand(`${this.name}: invoking`, bin, args);
    log(`${this.name}: reviewing ${scope.files.length} files`);
    const startMs = Date.now();

    try {
      const output = await spawnWithStreaming({
        bin,
        args,
        input: fullPrompt,
        env,
        label: this.name,
      });
      logTiming(`${this.name}: review complete`, startMs);
      const findings = parseReviewerOutput(output, this.name);
      log(`${this.name}: parsed ${findings.length} findings`);
      return findings;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logTiming(`${this.name}: FAILED — ${message.slice(0, 200)}`, startMs);
      throw new Error(`${this.name} reviewer failed: ${message}`);
    }
  }
}
