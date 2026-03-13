import { execSync } from "child_process";
import type { Reviewer } from "./types";
import type { DiffScope, Finding, ReviewerConfig } from "../types";
import { parseReviewerOutput } from "../reviewer-parser";
import { buildReviewPrompt } from "./prompt";

export class ClaudeReviewer implements Reviewer {
  readonly name = "claude";

  constructor(private config: ReviewerConfig) {}

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
      throw new Error(`Claude reviewer failed: ${message}`);
    }
  }
}
