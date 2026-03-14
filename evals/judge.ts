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

function buildJudgePrompt(
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

Output JSON:
{
  "matches": [
    { "golden_index": 0, "actual_id": "f-001", "severity_match": true }
  ],
  "hallucinated_ids": ["f-003"],
  "missed_golden_indices": [2]
}`;
}

function parseJudgeOutput(
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
    const rawMatches = (parsed.matches ?? []) as { golden_index: number; actual_id: string; severity_match: boolean }[];
    const hallucinatedIds = new Set(parsed.hallucinated_ids ?? []);
    const missedIndices = new Set(parsed.missed_golden_indices ?? []);

    // Deduplicate matches by both golden_index and actual_id
    const seenGolden = new Set<number>();
    const seenActual = new Set<string>();
    const matches: typeof rawMatches = [];
    for (const m of rawMatches) {
      if (!seenGolden.has(m.golden_index) && !seenActual.has(m.actual_id)) {
        seenGolden.add(m.golden_index);
        seenActual.add(m.actual_id);
        matches.push(m);
      }
    }

    const matched = matches
      .map(
        (m: { golden_index: number; actual_id: string; severity_match: boolean }) => ({
          golden: golden.expected_findings[m.golden_index],
          actual: actual.find((f) => f.id === m.actual_id),
        })
      )
      .filter((m): m is { golden: (typeof golden.expected_findings)[number]; actual: Finding } => m.actual !== undefined);

    const totalExpected = golden.expected_findings.length;
    const totalActual = actual.length;
    const truePositives = matched.length;
    const severityCorrect = matched.filter(
      (m) => {
        const orig = matches.find(
          (raw: { golden_index: number; actual_id: string; severity_match: boolean }) =>
            raw.actual_id === m.actual.id
        );
        return orig?.severity_match ?? false;
      }
    ).length;

    return {
      fixture,
      precision: totalActual > 0 ? truePositives / totalActual : 1,
      recall: totalExpected > 0 ? truePositives / totalExpected : 1,
      severity_accuracy:
        truePositives > 0 ? severityCorrect / truePositives : 0,
      matched,
      missed: [...missedIndices].map(
        (i) => golden.expected_findings[i as number]
      ),
      hallucinated: actual.filter((f) => hallucinatedIds.has(f.id)),
    };
  } catch {
    return fallbackJudge(fixture, actual, golden);
  }
}

function fallbackJudge(
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
            k.length > 4 &&
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
