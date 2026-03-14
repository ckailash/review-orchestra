import { readFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import type { Reviewer } from "./types";
import type { DiffScope, Finding, ReviewerConfig } from "../types";
import { parseReviewerOutput } from "../reviewer-parser";
import { buildReviewPrompt } from "./prompt";
import { parseCommand } from "./command";
import { log, logCommand, logTiming } from "../log";
import { spawnWithStreaming } from "../process";

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
        label: "codex",
      });
      logTiming("codex: review complete", startMs);

      let result: Finding[];
      if (existsSync(outputFile)) {
        const fileOutput = readFileSync(outputFile, "utf-8");
        log(`codex: reading output from file (${fileOutput.length} bytes)`);
        result = parseReviewerOutput(fileOutput, this.name);
      } else {
        log(`codex: no output file, parsing stdout (${stdout.length} bytes)`);
        result = parseReviewerOutput(stdout, this.name);
      }
      log(`codex: parsed ${result.length} findings`);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logTiming(`codex: FAILED — ${message.slice(0, 200)}`, startMs);
      throw new Error(`Codex reviewer failed: ${message}`);
    } finally {
      if (existsSync(outputFile)) unlinkSync(outputFile);
    }
  }
}
