import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync, rmSync } from "fs";
import { detectScope } from "./scope";
import { loadConfig } from "./config";
import {
  Orchestrator,
  type OrchestratorCallbacks,
} from "./orchestrator";
import { parseArgs, detectSubcommand } from "./parse-args";
import { SessionManager } from "./state";
import { checkStale } from "./worktree-hash";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = join(process.cwd(), ".review-orchestra");

// --- Subcommand handlers ---

async function runReview(remaining: string[]): Promise<void> {
  const rawArgs = remaining.join(" ").trim();
  const args = parseArgs(rawArgs);

  // Build config overrides from parsed args
  const overrides: Parameters<typeof loadConfig>[0] = {};

  if (args.stopAt) {
    overrides.thresholds = { stopAt: args.stopAt };
  }

  if (args.disabledReviewers.length > 0 || args.onlyReviewer || Object.keys(args.models).length > 0) {
    overrides.reviewers = {};
    if (args.onlyReviewer) {
      const baseConfig = loadConfig();
      for (const name of Object.keys(baseConfig.reviewers)) {
        if (name !== args.onlyReviewer) {
          overrides.reviewers![name] = { enabled: false };
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
    scope = await detectScope(args.paths, args.commitRef);
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
      config: { reviewers: enabledReviewers, stopAt: config.thresholds.stopAt },
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
    onReviewerError(reviewer, error) {
      console.error(`[review-orchestra] WARNING: ${reviewer} failed: ${error}`);
    },
    onConsolidated(findings) {
      const actionable = findings.filter(f => !f.pre_existing);
      console.error(`[review-orchestra] Consolidated: ${actionable.length} actionable, ${findings.length - actionable.length} pre-existing`);
    },
    onComplete(result) {
      const actionable = result.findings.filter(f => !f.pre_existing);
      console.error(`[review-orchestra] Done: round ${result.round}, ${actionable.length} actionable findings, ${result.reviewerErrors.length} reviewer errors`);
    },
  };

  const orchestrator = new Orchestrator(config, STATE_DIR, callbacks, PACKAGE_ROOT);

  try {
    const result = await orchestrator.run(scope);
    // JSON result on stdout for the skill to parse
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`[review-orchestra] Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function runReset(): void {
  if (existsSync(STATE_DIR)) {
    rmSync(STATE_DIR, { recursive: true, force: true });
    console.error("[review-orchestra] Removed .review-orchestra/ directory.");
  } else {
    console.error("[review-orchestra] Nothing to reset — .review-orchestra/ does not exist.");
  }
}

function runStale(): void {
  const code = checkStale(STATE_DIR);

  switch (code) {
    case 0:
      console.error("[review-orchestra] Fresh — worktree matches last review.");
      break;
    case 1:
      console.error("[review-orchestra] Stale — worktree has changed since last review.");
      break;
    case 2:
      console.error("[review-orchestra] No session found.");
      break;
  }

  process.exit(code);
}

async function runSetup(): Promise<void> {
  // setup.ts is implemented in a separate feature (setup-doctor).
  // Check if the module exists at runtime to avoid hard compile-time dependency.
  const setupPath = join(dirname(fileURLToPath(import.meta.url)), "setup.js");
  if (!existsSync(setupPath)) {
    console.error("[review-orchestra] Setup command is not yet available.");
    process.exit(1);
  }
  const mod = await import(setupPath);
  await mod.runSetup(PACKAGE_ROOT);
}

async function runDoctor(): Promise<void> {
  // doctor.ts is implemented in a separate feature (setup-doctor).
  // Check if the module exists at runtime to avoid hard compile-time dependency.
  const doctorPath = join(dirname(fileURLToPath(import.meta.url)), "doctor.js");
  if (!existsSync(doctorPath)) {
    console.error("[review-orchestra] Doctor command is not yet available.");
    process.exit(1);
  }
  const mod = await import(doctorPath);
  await mod.runDoctor(PACKAGE_ROOT);
}

// --- Main entry point ---

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { subcommand, remaining } = detectSubcommand(argv);

  switch (subcommand) {
    case "review":
      await runReview(remaining);
      break;
    case "reset":
      runReset();
      break;
    case "stale":
      runStale();
      break;
    case "setup":
      await runSetup();
      break;
    case "doctor":
      await runDoctor();
      break;
  }
}

main();
