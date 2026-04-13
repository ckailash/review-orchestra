import { readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, mkdtempSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import {
  judge,
  judgeMultiRound,
  isMultiRoundGolden,
  isMultiRoundJudge,
  type GoldenFixture,
  type SingleRoundGolden,
  type MultiRoundGolden,
  type JudgeResult,
  type MultiRoundJudgeResult,
} from "./judge";
import { loadConfig } from "../src/config";
import { Orchestrator } from "../src/orchestrator";
import type { DiffScope, SessionState } from "../src/types";

const EVALS_DIR = join(dirname(fileURLToPath(import.meta.url)), ".");
const GOLDEN_DIR = join(EVALS_DIR, "golden");
const REPOS_DIR = join(EVALS_DIR, "repos");
const RESULTS_DIR = join(EVALS_DIR, "results");

interface EvalResult {
  fixture: string;
  judge: JudgeResult | MultiRoundJudgeResult;
  timestamp: string;
}


async function runFixture(
  fixtureName: string,
  golden: SingleRoundGolden,
  judgeModel: string
): Promise<EvalResult> {
  console.log(`\n--- Running eval: ${fixtureName} ---`);

  const repoDir = join(REPOS_DIR, fixtureName);

  // Copy fixture to a temp directory so the originals are never mutated
  const tempDir = mkdtempSync(join(tmpdir(), `eval-${fixtureName}-`));
  cpSync(repoDir, tempDir, { recursive: true });

  const stateDir = join(tempDir, ".review-orchestra");

  const config = loadConfig({ thresholds: { stopAt: "p3" } });

  // Init a git repo in the temp dir so orchestrator and reviewers work
  try {
    execFileSync("git", ["init"], { cwd: tempDir, stdio: "pipe" });
    execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "pipe" });
    execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@test", "commit", "-m", "init"], { cwd: tempDir, stdio: "pipe" });
  } catch (err) {
    throw new Error(`Failed to initialize git repo for fixture ${fixtureName}: ${err}`);
  }

  // Build a synthetic scope from the fixture's files
  const fixtureFiles = listFiles(tempDir);
  const relativeFiles = fixtureFiles.map((f) => f.replace(tempDir + "/", ""));

  // Generate a diff covering all fixture files so the consolidator can
  // correctly tag findings as new (not pre-existing).
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

