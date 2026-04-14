import { readFileSync, mkdirSync, existsSync, unlinkSync, renameSync } from "fs";
import { join, dirname } from "path";
import type { Reviewer, ReviewerCallContext, ReviewerResult } from "./types";
import type { DiffScope, ReviewerConfig } from "../types";
import { parseReviewerOutput } from "../reviewer-parser";
import { buildReviewPrompt } from "./prompt";
import { parseCommand } from "./command";
import { log, logCommand, logTiming } from "../log";
import { spawnWithStreaming } from "../process";
import { stripNestedSessionEnv } from "../nested-session-env";
import { persistRawOutput } from "./raw-output";

export class CodexReviewer implements Reviewer {
  readonly name = "codex";

  constructor(
    private config: ReviewerConfig,
    private stateDir: string
  ) {}

  async review(
    prompt: string,
    scope: DiffScope,
    context: ReviewerCallContext,
  ): Promise<ReviewerResult> {
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

    let succeeded = false;
    try {
      let stdout: string;
      try {
        stdout = await spawnWithStreaming({
          bin,
          args,
          input: fullPrompt,
          env: stripNestedSessionEnv(),
          label: "codex",
          inactivityTimeout: Math.max(10 * 60 * 1000, scope.files.length * 30 * 1000),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logTiming(`codex: FAILED — ${message.slice(0, 200)}`, startMs);
        throw new Error(`Codex reviewer failed: ${message}`);
      }

      // Resolve the raw payload (codex writes structured JSON to outputFile,
      // status lines to stdout) and persist it to the orchestrator's debug
      // file BEFORE attempting to parse — same reasoning as ClaudeReviewer.
      const rawOutput = existsSync(outputFile)
        ? readFileSync(outputFile, "utf-8")
        : stdout;
      persistRawOutput(this.stateDir, context.roundNumber, this.name, rawOutput);

      try {
        const elapsedMs = Date.now() - startMs;
        const findings = parseReviewerOutput(rawOutput, this.name);
        log(`codex: done (${findings.length} findings, ${(elapsedMs / 1000).toFixed(1)}s)`);
        succeeded = true;
        return { findings, rawOutput, elapsedMs };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logTiming(`codex: FAILED — ${message.slice(0, 200)}`, startMs);
        throw new Error(`Codex reviewer failed: ${message}`);
      }
    } finally {
      // Only clean up the temp output on success. On failure we keep it
      // (renamed with a .failed suffix) so the user can inspect what
      // codex actually produced when diagnosing the error — deleting it
      // here would destroy the most useful piece of evidence. This finally
      // wraps the entire review body so it covers spawn failures too,
      // not just parse failures.
      if (existsSync(outputFile)) {
        if (succeeded) {
          unlinkSync(outputFile);
        } else {
          const failedPath = outputFile + ".failed";
          try {
            renameSync(outputFile, failedPath);
            log(`codex: failure output preserved at ${failedPath}`);
          } catch {
            // Renaming failed (cross-device, perms) — leave the original
            // in place rather than deleting it.
          }
        }
      }
    }
  }
}
