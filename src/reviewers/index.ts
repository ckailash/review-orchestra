import { execSync } from "child_process";
import type { Config, DiffScope, Finding, ReviewerConfig } from "../types";
import type { Reviewer } from "./types";
import { ClaudeReviewer } from "./claude";
import { CodexReviewer } from "./codex";
import { parseReviewerOutput } from "../reviewer-parser";
import { buildReviewPrompt } from "./prompt";

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

    const cmd = this.config.model
      ? `${this.config.command} --model ${this.config.model}`
      : this.config.command;

    try {
      const output = execSync(cmd, {
        input: fullPrompt,
        encoding: "utf-8",
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return parseReviewerOutput(output, this.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${this.name} reviewer failed: ${message}`);
    }
  }
}
