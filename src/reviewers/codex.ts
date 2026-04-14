import { readFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import type { Reviewer, ReviewerResult } from "./types";
import type { DiffScope, ReviewerConfig } from "../types";
import { parseReviewerOutput } from "../reviewer-parser";
import { buildReviewPrompt } from "./prompt";
import { parseCommand } from "./command";
import { log, logCommand, logTiming } from "../log";
import { spawnWithStreaming } from "../process";
import { stripNestedSessionEnv } from "../nested-session-env";

export class CodexReviewer implements Reviewer {
  readonly name = "codex";

  constructor(
    private config: ReviewerConfig,
    private stateDir: string
  ) {}

  async review(prompt: string, scope: DiffScope): Promise<ReviewerResult> {
    const fullPrompt = buildReviewPrompt(prompt, scope);
    const outputFile = join(this.stateDir, `codex-output-${Date.now()}.json`);

    mkdirSync(dirname(outputFile), { recursive: true });

    const { bin, args: templateArgs } = parseCommand(this.config.command);
    const args = templateArgs.map(a => a.replace("{outputFile}", outputFile));
    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    logCommand("codex: invoking", bin, args);
    log(`codex: reviewing ${scope.files.length} files (output: ${outputFile})`);
    const startMs = Date.now();

    try {
      const stdout = await spawnWithStreaming({
        bin,
        args,
        input: fullPrompt,
        env: stripNestedSessionEnv(),
        label: "codex",
        inactivityTimeout: Math.max(10 * 60 * 1000, scope.files.length * 30 * 1000),
      });
      const elapsedMs = Date.now() - startMs;

      let rawOutput: string;
      if (existsSync(outputFile)) {
        rawOutput = readFileSync(outputFile, "utf-8");
      } else {
        rawOutput = stdout;
      }
      const findings = parseReviewerOutput(rawOutput, this.name);
      log(`codex: done (${findings.length} findings, ${(elapsedMs / 1000).toFixed(1)}s)`);
      return { findings, rawOutput, elapsedMs };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logTiming(`codex: FAILED — ${message.slice(0, 200)}`, startMs);
      throw new Error(`Codex reviewer failed: ${message}`);
    } finally {
      if (existsSync(outputFile)) unlinkSync(outputFile);
    }
  }
}
