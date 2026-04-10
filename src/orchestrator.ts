import { readFileSync } from "fs";
import { join } from "path";
import { log } from "./log";
import type {
  Config,
  DiffScope,
  Finding,
  ReviewMetadata,
  ReviewResult,
} from "./types";
import { StateManager } from "./state";
import { consolidate } from "./consolidator";
import { createReviewers } from "./reviewers/index";
import type { Reviewer } from "./reviewers/types";
import { detectToolchain, formatToolchainContext } from "./toolchain";
import { runPreflight } from "./preflight";

export interface OrchestratorCallbacks {
  onPreflightWarning?(warnings: string[]): void;
  onRoundStart?(round: number): void;
  onReviewComplete?(reviewer: string, findings: Finding[]): void;
  onReviewerError?(reviewer: string, error: string): void;
  onConsolidated?(findings: Finding[]): void;
  onComplete?(result: ReviewResult): void;
}

export class Orchestrator {
  private state: StateManager;
  private reviewers: Reviewer[];
  private reviewPrompt: string;

  constructor(
    private config: Config,
    private stateDir: string,
    private callbacks: OrchestratorCallbacks = {},
    private packageRoot: string = process.cwd()
  ) {
    this.state = new StateManager(stateDir);
    this.reviewers = createReviewers(config, stateDir);
    const basePrompt = readFileSync(
      join(this.packageRoot, "prompts", "review.md"),
      "utf-8"
    );
    const toolchain = detectToolchain();
    this.reviewPrompt = basePrompt + formatToolchainContext(toolchain);
  }

  async run(scope: DiffScope): Promise<ReviewResult> {
    // Phase 0: Preflight — validate required binaries exist
    const preflight = runPreflight(this.config);
    if (!preflight.ok) {
      const msg = ["Preflight check failed:", ...preflight.errors].join("\n  - ");
      throw new Error(msg);
    }

    // Disable reviewers whose binaries are missing (warn, don't fail)
    if (preflight.disabledReviewers.length > 0) {
      for (const name of preflight.disabledReviewers) {
        this.reviewers = this.reviewers.filter((r) => r.name !== name);
      }
      this.callbacks.onPreflightWarning?.(preflight.warnings);
    }

    this.state.start(scope);

    try {
      const round = this.state.newRound();
      this.callbacks.onRoundStart?.(round.number);

      // Phase 1: Parallel Review
      this.state.updatePhase("reviewing");
      const { findings: allFindings, reviewerErrors } = await this.runReviews(scope);

      // Phase 2: Consolidation
      this.state.updatePhase("consolidating");
      const consolidated = consolidate(allFindings, scope.diff);
      this.state.saveConsolidated(consolidated);
      this.callbacks.onConsolidated?.(consolidated);

      // Mark round complete
      this.state.updatePhase("complete");
      this.state.complete();

      // Build ReviewResult
      const result: ReviewResult = {
        sessionId: "",
        round: round.number,
        findings: consolidated,
        resolvedFindings: [],
        reviewerErrors,
        worktreeHash: "",
        scope,
        metadata: {
          reviewer: this.reviewers.map((r) => r.name).join(","),
          round: round.number,
          timestamp: new Date().toISOString(),
          files_reviewed: scope.files.length,
          diff_scope: scope.description,
        },
      };

      this.callbacks.onComplete?.(result);
      return result;
    } catch (err) {
      this.state.fail();
      throw err;
    }
  }

  private async runReviews(
    scope: DiffScope
  ): Promise<{ findings: Finding[]; reviewerErrors: Array<{ reviewer: string; error: string }> }> {
    // Reviewers use spawn (async) so Promise.allSettled runs them in parallel
    const reviewerNames = this.reviewers.map((r) => r.name).join(", ");
    log(`dispatching reviewers: ${reviewerNames}`);
    const results = await Promise.allSettled(
      this.reviewers.map(async (reviewer) => {
        const findings = await reviewer.review(this.reviewPrompt, scope);
        this.state.saveReview(reviewer.name, {
          findings,
          metadata: {
            reviewer: reviewer.name,
            round: this.state.getState().currentRound,
            timestamp: new Date().toISOString(),
            files_reviewed: scope.files.length,
            diff_scope: scope.description,
          },
        });
        this.callbacks.onReviewComplete?.(reviewer.name, findings);
        return findings;
      })
    );

    const allFindings: Finding[] = [];
    const reviewerErrors: Array<{ reviewer: string; error: string }> = [];
    let succeededCount = 0;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        succeededCount++;
        allFindings.push(...result.value);
      } else {
        const reviewer = this.reviewers[i];
        const reason =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        reviewerErrors.push({ reviewer: reviewer.name, error: reason });
        this.callbacks.onReviewerError?.(reviewer.name, reason);
      }
    }

    if (succeededCount === 0) {
      throw new Error("All reviewers failed — cannot determine review status");
    }

    return { findings: allFindings, reviewerErrors };
  }
}
