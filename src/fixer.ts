import { readFileSync } from "fs";
import { join } from "path";
import type { Finding, FixReport, PLevel } from "./types";
import { extractJson, unwrapCliEnvelope } from "./json-utils";
import { log, logTiming } from "./log";
import { spawnWithStreaming } from "./process";

const P_LEVEL_ORDER: Record<PLevel, number> = {
  p0: 0,
  p1: 1,
  p2: 2,
  p3: 3,
};

export async function runFixer(
  findings: Finding[],
  stateDir: string,
  packageRoot: string = process.cwd(),
  stopAt?: PLevel,
  fixerBin: string = "claude"
): Promise<FixReport> {
  const threshold = stopAt ? P_LEVEL_ORDER[stopAt] : Infinity;
  const fixableFindings = findings.filter(
    (f) => !f.pre_existing && P_LEVEL_ORDER[f.severity] <= threshold
  );
  if (fixableFindings.length === 0) {
    return { fixed: [], skipped: [], escalated: [] };
  }

  const fixPromptPath = join(packageRoot, "prompts", "fix.md");
  const fixPromptTemplate = readFileSync(fixPromptPath, "utf-8");
  const findingsJson = JSON.stringify(fixableFindings, null, 2);
  const fullPrompt = `${fixPromptTemplate}\n\n${findingsJson}`;

  // Strip CLAUDECODE env var so headless claude -p doesn't think it's a nested session
  const env = { ...process.env };
  delete env.CLAUDECODE;

  log(`fixer: fixing ${fixableFindings.length} findings`);
  log(`fixer: findings — ${fixableFindings.map(f => `${f.id}:${f.severity}:${f.title.slice(0, 50)}`).join(", ")}`);
  const startMs = Date.now();

  try {
    const output = await spawnWithStreaming({
      bin: fixerBin,
      args: ["-p", "-", "--allowed-tools", "Read,Grep,Glob,Bash,Edit,Write", "--output-format", "json"],
      input: fullPrompt,
      env,
      label: "fixer",
    });

    logTiming("fixer: complete", startMs);
    const report = parseFixReport(output, fixableFindings);
    log(`fixer: fixed=${report.fixed.length} skipped=${report.skipped.length} escalated=${report.escalated.length}`);
    return report;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logTiming(`fixer: FAILED — ${message.slice(0, 200)}`, startMs);
    throw new Error(`Fixer failed: ${message}`);
  }
}

function parseFixReport(
  raw: string,
  findings: Finding[]
): FixReport {
  const rawParsed = extractJson(raw);
  const parsed = rawParsed !== null ? unwrapCliEnvelope(rawParsed) : null;
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    "fixed" in (parsed as Record<string, unknown>)
  ) {
    const obj = parsed as Record<string, unknown>;
    return {
      fixed: Array.isArray(obj.fixed) ? obj.fixed : [],
      skipped: Array.isArray(obj.skipped) ? obj.skipped : [],
      escalated: Array.isArray(obj.escalated) ? obj.escalated : [],
    };
  }

  // Unparseable response — cannot confirm any fixes were applied
  return {
    fixed: [],
    skipped: findings.map((f) => f.id),
    escalated: [],
  };
}
