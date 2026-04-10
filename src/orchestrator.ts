import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { log } from "./log";
import type {
  Config,
  DiffScope,
  EscalationItem,
  Finding,
  PLevel,
} from "./types";
import { StateManager } from "./state";
import { consolidate } from "./consolidator";
import { createReviewers } from "./reviewers/index";
import { runFixer } from "./fixer";
import type { Reviewer } from "./reviewers/types";
import { detectToolchain, formatToolchainContext } from "./toolchain";
import { runPreflight } from "./preflight";

const P_LEVEL_ORDER: Record<PLevel, number> = {
  p0: 0,
  p1: 1,
  p2: 2,
  p3: 3,
};

export interface OrchestratorCallbacks {
  onPreflightWarning?(warnings: string[]): void;
  onRoundStart?(round: number): void;
  onReviewComplete?(reviewer: string, findings: Finding[]): void;
  onReviewerError?(reviewer: string, error: string): void;
  onConsolidated?(findings: Finding[]): void;
  onFixComplete?(round: number): void;
  onEscalation?(items: EscalationItem[]): Promise<void>;
  onComplete?(summary: OrchestratorSummary): void;
}

export interface OrchestratorSummary {
  totalRounds: number;
  totalFindings: number;
  fixedFindings: number;
  remainingFindings: Finding[];
  preExistingFindings: Finding[];
  escalatedFindings: EscalationItem[];
  suggestedAction: string;
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

  async run(scope: DiffScope): Promise<OrchestratorSummary> {
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

    let paused = false;
    try {
      while (this.state.getState().currentRound < this.config.thresholds.maxRounds) {
        const round = this.state.newRound();
        this.callbacks.onRoundStart?.(round.number);

        // On re-review rounds, regenerate diff to reflect fixer changes
        if (round.number > 1) {
          scope = { ...scope, diff: this.regenerateDiff(scope) };
        }

        // Phase 2: Parallel Review
        this.state.updatePhase("reviewing");
        const allFindings = await this.runReviews(scope);

        // Phase 3: Consolidation
        this.state.updatePhase("consolidating");
        const consolidated = consolidate(allFindings, scope.diff);
        this.state.saveConsolidated(consolidated);
        this.callbacks.onConsolidated?.(consolidated);

        // Phase 4: Stop Condition Check
        this.state.updatePhase("checking");
        if (this.shouldStop(consolidated)) {
          break;
        }

        // Phase 5: Fix — validate fixer binary before attempting
        this.state.updatePhase("fixing");
        const claudeConfig = this.config.reviewers.claude;
        const fixerBin = claudeConfig?.enabled
          ? claudeConfig.command.trim().split(/\s+/)[0]
          : "claude";
        try {
          execFileSync("which", [fixerBin], { stdio: "pipe" });
        } catch {
          throw new Error(
            `Fixer requires '${fixerBin}' CLI but it is not on PATH. Install from https://docs.anthropic.com/en/docs/claude-code`
          );
        }
        const fixReport = await runFixer(
          consolidated,
          this.stateDir,
          this.packageRoot,
          this.config.thresholds.stopAt,
          fixerBin
        );

        // Persist fix report immediately — before escalation or any break
        const currentRound = this.state.getCurrentRound();
        if (currentRound) {
          currentRound.fixReport = fixReport;
          currentRound.completedAt = new Date().toISOString();
          this.state.persist();
        }

        // Handle escalations — consult config flags before invoking callback
        if (fixReport.escalated.length > 0 && this.callbacks.onEscalation) {
          const { pauseOnAmbiguity, pauseOnConflict } = this.config.escalation;
          if (pauseOnAmbiguity || pauseOnConflict) {
            this.state.updatePhase("escalating");
            await this.callbacks.onEscalation(fixReport.escalated);
            // Pause orchestration until human resolves the escalated items
            this.state.getState().status = "paused";
            this.state.persist();
            paused = true;
            break;
          }
        }

        this.callbacks.onFixComplete?.(round.number);

        // Phase 6: Re-Review (loop back)
      }

      if (!paused) {
        this.state.complete();
      }
      const summary = this.buildSummary(scope);
      this.callbacks.onComplete?.(summary);
      return summary;
    } catch (err) {
      this.state.fail();
      throw err;
    }
  }

