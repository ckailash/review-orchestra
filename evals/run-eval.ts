import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { judge, type GoldenFixture, type JudgeResult } from "./judge";
import { detectScope } from "../src/scope";
import { loadConfig } from "../src/config";
import { Orchestrator } from "../src/orchestrator";

const EVALS_DIR = join(import.meta.dirname, ".");
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
  const stateDir = join(repoDir, ".review-orchestra");

  // Run the orchestrator against the synthetic repo
  const config = loadConfig({ thresholds: { maxRounds: 1, stopAt: "p3" } });
  const scope = await detectScope();

  // Override scope to point at the fixture's files
  const fixtureFiles = listFiles(join(repoDir, "src"));
  scope.files = fixtureFiles.map((f) => f.replace(process.cwd() + "/", ""));

  const orchestrator = new Orchestrator(config, stateDir);
  const summary = await orchestrator.run(scope);

  // Gather all findings from the run
  const allFindings = [
    ...summary.remainingFindings,
    ...summary.preExistingFindings,
  ];

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
  for (const fixture of toRun) {
    try {
      const result = await runFixture(fixture, judgeModel);
      results.push(result);
    } catch (err) {
      console.error(`  FAILED: ${err}`);
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
}

main().catch(console.error);
