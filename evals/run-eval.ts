import { readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, mkdtempSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { judge, type GoldenFixture, type JudgeResult } from "./judge";
import { loadConfig } from "../src/config";
import { Orchestrator } from "../src/orchestrator";
import type { DiffScope, SessionState } from "../src/types";

const EVALS_DIR = join(dirname(fileURLToPath(import.meta.url)), ".");
const GOLDEN_DIR = join(EVALS_DIR, "golden");
const REPOS_DIR = join(EVALS_DIR, "repos");
const RESULTS_DIR = join(EVALS_DIR, "results");

interface EvalResult {
  fixture: string;
  judge: JudgeResult;
  timestamp: string;
}

async function runFixture(
  fixtureName: string,
  judgeModel: string
): Promise<EvalResult> {
  console.log(`\n--- Running eval: ${fixtureName} ---`);

  const goldenPath = join(GOLDEN_DIR, `${fixtureName}.json`);
  const golden: GoldenFixture = JSON.parse(readFileSync(goldenPath, "utf-8"));

  const repoDir = join(REPOS_DIR, fixtureName);

  // Copy fixture to a temp directory so the originals are never mutated
  const tempDir = mkdtempSync(join(tmpdir(), `eval-${fixtureName}-`));
  cpSync(repoDir, tempDir, { recursive: true });

  const stateDir = join(tempDir, ".review-orchestra");

  const config = loadConfig({ thresholds: { stopAt: "p3" } });

  // Build a synthetic scope from the fixture's files
  const fixtureFiles = listFiles(join(tempDir, "src"));
  const relativeFiles = fixtureFiles.map((f) => f.replace(tempDir + "/", ""));

  // Generate a diff covering all fixture files so the consolidator can
  // correctly tag findings as new (not pre-existing).
  const { execFileSync } = await import("child_process");
  const fixtureDiffs = relativeFiles.map((f) => {
    try {
      return execFileSync("git", ["diff", "--no-index", "/dev/null", f], {
        encoding: "utf-8",
        cwd: tempDir,
      }).trim();
    } catch (err) {
      if (err && typeof err === "object" && "stdout" in err) {
        return String((err as { stdout: string }).stdout).trim();
      }
      return "";
    }
  });

  const scope: DiffScope = {
    type: "uncommitted",
    diff: fixtureDiffs.filter(Boolean).join("\n"),
    files: relativeFiles,
    baseBranch: "main",
    description: `Eval fixture: ${fixtureName}`,
  };

  // Switch cwd so reviewer subprocesses resolve files against the fixture copy
  const originalCwd = process.cwd();
  process.chdir(tempDir);
  const orchestrator = new Orchestrator(config, stateDir, {}, originalCwd);
  try {
    const reviewResult = await orchestrator.run(scope);

    // Read consolidated findings from state — includes findings that were auto-fixed,
    // which summary.remainingFindings omits. Judging post-fix results would score
    // successfully-found-and-fixed issues as misses.
    const statePath = join(stateDir, "session.json");
    const state: SessionState = JSON.parse(readFileSync(statePath, "utf-8"));

    // Aggregate findings across all rounds
    const findingMap = new Map<string, (typeof state.rounds)[number]["consolidated"][number]>();
    for (const round of state.rounds) {
      for (const f of round.consolidated) {
        const key = `${f.file}:${f.line}:${f.title}`;
        findingMap.set(key, f);
      }
    }
    const allFindings = [...findingMap.values()];

    // Judge the results
    const result = await judge(fixtureName, allFindings, golden, judgeModel);

    console.log(`  Precision: ${(result.precision * 100).toFixed(1)}%`);
    console.log(`  Recall:    ${(result.recall * 100).toFixed(1)}%`);
    console.log(`  Severity:  ${(result.severity_accuracy * 100).toFixed(1)}%`);
    console.log(`  Matched:   ${result.matched.length}/${golden.expected_findings.length}`);
    console.log(`  Missed:    ${result.missed.length}`);
    console.log(`  Hallucinated: ${result.hallucinated.length}`);

    return {
      fixture: fixtureName,
      judge: result,
      timestamp: new Date().toISOString(),
    };
  } finally {
    // Restore cwd before deleting tempDir
    process.chdir(originalCwd);
    // Clean up temp directory
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  let judgeModel = "claude-sonnet-4-6";
  const fixtures: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--judge-model" && args[i + 1]) {
      judgeModel = args[++i];
    } else {
      fixtures.push(args[i]);
    }
  }

  // If no fixtures specified, run all
  const toRun =
    fixtures.length > 0
      ? fixtures
      : readdirSync(REPOS_DIR, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);

  mkdirSync(RESULTS_DIR, { recursive: true });

  const results: EvalResult[] = [];
  let hasFailure = false;
  for (const fixture of toRun) {
    try {
      const result = await runFixture(fixture, judgeModel);
      results.push(result);
    } catch (err) {
      console.error(`  FAILED: ${err}`);
      hasFailure = true;
    }
  }

  // Save results
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(RESULTS_DIR, `eval-${timestamp}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${outPath}`);

  // Summary
  console.log("\n=== EVAL SUMMARY ===");
  for (const r of results) {
    console.log(
      `${r.fixture}: precision=${(r.judge.precision * 100).toFixed(0)}% recall=${(r.judge.recall * 100).toFixed(0)}%`
    );
  }

  if (hasFailure) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