  private async runReviews(scope: DiffScope): Promise<Finding[]> {
    // Reviewers use spawn (async) so Promise.allSettled runs them in parallel
    const reviewerNames = this.reviewers.map(r => r.name).join(", ");
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
    let succeededCount = 0;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        succeededCount++;
        allFindings.push(...result.value);
      } else {
        const reviewer = this.reviewers[i];
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.callbacks.onReviewerError?.(reviewer.name, reason);
      }
    }

    if (succeededCount === 0) {
      throw new Error("All reviewers failed — cannot determine review status");
    }

    return allFindings;
  }

  private shouldStop(consolidated: Finding[]): boolean {
    const threshold = P_LEVEL_ORDER[this.config.thresholds.stopAt];
    const actionable = consolidated.filter(
      (f) => !f.pre_existing && P_LEVEL_ORDER[f.severity] <= threshold
    );
    return actionable.length === 0;
  }

  private buildSummary(scope: DiffScope): OrchestratorSummary {
    const state = this.state.getState();
    const lastRound = state.rounds[state.rounds.length - 1];
    const allConsolidated = lastRound?.consolidated ?? [];

    const preExisting = allConsolidated.filter((f) => f.pre_existing);

    // Only count findings as resolved after a subsequent review round confirms
    // they disappeared. Self-reported fix results are not subtracted because
    // the last round's fixes may not have been verified by a re-review.
    const remaining = allConsolidated.filter((f) => !f.pre_existing);

    // Count total findings across all rounds and collect escalations
    let totalFindings = 0;
    let fixedFindings = 0;
    const allEscalated: EscalationItem[] = [];
    for (const round of state.rounds) {
      totalFindings += round.consolidated.length;
      if (round.fixReport) {
        fixedFindings += round.fixReport.fixed.length;
        allEscalated.push(...round.fixReport.escalated);
      }
    }

    const suggestedAction = this.suggestAction(scope, remaining);

    return {
      totalRounds: state.currentRound,
      totalFindings,
      fixedFindings,
      remainingFindings: remaining,
      preExistingFindings: preExisting,
      escalatedFindings: allEscalated,
      suggestedAction,
    };
  }

  private regenerateDiff(scope: DiffScope): string {
    try {
      if (scope.type === "commit") {
        // Commit ranges reference fixed points in history that don't change
        // between rounds. Regenerating with just baseBranch would alter the
        // reviewed scope (e.g. A..B becomes git diff A, pulling in unrelated
        // changes). Return the original diff unchanged.
        return scope.diff;
      }
      if (scope.type === "uncommitted") {
        // Tracked changes (staged + unstaged)
        const trackedDiff = execFileSync("git", ["diff", "HEAD"], {
          encoding: "utf-8",
          maxBuffer: 1024 * 1024,
        }).trim();

        // Untracked (new) files — mirrors detectScope in scope.ts
        const untrackedOutput = execFileSync(
          "git",
          ["ls-files", "--others", "--exclude-standard"],
          { encoding: "utf-8", maxBuffer: 1024 * 1024 }
        ).trim();
        const untrackedFiles = untrackedOutput
          .split("\n")
          .map((f) => f.trim())
          .filter(Boolean);
        const untrackedDiffs = untrackedFiles
          .map((file) => {
            try {
              return execFileSync(
                "git",
                ["diff", "--no-index", "/dev/null", file],
                { encoding: "utf-8", maxBuffer: 1024 * 1024 }
              ).trim();
            } catch (err) {
              if (err && typeof err === "object" && "stdout" in err) {
                return String((err as { stdout: string }).stdout).trim();
              }
              return "";
            }
          })
          .filter(Boolean);

        return [trackedDiff, ...untrackedDiffs].filter(Boolean).join("\n");
      }
      if (scope.baseBranch) {
        // Two-dot diff to include working tree changes from the fixer
        return execFileSync("git", ["diff", scope.baseBranch], {
          encoding: "utf-8",
          maxBuffer: 1024 * 1024,
        }).trim();
      }
      return execFileSync("git", ["diff", "HEAD"], {
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
      }).trim();
    } catch {
      // If regeneration fails, fall back to original diff
      return scope.diff;
    }
  }

  private suggestAction(scope: DiffScope, remainingFindings: Finding[]): string {
    if (remainingFindings.length > 0) {
      return `${remainingFindings.length} finding(s) remain — review before proceeding`;
    }
    switch (scope.type) {
      case "uncommitted":
        return "Ready to commit";
      case "branch":
        return "Ready to create PR or push";
      case "pr":
        return "Ready to merge";
      case "commit":
        return "Review complete";
    }
  }
}
