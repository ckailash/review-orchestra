import type { Config, DiffScope, ReviewerConfig } from "../types";
import type { Reviewer, ReviewerCallContext, ReviewerResult } from "./types";
import { ClaudeReviewer } from "./claude";
import { CodexReviewer } from "./codex";
import { parseReviewerOutput } from "../reviewer-parser";
import { buildReviewPrompt } from "./prompt";
import { parseCommand } from "./command";
import { log, logCommand, logTiming } from "../log";
import { spawnWithStreaming } from "../process";
import { stripNestedSessionEnv } from "../nested-session-env";
import { persistRawOutput } from "./raw-output";

export function createReviewers(config: Config, stateDir: string): Reviewer[] {
  const reviewers: Reviewer[] = [];

  for (const [name, reviewerConfig] of Object.entries(config.reviewers)) {
    if (!reviewerConfig.enabled) continue;

    switch (name) {
      case "claude":
        reviewers.push(new ClaudeReviewer(reviewerConfig, stateDir));
        break;
      case "codex":
        reviewers.push(new CodexReviewer(reviewerConfig, stateDir));
        break;
      default:
        reviewers.push(new GenericReviewer(name, reviewerConfig, stateDir));
        break;
    }
  }

  return reviewers;
}

class GenericReviewer implements Reviewer {
  readonly name: string;

  constructor(
    name: string,
    private config: ReviewerConfig,
    private stateDir: string,
  ) {
    this.name = name;
  }

  async review(
    prompt: string,
    scope: DiffScope,
    context: ReviewerCallContext,
  ): Promise<ReviewerResult> {
    const fullPrompt = buildReviewPrompt(prompt, scope);

    const { bin, args: templateArgs } = parseCommand(this.config.command);
    const hasPromptPlaceholder = templateArgs.some(a => a.includes("{prompt}"));
    // ARG_MAX is typically 256KB-2MB depending on OS; keep a conservative margin
    const MAX_PROMPT_IN_ARGV = 100_000;
    if (hasPromptPlaceholder && fullPrompt.length > MAX_PROMPT_IN_ARGV) {
      throw new Error(
        `${this.name}: prompt too large for {prompt} placeholder (${fullPrompt.length} bytes, limit ${MAX_PROMPT_IN_ARGV}). Configure the reviewer to read from stdin instead (remove {prompt} from the command).`
      );
    }
    const args = hasPromptPlaceholder
      ? templateArgs.map(a => a.replace("{prompt}", fullPrompt))
      : templateArgs;
    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    // Strip nested-session env so headless processes don't behave as a
    // nested Claude Code session.
    const env = stripNestedSessionEnv();

    logCommand(`${this.name}: invoking`, bin, args);
    log(`${this.name}: reviewing ${scope.files.length} files`);
    const startMs = Date.now();

    let output: string;
    try {
      output = await spawnWithStreaming({
        bin,
        args,
        input: hasPromptPlaceholder ? undefined : fullPrompt,
        env,
        label: this.name,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logTiming(`${this.name}: FAILED — ${message.slice(0, 200)}`, startMs);
      throw new Error(`${this.name} reviewer failed: ${message}`);
    }

    // Persist raw output BEFORE parsing — see ClaudeReviewer for rationale.
    persistRawOutput(this.stateDir, context.roundNumber, this.name, output);

    try {
      const elapsedMs = Date.now() - startMs;
      const findings = parseReviewerOutput(output, this.name);
      log(`${this.name}: done (${findings.length} findings, ${(elapsedMs / 1000).toFixed(1)}s)`);
      return { findings, rawOutput: output, elapsedMs };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logTiming(`${this.name}: FAILED — ${message.slice(0, 200)}`, startMs);
      throw new Error(`${this.name} reviewer failed: ${message}`);
    }
  }
}
