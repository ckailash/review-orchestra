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
import { SessionManager } from "./state";
import { consolidate } from "./consolidator";
import { createReviewers } from "./reviewers/index";
import type { Reviewer } from "./reviewers/types";
import { detectToolchain, formatToolchainContext } from "./toolchain";
import { runPreflight } from "./preflight";
import { computeWorktreeHash } from "./worktree-hash";
import { assignFindingIds } from "./finding-comparison";

export interface OrchestratorCallbacks {
  onPreflightWarning?(warnings: string[]): void;
  onRoundStart?(round: number): void;
  onReviewComplete?(reviewer: string, findings: Finding[]): void;
  onReviewerError?(reviewer: string, error: string): void;
  onConsolidated?(findings: Finding[]): void;
  onComplete?(result: ReviewResult): void;
}

export class Orchestrator {
  private state: SessionManager;
  private reviewers: Reviewer[];
  private reviewPrompt: string;

  constructor(
    private config: Config,
    private stateDir: string,
    private callbacks: OrchestratorCallbacks = {},
    private packageRoot: string = process.cwd()
  ) {
    this.state = new SessionManager(stateDir);
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

    const recovery = this.state.startOrContinue(scope);

    try {
      const worktreeHash = computeWorktreeHash();

      let round;
      let allFindings: Finding[];
      let reviewerErrors: Array<{ reviewer: string; error: string }>;

      if (recovery.isRecovery && recovery.phase === "consolidating") {
        // Crash during consolidation — resume with already-saved review data
        round = this.state.getCurrentRound()!;
        this.callbacks.onRoundStart?.(round.number);

        // Gather findings from saved reviews
        allFindings = [];
        reviewerErrors = [];
        for (const [, output] of Object.entries(round.reviews)) {
          allFindings.push(...output.findings);
        }

        // Re-run consolidation
        this.state.updatePhase("consolidating");
        const consolidated = consolidate(allFindings, scope.diff);
        this.state.saveConsolidated(consolidated);
        this.callbacks.onConsolidated?.(consolidated);
      } else if (recovery.isRecovery && recovery.phase === "reviewing") {
        // Crash during reviewing — resume, skip completed reviewers
        round = this.state.getCurrentRound()!;
        this.callbacks.onRoundStart?.(round.number);

        const completedSet = new Set(recovery.completedReviewers ?? []);
        const remainingReviewers = this.reviewers.filter(
          (r) => !completedSet.has(r.name),
        );

        if (remainingReviewers.length === 0) {
          // All reviewers already completed before crash — use saved review data
          allFindings = [];
          reviewerErrors = [];
          for (const [, output] of Object.entries(round.reviews)) {
            allFindings.push(...output.findings);
          }
        } else {
          // Run only remaining reviewers
          this.state.updatePhase("reviewing");
          const previousReviewers = this.reviewers;
          this.reviewers = remainingReviewers;
          const reviewResult = await this.runReviews(scope);
          this.reviewers = previousReviewers;

          // Merge with already-completed reviewer findings
          allFindings = [...reviewResult.findings];
          for (const [, output] of Object.entries(round.reviews)) {
            allFindings.push(...output.findings);
          }
          reviewerErrors = reviewResult.reviewerErrors;
        }

        // Phase 2: Consolidation
        this.state.updatePhase("consolidating");
        const consolidated = consolidate(allFindings, scope.diff);
        this.state.saveConsolidated(consolidated);
        this.callbacks.onConsolidated?.(consolidated);
      } else {
        // Normal flow — create a new round
        round = this.state.newRound(worktreeHash);
        this.callbacks.onRoundStart?.(round.number);

        // Phase 1: Parallel Review
        this.state.updatePhase("reviewing");
        const reviewResult = await this.runReviews(scope);
        allFindings = reviewResult.findings;
        reviewerErrors = reviewResult.reviewerErrors;

        // Phase 2: Consolidation
        this.state.updatePhase("consolidating");
        const consolidated = consolidate(allFindings, scope.diff);
        this.state.saveConsolidated(consolidated);
        this.callbacks.onConsolidated?.(consolidated);
      }

      // Phase 3: Finding comparison — assign IDs and statuses
      const previousRound = this.state.getPreviousRound();
      const previousFindings = previousRound?.consolidated ?? [];
      const currentConsolidated = this.state.getCurrentRound()?.consolidated ?? [];
      const { findings: comparedFindings, resolvedFindings } =
        assignFindingIds(currentConsolidated, previousFindings, round.number);

      // Update consolidated findings with IDs and statuses
      this.state.saveConsolidated(comparedFindings);

      // Mark round complete and release lock without changing session status
      this.state.updatePhase("complete");
      this.state.releaseLock();

      // Build ReviewResult
      const sessionState = this.state.getState();
      const result: ReviewResult = {
        sessionId: sessionState.sessionId,
        round: round.number,
        findings: comparedFindings,
        resolvedFindings,
        reviewerErrors,
        worktreeHash: sessionState.worktreeHash,
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
