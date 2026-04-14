import type { Reviewer, ReviewerCallContext, ReviewerResult } from "./types";
import type { DiffScope, ReviewerConfig } from "../types";
import { parseReviewerOutput } from "../reviewer-parser";
import { buildReviewPrompt } from "./prompt";
import { parseCommand } from "./command";
import { log, logCommand, logTiming } from "../log";
import { spawnWithStreaming } from "../process";
import { stripNestedSessionEnv } from "../nested-session-env";
import { persistRawOutput } from "./raw-output";

export class ClaudeReviewer implements Reviewer {
  readonly name = "claude";

  constructor(
    private config: ReviewerConfig,
    private stateDir: string,
  ) {}

  async review(
    prompt: string,
    scope: DiffScope,
    context: ReviewerCallContext,
  ): Promise<ReviewerResult> {
    const fullPrompt = buildReviewPrompt(prompt, scope);
    const { bin, args } = parseCommand(this.config.command);
    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    // Strip nested-session env so headless claude -p doesn't behave as a
    // nested Claude Code session.
    const env = stripNestedSessionEnv();

    logCommand("claude: invoking", bin, args);
    log(`claude: reviewing ${scope.files.length} files`);
    const startMs = Date.now();

    let output: string;
    try {
      output = await spawnWithStreaming({
        bin,
        args,
        input: fullPrompt,
        env,
        label: "claude",
        inactivityTimeout: Math.max(10 * 60 * 1000, scope.files.length * 30 * 1000),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logTiming(`claude: FAILED — ${message.slice(0, 200)}`, startMs);
      throw new Error(`Claude reviewer failed: ${message}`);
    }

    // Persist raw output BEFORE parsing — if the parser throws on
    // malformed JSON we still want the file on disk to inspect.
    persistRawOutput(this.stateDir, context.roundNumber, this.name, output);

    try {
      const elapsedMs = Date.now() - startMs;
      const findings = parseReviewerOutput(output, this.name);
      log(`claude: done (${findings.length} findings, ${(elapsedMs / 1000).toFixed(1)}s)`);
      return { findings, rawOutput: output, elapsedMs };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logTiming(`claude: FAILED — ${message.slice(0, 200)}`, startMs);
      throw new Error(`Claude reviewer failed: ${message}`);
    }
  }
}
