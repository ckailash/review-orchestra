import { execFileSync } from "child_process";
import type { Finding } from "../src/types";
import { extractJson, unwrapCliEnvelope } from "../src/json-utils";

export interface GoldenFinding {
  description: string;
  expected_impact: string;
  expected_confidence: string;
}

export interface GoldenFixture {
  fixture: string;
  expected_findings: GoldenFinding[];
}

export interface JudgeResult {
  fixture: string;
  precision: number;
  recall: number;
  severity_accuracy: number;
  matched: { golden: GoldenFinding; actual: Finding }[];
  missed: GoldenFinding[];
  hallucinated: Finding[];
}

export async function judge(
  fixture: string,
  actualFindings: Finding[],
  golden: GoldenFixture,
  judgeModel: string = "claude-sonnet-4-6"
): Promise<JudgeResult> {
  const prompt = buildJudgePrompt(actualFindings, golden);

  try {
    const output = execFileSync("claude", ["-p", "-", "--model", judgeModel, "--output-format", "json"], {
      input: prompt,
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    return parseJudgeOutput(fixture, output, actualFindings, golden);
  } catch {
    // Fallback: simple string matching
    return fallbackJudge(fixture, actualFindings, golden);
  }
}

export function buildJudgePrompt(
  actual: Finding[],
  golden: GoldenFixture
): string {
  return `You are evaluating a code review tool's output against expected findings.

## Expected Findings (golden)
${JSON.stringify(golden.expected_findings, null, 2)}

## Actual Findings (from tool)
${JSON.stringify(
  actual.map((f) => ({
    id: f.id,
    file: f.file,
    line: f.line,
    title: f.title,
    description: f.description,
    confidence: f.confidence,
    impact: f.impact,
  })),
  null,
  2
)}

## Task
For each expected finding, determine if any actual finding matches it (same underlying issue, not necessarily same wording).
For each actual finding, determine if it's a real issue or a hallucination.

## Matching Examples

### Example: Match (same underlying issue, different wording)
Golden: "SQL injection via unsanitized user input in query builder"
Actual: "User-controlled string concatenated into SQL query without parameterization"
→ These describe the same vulnerability (SQL injection from unsanitized input). This IS a match.

### Example: Non-match (similar-sounding but different underlying issue)
Golden: "Race condition in concurrent file writes allows data corruption"
Actual: "File descriptor leak when write errors are not caught"
→ Both involve file operations, but one is a race condition and the other is a resource leak. This is NOT a match.

Output JSON:
{
  "matches": [
    { "golden_index": 0, "actual_id": "f-001" }
  ],
  "hallucinated_ids": ["f-003"],
  "missed_golden_indices": [2]
}`;
}

export function parseJudgeOutput(
  fixture: string,
  raw: string,
  actual: Finding[],
  golden: GoldenFixture
): JudgeResult {
  try {
    const extracted = extractJson(raw);
    if (!extracted || typeof extracted !== "object") return fallbackJudge(fixture, actual, golden);

    const parsed = unwrapCliEnvelope(extracted) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || !("matches" in parsed)) return fallbackJudge(fixture, actual, golden);
    const rawMatches = (parsed.matches ?? []) as { golden_index: number; actual_id: string }[];

    // Filter out matches with out-of-range golden_index
    const validRawMatches = rawMatches.filter(
      (m) => m.golden_index >= 0 && m.golden_index < golden.expected_findings.length
    );

    // Deduplicate matches by both golden_index and actual_id
    const seenGolden = new Set<number>();
    const seenActual = new Set<string>();
    const matches: typeof validRawMatches = [];
    for (const m of validRawMatches) {
      if (!seenGolden.has(m.golden_index) && !seenActual.has(m.actual_id)) {
        seenGolden.add(m.golden_index);
        seenActual.add(m.actual_id);
        matches.push(m);
      }
    }

    const actualById = new Map(actual.map((f) => [f.id, f]));

    // Filter matches to only those whose actual_id resolves to an existing finding
    const resolvedMatches = matches.filter(
      (m: { golden_index: number; actual_id: string }) => actualById.has(m.actual_id)
    );

    const matched = resolvedMatches
      .map(
        (m: { golden_index: number; actual_id: string }) => ({
          golden: golden.expected_findings[m.golden_index],
          actual: actualById.get(m.actual_id)!,
        })
      );

    // Compute matched golden indices and actual IDs from resolved matches
    const matchedGoldenIndices = new Set(
      resolvedMatches.map((m) => m.golden_index)
    );
    const matchedActualIds = new Set(
      resolvedMatches.map((m) => m.actual_id)
    );

    // Compute missed: golden indices not present in valid matches
    const missed: GoldenFinding[] = [];
    for (let i = 0; i < golden.expected_findings.length; i++) {
      if (!matchedGoldenIndices.has(i)) {
        missed.push(golden.expected_findings[i]);
      }
    }

    // Compute hallucinated: actual IDs not present in valid matches
    const hallucinated = actual.filter((f) => !matchedActualIds.has(f.id));

    const totalExpected = golden.expected_findings.length;
    const totalActual = actual.length;
    const truePositives = matched.length;
    const severityCorrect = matched.filter(
      (m) =>
        m.golden.expected_confidence === m.actual.confidence &&
        m.golden.expected_impact === m.actual.impact
    ).length;

    return {
      fixture,
      precision: totalActual > 0 ? truePositives / totalActual : 1,
      recall: totalExpected > 0 ? truePositives / totalExpected : 1,
      severity_accuracy:
        truePositives > 0 ? severityCorrect / truePositives : 0,
      matched,
      missed,
      hallucinated,
    };
  } catch {
    return fallbackJudge(fixture, actual, golden);
  }
}

export function fallbackJudge(
  fixture: string,
  actual: Finding[],
  golden: GoldenFixture
): JudgeResult {
  // Simple heuristic: match by keyword overlap
  const matched: { golden: GoldenFinding; actual: Finding }[] = [];
  const usedActual = new Set<string>();

  for (const g of golden.expected_findings) {
    const keywords = g.description.toLowerCase().split(/\s+/);
    const match = actual.find(
      (a) =>
        !usedActual.has(a.id) &&
        keywords.some(
          (k) =>
            k.length > 5 &&
            (a.title.toLowerCase().includes(k) ||
              a.description.toLowerCase().includes(k))
        )
    );
    if (match) {
      matched.push({ golden: g, actual: match });
      usedActual.add(match.id);
    }
  }

  const missed = golden.expected_findings.filter(
    (g) => !matched.some((m) => m.golden === g)
  );
  const hallucinated = actual.filter((a) => !usedActual.has(a.id));
  const totalExpected = golden.expected_findings.length;
  const totalActual = actual.length;

  return {
    fixture,
    precision: totalActual > 0 ? matched.length / totalActual : 1,
    recall: totalExpected > 0 ? matched.length / totalExpected : 1,
    severity_accuracy: 0, // Can't assess without LLM judge
    matched,
    missed,
    hallucinated,
  };
}