async function runMultiRoundFixture(
  fixtureName: string,
  golden: MultiRoundGolden,
  judgeModel: string
): Promise<EvalResult> {
  console.log(`\n--- Running multi-round eval: ${fixtureName} ---`);

  const repoDir = join(REPOS_DIR, fixtureName);
  const patchDir = join(EVALS_DIR, fixtureName, "patches");

  // Copy fixture to a temp directory
  const tempDir = mkdtempSync(join(tmpdir(), `eval-${fixtureName}-`));
  cpSync(repoDir, tempDir, { recursive: true });

  const stateDir = join(tempDir, ".review-orchestra");

  // Pin heuristic comparison — eval tests orchestration plumbing, not LLM matching (F6)
  const config = loadConfig({
    thresholds: { stopAt: "p3" },
    findingComparison: { method: "heuristic", model: "", timeoutMs: 0, fallback: "heuristic" },
  });

  // Init git repo
  try {
    execFileSync("git", ["init"], { cwd: tempDir, stdio: "pipe" });
    execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "pipe" });
    execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@test", "commit", "-m", "init"], { cwd: tempDir, stdio: "pipe" });
  } catch (err) {
    throw new Error(`Failed to initialize git repo for fixture ${fixtureName}: ${err}`);
  }

  // Build round-1 scope (all code is new)
  const fixtureFiles = listFiles(tempDir);
  const relativeFiles = fixtureFiles.map((f) => f.replace(tempDir + "/", ""));

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

  const originalCwd = process.cwd();
  process.chdir(tempDir);
  const orchestrator = new Orchestrator(config, stateDir, {}, originalCwd);

  try {
    // === Round 1 ===
    const round1Result = await orchestrator.run(scope);

    // Read round-1 findings from state for judging
    const statePath = join(stateDir, "session.json");
    const state1: SessionState = JSON.parse(readFileSync(statePath, "utf-8"));
    const round1Findings = state1.rounds[0]?.consolidated ?? [];

    // Build id_map: golden description → actual round-1 ID (F12)
    const round1Golden = golden.rounds[0];
    const round1SingleGolden: SingleRoundGolden = {
      fixture: golden.fixture,
      expected_findings: round1Golden.expected_findings,
    };
    const round1Judge = await judge(golden.fixture, round1Findings, round1SingleGolden, judgeModel);

    const idMap: Record<string, string> = {};
    for (const match of round1Judge.matched) {
      idMap[match.golden.description] = match.actual.id;
    }

    console.log(`  Round 1: precision=${(round1Judge.precision * 100).toFixed(1)}% recall=${(round1Judge.recall * 100).toFixed(1)}%`);

    // === Apply patch ===
    const patchFile = fixtureName === "multi-round-all-resolved"
      ? join(patchDir, "fix-all.patch")
      : join(patchDir, "fix-round1.patch");

    execFileSync("git", ["apply", "--whitespace=fix", patchFile], { cwd: tempDir, stdio: "pipe" });
    execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "pipe" });
    execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@test", "commit", "-m", "apply fix"], { cwd: tempDir, stdio: "pipe" });

    // === Build round-2 scope (F2, F15) ===
    // diff = only the patch delta (so consolidator correctly tags pre_existing)
    const round2Diff = execFileSync("git", ["diff", "HEAD~1"], {
      encoding: "utf-8",
      cwd: tempDir,
    }).trim();

    // files = full file list (same as round 1) — reviewers need all files in scope
    const round2Files = listFiles(tempDir).map((f) => f.replace(tempDir + "/", ""));

    const newScope: DiffScope = {
      type: scope.type,
      diff: round2Diff,
      files: round2Files,
      baseBranch: scope.baseBranch,
      description: scope.description,
    };

    // === Round 2 ===
    const round2Result = await orchestrator.run(newScope);

    // Read round-2 findings
    const state2: SessionState = JSON.parse(readFileSync(statePath, "utf-8"));
    const round2Findings = state2.rounds[1]?.consolidated ?? [];

    // Judge round 2
    const round2Golden = golden.rounds[1];
    const round2SingleGolden: SingleRoundGolden = {
      fixture: golden.fixture,
      expected_findings: round2Golden.expected_findings,
    };
    const round2Judge = await judge(golden.fixture, round2Findings, round2SingleGolden, judgeModel);

    console.log(`  Round 2: precision=${(round2Judge.precision * 100).toFixed(1)}% recall=${(round2Judge.recall * 100).toFixed(1)}%`);

    // === Cross-round judging ===
    const multiResult = judgeMultiRound(
      [round1Judge, round2Judge],
      golden,
      [round1Result.resolvedFindings, round2Result.resolvedFindings],
      idMap,
    );

    const fmtCk = (c: { pass: boolean; checked: number; total: number }) =>
      `${c.pass} (${c.checked}/${c.total})`;
    console.log(`  Cross-round: status=${fmtCk(multiResult.status_correct)} pre_existing=${fmtCk(multiResult.pre_existing_correct)} ids_exact=${fmtCk(multiResult.persisting_ids_exact)}+${fmtCk(multiResult.resolved_ids_exact)} metadata_fresh=${fmtCk(multiResult.persisting_metadata_fresh)}`);
    console.log(`  Resolved: ${multiResult.resolved_matched}/${multiResult.resolved_total}`);

    return {
      fixture: fixtureName,
      judge: multiResult,
      timestamp: new Date().toISOString(),
    };
  } finally {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const EXCLUDED_DIRS = new Set([".git", ".review-orchestra"]);

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
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
  for (const fixtureName of toRun) {
    try {
      const goldenPath = join(GOLDEN_DIR, `${fixtureName}.json`);
      const golden = JSON.parse(readFileSync(goldenPath, "utf-8")) as GoldenFixture;

      let result: EvalResult;
      if (isMultiRoundGolden(golden)) {
        result = await runMultiRoundFixture(fixtureName, golden, judgeModel);
      } else {
        result = await runFixture(fixtureName, golden, judgeModel);
      }
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
  const fmt = (n: number) => (n * 100).toFixed(0);
  console.log("\n=== EVAL SUMMARY ===");
  for (const r of results) {
    if (isMultiRoundJudge(r.judge)) {
      const mr = r.judge;
      for (let i = 0; i < mr.rounds.length; i++) {
        const rj = mr.rounds[i];
        console.log(`${r.fixture} r${i + 1}: precision=${fmt(rj.precision)}% recall=${fmt(rj.recall)}%`);
      }
      const fmtCheck = (c: { pass: boolean; checked: number; total: number }) =>
        `${c.pass} (${c.checked}/${c.total})`;
      const idsExact = mr.persisting_ids_exact.pass && mr.resolved_ids_exact.pass;
      const idsChecked = mr.persisting_ids_exact.checked + mr.resolved_ids_exact.checked;
      const idsTotal = mr.persisting_ids_exact.total + mr.resolved_ids_exact.total;
      console.log(`${r.fixture} cross-round: status=${fmtCheck(mr.status_correct)} pre_existing=${fmtCheck(mr.pre_existing_correct)} ids_exact=${idsExact} (${idsChecked}/${idsTotal}) metadata_fresh=${fmtCheck(mr.persisting_metadata_fresh)}`);
    } else {
      console.log(
        `${r.fixture}: precision=${fmt(r.judge.precision)}% recall=${fmt(r.judge.recall)}%`
      );
    }
  }

  if (hasFailure) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
