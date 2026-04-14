import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync, readFileSync, rmSync } from "fs";
import { detectScope } from "./scope";
import { loadConfig, mergeConfig } from "./config";
import {
  Orchestrator,
  type OrchestratorCallbacks,
} from "./orchestrator";
import { parseArgs, detectSubcommand } from "./parse-args";
import { checkStale } from "./worktree-hash";
import { runSetup as runSetupCmd } from "./setup.js";
import { runDoctor as runDoctorCmd } from "./doctor.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = join(process.cwd(), ".review-orchestra");

// --- Subcommand handlers ---

async function runReview(remaining: string[]): Promise<void> {
  // Preserve argv boundaries when joining: any argv element containing
  // whitespace, a double quote, or a backslash is wrapped in double quotes
  // with `\` and `"` escaped, so parseArgs's tokenizer can losslessly recover
  // the original token. Without escaping backslashes, an arg like `foo\\bar`
  // would round-trip as `foo\bar` (a backslash eaten by the unescape step).
  const rawArgs = remaining
    .map((a) => {
      if (!/[\s"\\]/.test(a)) return a;
      const escaped = a.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `"${escaped}"`;
    })
    .join(" ")
    .trim();
  const args = parseArgs(rawArgs);

  // Build config overrides from parsed args. We load the base config
  // once up front so we can iterate `baseConfig.reviewers` for
  // `onlyReviewer`, then merge overrides into that same object below
  // without a second disk read.
  const baseConfig = loadConfig();
  const overrides: Parameters<typeof loadConfig>[0] = {};

  if (args.stopAt) {
    overrides.thresholds = { stopAt: args.stopAt };
  }

  if (args.disabledReviewers.length > 0 || args.onlyReviewer || Object.keys(args.models).length > 0) {
    overrides.reviewers = {};
    if (args.onlyReviewer) {
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

  // Route overrides through mergeConfig so any new fields automatically
  // get the same validation as file-loaded config, and to keep the merge
  // semantics in one place (config.ts).
  const config =
    Object.keys(overrides).length === 0
      ? baseConfig
      : mergeConfig(baseConfig, overrides as Record<string, unknown>);

  // Detect scope
  console.error("[review-orchestra] Detecting scope...");
  let scope;
  try {
    scope = detectScope(args.paths, args.commitRef);
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
    onReviewComplete(_reviewer, _findings) {
      // Per-reviewer done message is now logged by the reviewer adapter itself
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
  // Read session to get last worktree hash
  let lastHash: string | null = null;
  const sessionFile = join(STATE_DIR, "session.json");
  if (existsSync(sessionFile)) {
    try {
      const raw = readFileSync(sessionFile, "utf-8");
      const state = JSON.parse(raw);
      if (state.rounds?.length > 0) {
        const lastRound = state.rounds[state.rounds.length - 1];
        lastHash = lastRound?.worktreeHash ?? null;
      }
    } catch {
      // Can't read session — treat as no session
    }
  }

  const code = checkStale(lastHash);

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
  await runSetupCmd(PACKAGE_ROOT);
}

async function runDoctor(): Promise<void> {
  await runDoctorCmd(PACKAGE_ROOT);
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
    default: {
      const _exhaustive: never = subcommand;
      throw new Error(`Unknown subcommand: ${String(_exhaustive)}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(
    `[review-orchestra] Fatal: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
