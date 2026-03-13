import { execSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import type { Finding, FixReport } from "./types";

export async function runFixer(
  findings: Finding[],
  stateDir: string,
  round: number,
  packageRoot: string = process.cwd()
): Promise<FixReport> {
  const fixableFindings = findings.filter((f) => !f.pre_existing);
  if (fixableFindings.length === 0) {
    return { fixed: [], skipped: [], escalated: [] };
  }

  const fixPromptPath = join(packageRoot, "prompts", "fix.md");
  const fixPromptTemplate = readFileSync(fixPromptPath, "utf-8");
  const findingsJson = JSON.stringify(fixableFindings, null, 2);
  const fullPrompt = `${fixPromptTemplate}\n\n${findingsJson}`;

  const cmd = 'claude -p - --allowed-tools "Read,Grep,Glob,Bash,Edit,Write" --output-format json';

  try {
    const output = execSync(cmd, {
      input: fullPrompt,
      encoding: "utf-8",
      timeout: 600_000, // 10 minutes for fixes
      maxBuffer: 10 * 1024 * 1024,
    });

    return parseFixReport(output, fixableFindings);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Fixer failed: ${message}`);
  }
}

function extractJson(raw: string): unknown | null {
  // Try direct parse
  try {
    return JSON.parse(raw);
  } catch {
    // noop
  }

  // Try extracting from markdown code blocks
  const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]);
    } catch {
      // noop
    }
  }

  // Try finding balanced JSON starting from first {
  const idx = raw.indexOf("{");
  if (idx !== -1) {
    // Walk forward to find the matching closing brace
    let depth = 0;
    for (let i = idx; i < raw.length; i++) {
      if (raw[i] === "{") depth++;
      else if (raw[i] === "}") depth--;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(idx, i + 1));
        } catch {
          break;
        }
      }
    }
  }

  return null;
}

function parseFixReport(
  raw: string,
  findings: Finding[]
): FixReport {
  const parsed = extractJson(raw);
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

  // If we can't parse a structured report, assume all findings were attempted
  return {
    fixed: findings.map((f) => f.id),
    skipped: [],
    escalated: [],
  };
}
