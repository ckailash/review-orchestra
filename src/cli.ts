import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { detectScope } from "./scope";
import { loadConfig } from "./config";
import {
  Orchestrator,
  type OrchestratorCallbacks,
} from "./orchestrator";
import { parseArgs } from "./parse-args";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2).join(" ").trim();
  const args = parseArgs(rawArgs);

  // Build config overrides from parsed args
  const overrides: Parameters<typeof loadConfig>[0] = {};

  if (args.stopAt || args.maxRounds) {
    overrides.thresholds = {};
    if (args.stopAt) overrides.thresholds.stopAt = args.stopAt;
    if (args.maxRounds) overrides.thresholds.maxRounds = args.maxRounds;
  }

  if (args.disabledReviewers.length > 0 || args.onlyReviewer || Object.keys(args.models).length > 0) {
    overrides.reviewers = {};
    if (args.onlyReviewer) {
      for (const name of ["claude", "codex"]) {
        if (name !== args.onlyReviewer) {
          overrides.reviewers[name] = { enabled: false };
        }
      }
    }
    for (const name of args.disabledReviewers) {
      overrides.reviewers[name] = { enabled: false };
    }
    for (const [reviewer, model] of Object.entries(args.models)) {
      overrides.reviewers[reviewer] = { ...overrides.reviewers[reviewer], model };
    }
  }

  const config = loadConfig(overrides);

  // Detect scope
  console.error("[review-orchestra] Detecting scope...");
  let scope;
  try {
    scope = await detectScope(args.paths);
  } catch (err) {
    console.error(`[review-orchestra] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.error(`[review-orchestra] Scope: ${scope.description}`);
  console.error(`[review-orchestra] Files: ${scope.files.length}`);

  // Dry run — just show what would happen
  if (args.dryRun) {
    const enabledReviewers = Object.entries(config.reviewers)
      .filter(([, c]) => c.enabled)
      .map(([name]) => name);
    console.log(JSON.stringify({
      dryRun: true,
      scope: { type: scope.type, description: scope.description, files: scope.files },
      config: { reviewers: enabledReviewers, stopAt: config.thresholds.stopAt, maxRounds: config.thresholds.maxRounds },
    }, null, 2));
    return;
  }

  // Callbacks for status output on stderr
  const callbacks: OrchestratorCallbacks = {
    onPreflightWarning(warnings) {
      for (const w of warnings) console.error(`[review-orchestra] WARNING: ${w}`);
    },
    onRoundStart(round) {
      console.error(`[review-orchestra] === Round ${round} ===`);
    },
    onReviewComplete(reviewer, findings) {
      console.error(`[review-orchestra] ${reviewer}: ${findings.length} findings`);
    },
    onConsolidated(findings) {
      const actionable = findings.filter(f => !f.pre_existing);
      console.error(`[review-orchestra] Consolidated: ${actionable.length} actionable, ${findings.length - actionable.length} pre-existing`);
    },
    onFixComplete(round) {
      console.error(`[review-orchestra] Round ${round} fixes applied`);
    },
    async onEscalation(items) {
      console.error(`[review-orchestra] ${items.length} finding(s) escalated — requires human decision`);
    },
    onComplete(summary) {
      console.error(`[review-orchestra] Done: ${summary.totalRounds} round(s), ${summary.fixedFindings} fixed, ${summary.remainingFindings.length} remaining`);
    },
  };

  const stateDir = join(process.cwd(), ".review-orchestra");
  const orchestrator = new Orchestrator(config, stateDir, callbacks, PACKAGE_ROOT);

  try {
    const summary = await orchestrator.run(scope);
    // JSON summary on stdout for the skill to parse
    console.log(JSON.stringify(summary, null, 2));
  } catch (err) {
    console.error(`[review-orchestra] Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
