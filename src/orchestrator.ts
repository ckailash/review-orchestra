import { readFileSync } from "fs";
import { join } from "path";
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

    try {
      while (this.state.getState().currentRound < this.config.thresholds.maxRounds) {
        const round = this.state.newRound();
        this.callbacks.onRoundStart?.(round.number);

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

        // Phase 5: Fix
        this.state.updatePhase("fixing");
        const fixReport = await runFixer(consolidated, this.stateDir, round.number, this.packageRoot);

        // Handle escalations
        if (fixReport.escalated.length > 0 && this.callbacks.onEscalation) {
          this.state.updatePhase("escalating");
          await this.callbacks.onEscalation(fixReport.escalated);
        }

        this.callbacks.onFixComplete?.(round.number);

        // Update round with fix report
        const currentRound = this.state.getCurrentRound();
        if (currentRound) {
          currentRound.fixReport = fixReport;
          currentRound.completedAt = new Date().toISOString();
        }

        // Phase 6: Re-Review (loop back)
      }

      this.state.complete();
      const summary = this.buildSummary(scope);
      this.callbacks.onComplete?.(summary);
      return summary;
    } catch (err) {
      this.state.fail();
      throw err;
    }
  }

  private async runReviews(scope: DiffScope): Promise<Finding[]> {
    // Run all reviewers in parallel
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
    for (const result of results) {
      if (result.status === "fulfilled") {
        allFindings.push(...result.value);
      }
      // Failed reviewers are logged but don't stop the pipeline
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
    const remaining = allConsolidated.filter((f) => !f.pre_existing);

    // Count total findings across all rounds
    let totalFindings = 0;
    let fixedFindings = 0;
    for (const round of state.rounds) {
      totalFindings += round.consolidated.length;
      if (round.fixReport) {
        fixedFindings += round.fixReport.fixed.length;
      }
    }

    const suggestedAction = this.suggestAction(scope);

    return {
      totalRounds: state.currentRound,
      totalFindings,
      fixedFindings,
      remainingFindings: remaining,
      preExistingFindings: preExisting,
      suggestedAction,
    };
  }

  private suggestAction(scope: DiffScope): string {
    switch (scope.type) {
      case "uncommitted":
        return "Ready to commit";
      case "branch":
        return "Ready to create PR or push";
      case "pr":
        return "Ready to merge";
    }
  }
}
