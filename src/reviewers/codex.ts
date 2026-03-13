import { execSync } from "child_process";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import type { Reviewer } from "./types";
import type { DiffScope, Finding, ReviewerConfig } from "../types";
import { parseReviewerOutput } from "../reviewer-parser";
import { buildReviewPrompt } from "./prompt";

export class CodexReviewer implements Reviewer {
  readonly name = "codex";

  constructor(
    private config: ReviewerConfig,
    private stateDir: string
  ) {}

  async review(prompt: string, scope: DiffScope): Promise<Finding[]> {
    const fullPrompt = buildReviewPrompt(prompt, scope);
    const outputFile = join(this.stateDir, `codex-output-${Date.now()}.json`);

    mkdirSync(dirname(outputFile), { recursive: true });

    // Shell-safe path quoting for the output file
    const quotedPath = outputFile.replace(/'/g, "'\\''");
    let cmd = this.config.command.replace("{outputFile}", `'${quotedPath}'`);
    if (this.config.model) {
      cmd = `${cmd} --model ${this.config.model}`;
    }

    try {
      const stdout = execSync(cmd, {
        input: fullPrompt,
        encoding: "utf-8",
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
      });

      if (existsSync(outputFile)) {
        const fileOutput = readFileSync(outputFile, "utf-8");
        return parseReviewerOutput(fileOutput, this.name);
      }
      return parseReviewerOutput(stdout, this.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Codex reviewer failed: ${message}`);
    }
  }
}
