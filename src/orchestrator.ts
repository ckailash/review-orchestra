import { readFileSync } from "fs";
import { join } from "path";
import { log } from "./log";
import type {
  Config,
  DiffScope,
  Finding,
  ReviewMetadata,
  ReviewResult,
  Round,
} from "./types";
import { SessionManager } from "./state";
import { consolidate } from "./consolidator";
import { createReviewers } from "./reviewers/index";
import type { Reviewer } from "./reviewers/types";
import { detectToolchain, formatToolchainContext } from "./toolchain";
import { runPreflight } from "./preflight";
import { computeWorktreeHash } from "./worktree-hash";
import { assignFindingIds } from "./finding-comparison";
import { appendFindings, backfillResolved } from "./findings-store";
import type { ProgressData } from "./progress";
import { writeProgress, clearProgress } from "./progress";

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
    let activeReviewers = this.reviewers;
    if (preflight.disabledReviewers.length > 0) {
      activeReviewers = activeReviewers.filter(
        (r) => !preflight.disabledReviewers.includes(r.name),
      );
      this.callbacks.onPreflightWarning?.(preflight.warnings);
    }

    const recovery = this.state.startOrContinue(scope);

    try {
      const worktreeHash = computeWorktreeHash();

      let round: Round;
      let allFindings: Finding[];
      let reviewerErrors: Array<{ reviewer: string; error: string }>;
      let timings: Array<{ name: string; elapsedMs: number }> = [];

      if (recovery.isRecovery && recovery.phase === "consolidating") {
        // Crash during consolidation — resume with already-saved review data
        const currentRound = this.state.getCurrentRound();
        if (!currentRound) {
          throw new Error("Recovery phase 'consolidating' requires an active round but none found — session state may be corrupted. Run `review-orchestra reset`.");
        }
        round = currentRound;
        this.callbacks.onRoundStart?.(round.number);

        // Gather findings from saved reviews
        allFindings = [];
        reviewerErrors = [];
        for (const [, output] of Object.entries(round.reviews)) {
          allFindings.push(...output.findings);
        }
      } else if (recovery.isRecovery && recovery.phase === "reviewing") {
        // Crash during reviewing — resume, skip completed reviewers
        const currentRound = this.state.getCurrentRound();
        if (!currentRound) {
          throw new Error("Recovery phase 'reviewing' requires an active round but none found — session state may be corrupted. Run `review-orchestra reset`.");
        }
        round = currentRound;
        this.callbacks.onRoundStart?.(round.number);

        const completedSet = new Set(recovery.completedReviewers ?? []);
        const remainingReviewers = activeReviewers.filter(
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
          // Run only remaining reviewers — pass completed reviewer info for progress.json
          this.state.updatePhase("reviewing");
          const completedEntries: Record<string, { status: "done"; findingsCount: number; elapsedMs: number | null }> = {};
          for (const [name, output] of Object.entries(round.reviews)) {
            if (completedSet.has(name)) {
              completedEntries[name] = {
                status: "done",
                findingsCount: output.findings.length,
                elapsedMs: null,
              };
            }
          }
          const reviewResult = await this.runReviews(scope, remainingReviewers, completedEntries);

          // Merge with already-completed reviewer findings (from before crash)
          allFindings = [...reviewResult.findings];
          for (const [name, output] of Object.entries(round.reviews)) {
            if (completedSet.has(name)) {
              allFindings.push(...output.findings);
            }
          }
          reviewerErrors = reviewResult.reviewerErrors;
          timings = reviewResult.timings;
        }
      } else {
        // Normal flow — create a new round
        round = this.state.newRound(worktreeHash);
        this.callbacks.onRoundStart?.(round.number);

        // Phase 1: Parallel Review
        this.state.updatePhase("reviewing");
        const reviewResult = await this.runReviews(scope, activeReviewers);
        allFindings = reviewResult.findings;
        reviewerErrors = reviewResult.reviewerErrors;
        timings = reviewResult.timings;
      }

      // Phase 2: Consolidation — shared across all branches so logging and
      // state transitions are consistent.
      this.state.updatePhase("consolidating");
      const consolStart = Date.now();
      const consolidated = consolidate(allFindings, scope.diff);
      const consolElapsed = Date.now() - consolStart;
      this.state.saveConsolidated(consolidated);
      const timingsPart =
        timings.length > 0
          ? timings
              .map((t) => `${t.name} ${(t.elapsedMs / 1000).toFixed(1)}s`)
              .join(", ") + ", "
          : "";
      log(
        `review complete (${timingsPart}consolidation ${(consolElapsed / 1000).toFixed(1)}s)`,
      );

      // Phase 3: Finding comparison — assign IDs and statuses
      const previousRound = this.state.getPreviousRound();
      const previousFindings = previousRound?.consolidated ?? [];
      const currentConsolidated = this.state.getCurrentRound()?.consolidated ?? [];
      const { findings: comparedFindings, resolvedFindings } =
        await assignFindingIds(
          currentConsolidated,
          previousFindings,
          round.number,
          this.config.findingComparison,
          this.config.reviewers.claude?.command,
        );

      // Update consolidated findings with IDs and statuses, then notify
      // callbacks with the comparison-resolved findings (round-scoped IDs +
      // new/persisting status set).
      this.state.saveConsolidated(comparedFindings);
      this.callbacks.onConsolidated?.(comparedFindings);

      // Persist findings to ~/.review-orchestra/findings.jsonl. Skip on
      // crash-recovery re-execution to avoid double-writing the same round
      // (the appended entries would be duplicates with new IDs).
      const sessionState = this.state.getState();
      const currentRound = this.state.getCurrentRound();
      const alreadyPersisted = currentRound?.findingsPersisted === true;

      if (!alreadyPersisted) {
        // Only mark the round as persisted if the primary append succeeded.
        // A failed write must NOT set the flag — otherwise crash-recovery
        // would silently skip the retry and the findings would be lost
        // from the JSONL store.
        let appendOk = false;
        try {
          appendFindings({
            findings: comparedFindings,
            sessionId: sessionState.sessionId,
            round: round.number,
            project: process.cwd(),
          });
          appendOk = true;
        } catch (err) {
          log(`warning: failed to append findings: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (resolvedFindings.length > 0) {
          try {
            backfillResolved({
              resolvedFindings,
              sessionId: sessionState.sessionId,
              resolvedInRound: round.number,
              project: process.cwd(),
            });
          } catch (err) {
            log(`warning: failed to backfill resolved findings: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (appendOk) {
          this.state.markFindingsPersisted();
        }
      }

      // Clean up progress.json — round is complete
      clearProgress(this.stateDir);

      // Mark round complete and release lock without changing session status
      this.state.updatePhase("complete");
      this.state.releaseLock();

      // Build ReviewResult. metadata.reviewer reflects every reviewer that
      // contributed to this round — both successful (round.reviews keys)
      // and failed (reviewerErrors). In crash-recovery flows where some
      // reviewers ran in an earlier process and others in this one, the
      // current `activeReviewers` list alone would understate the set.
      const reviewerNames = Array.from(
        new Set([
          ...Object.keys(round.reviews),
          ...reviewerErrors.map((e) => e.reviewer),
        ]),
      );
      const result: ReviewResult = {
        sessionId: sessionState.sessionId,
        round: round.number,
        findings: comparedFindings,
        resolvedFindings,
        reviewerErrors,
        worktreeHash: sessionState.worktreeHash,
        scope,
        thresholds: this.config.thresholds,
        metadata: {
          reviewer: reviewerNames.join(","),
          round: round.number,
          timestamp: new Date().toISOString(),
          files_reviewed: scope.files.length,
          diff_scope: scope.description,
        },
      };

      this.callbacks.onComplete?.(result);
      return result;
    } catch (err) {
      clearProgress(this.stateDir);
      this.state.fail();
      throw err;
    }
  }

  private async runReviews(
    scope: DiffScope,
    reviewers: Reviewer[],
    completedReviewerEntries?: Record<string, { status: "done"; findingsCount: number; elapsedMs: number | null }>
  ): Promise<{
    findings: Finding[];
    reviewerErrors: Array<{ reviewer: string; error: string }>;
    timings: Array<{ name: string; elapsedMs: number }>;
  }> {
    // Reviewers use spawn (async) so Promise.allSettled runs them in parallel
    const reviewerNames = reviewers.map((r) => r.name).join(", ");
    log(`dispatching reviewers: ${reviewerNames}`);
    const reviewerStartMs = Date.now();

    // Build initial progress state
    const round = this.state.getState().currentRound;
    const progress: ProgressData = {
      round,
      startedAt: new Date().toISOString(),
      reviewers: {},
    };

    // Include already-completed reviewers from crash recovery
    if (completedReviewerEntries) {
      for (const [name, entry] of Object.entries(completedReviewerEntries)) {
        progress.reviewers[name] = {
          status: entry.status,
          findingsCount: entry.findingsCount,
          elapsedMs: entry.elapsedMs,
        };
      }
    }

    // Set all active reviewers to running
    for (const reviewer of reviewers) {
      progress.reviewers[reviewer.name] = {
        status: "running",
        findingsCount: null,
        elapsedMs: null,
      };
    }
    writeProgress(this.stateDir, progress);

    const results = await Promise.allSettled(
      reviewers.map(async (reviewer) => {
        const startMs = Date.now();
        try {
          // The reviewer persists its raw output to disk itself BEFORE
          // parsing (see reviewers/raw-output.ts). The orchestrator no
          // longer writes round-N-<name>-raw.txt — doing it here meant
          // the file only existed on the success path, hiding the most
          // useful debug artefact when a reviewer failed.
          const roundNumber = this.state.getState().currentRound;
          const reviewerResult = await reviewer.review(
            this.reviewPrompt,
            scope,
            { roundNumber },
          );
          const { findings } = reviewerResult;
          const elapsedMs = reviewerResult.elapsedMs ?? (Date.now() - startMs);

          // Update progress.json — this reviewer is done
          progress.reviewers[reviewer.name] = {
            status: "done",
            findingsCount: findings.length,
            elapsedMs,
          };
          try {
            writeProgress(this.stateDir, progress);
          } catch (err) {
            log(`warning: failed to write progress for ${reviewer.name}: ${err instanceof Error ? err.message : String(err)}`);
          }

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
          return { findings, elapsedMs };
        } catch (err) {
          const elapsedMs = Date.now() - startMs;

          // Update progress.json — this reviewer errored
          progress.reviewers[reviewer.name] = {
            status: "error",
            findingsCount: null,
            elapsedMs,
          };
          try {
            writeProgress(this.stateDir, progress);
          } catch (progressErr) {
            log(`warning: failed to write progress for ${reviewer.name}: ${progressErr instanceof Error ? progressErr.message : String(progressErr)}`);
          }

          throw err;
        }
      })
    );

    const allFindings: Finding[] = [];
    const reviewerErrors: Array<{ reviewer: string; error: string }> = [];
    const timings: Array<{ name: string; elapsedMs: number }> = [];
    let succeededCount = 0;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        succeededCount++;
        allFindings.push(...result.value.findings);
        timings.push({
          name: reviewers[i].name,
          elapsedMs: result.value.elapsedMs,
        });
      } else {
        const reviewer = reviewers[i];
        const reason =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        reviewerErrors.push({ reviewer: reviewer.name, error: reason });
        timings.push({
          name: reviewer.name,
          elapsedMs: progress.reviewers[reviewer.name]?.elapsedMs ?? 0,
        });
        this.callbacks.onReviewerError?.(reviewer.name, reason);
      }
    }

    if (succeededCount === 0) {
      throw new Error("All reviewers failed — cannot determine review status");
    }

    return { findings: allFindings, reviewerErrors, timings };
  }
}
