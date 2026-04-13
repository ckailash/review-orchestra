import { execFileSync } from "child_process";
import type { Finding } from "../src/types";
import { extractJson, unwrapCliEnvelope } from "../src/json-utils";

export interface GoldenFinding {
  description: string;
  expected_impact: string;
  expected_confidence: string;
}

// Single-round golden format (existing)
export interface SingleRoundGolden {
  fixture: string;
  expected_findings: GoldenFinding[];
}

// Multi-round golden format
export interface MultiRoundGoldenFinding extends GoldenFinding {
  expected_status?: "new" | "persisting";
  expected_pre_existing?: boolean;
}

export interface MultiRoundGoldenRound {
  expected_findings: MultiRoundGoldenFinding[];
  expected_resolved?: Array<{ description: string; expected_id_prefix?: string }>;
}

export interface MultiRoundGolden {
  fixture: string;
  rounds: MultiRoundGoldenRound[];
}

export type GoldenFixture = SingleRoundGolden | MultiRoundGolden;

export function isMultiRoundGolden(g: GoldenFixture): g is MultiRoundGolden {
  return "rounds" in g && Array.isArray((g as MultiRoundGolden).rounds);
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

export interface CheckWithCoverage {
  pass: boolean;
  checked: number;
  total: number;
}

export interface MultiRoundJudgeResult {
  rounds: JudgeResult[];
  resolved_matched: number;
  resolved_total: number;
  resolved_ids_exact: CheckWithCoverage;
  status_correct: CheckWithCoverage;
  pre_existing_correct: CheckWithCoverage;
  persisting_ids_exact: CheckWithCoverage;
  persisting_metadata_fresh: CheckWithCoverage;
}

export function isMultiRoundJudge(j: JudgeResult | MultiRoundJudgeResult): j is MultiRoundJudgeResult {
  return "rounds" in j;
}

export async function judge(
  fixture: string,
  actualFindings: Finding[],
  golden: SingleRoundGolden,
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
  golden: SingleRoundGolden
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
  golden: SingleRoundGolden
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
  golden: SingleRoundGolden
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

/**
 * Judge a multi-round eval. Each round's finding quality uses the standard
 * judge() function. Cross-round checks (status, pre_existing, ID preservation,
 * metadata freshness) are deterministic — no LLM needed.
 *
 * @param idMap - Maps golden finding descriptions to their actual round-1 IDs.
 *               Used to assert exact ID preservation on persisting/resolved findings.
 */
export function judgeMultiRound(
  roundResults: JudgeResult[],
  golden: MultiRoundGolden,
  actualResolvedFindings: Finding[][],
  idMap: Record<string, string>,
): MultiRoundJudgeResult {
  let statusPass = true;
  let statusChecked = 0;
  let statusTotal = 0;

  let preExistingPass = true;
  let preExistingChecked = 0;
  let preExistingTotal = 0;

  let persistingIdsPass = true;
  let persistingIdsChecked = 0;
  let persistingIdsTotal = 0;

  let metadataFreshPass = true;
  let metadataFreshChecked = 0;
  let metadataFreshTotal = 0;

  // Check per-finding assertions for each round
  for (let ri = 0; ri < golden.rounds.length; ri++) {
    const roundJudge = roundResults[ri];

    // Count totals from golden (how many findings have each expectation)
    for (const gf of golden.rounds[ri].expected_findings) {
      if (gf.expected_status !== undefined) statusTotal++;
      if (gf.expected_pre_existing !== undefined) preExistingTotal++;
      if (gf.expected_status === "persisting") {
        persistingIdsTotal++;
        metadataFreshTotal++;
      }
    }

    for (const match of roundJudge.matched) {
      const goldenFinding = match.golden as MultiRoundGoldenFinding;
      const actual = match.actual;

      // Status check
      if (goldenFinding.expected_status !== undefined) {
        statusChecked++;
        if (actual.status !== goldenFinding.expected_status) {
          statusPass = false;
        }
      }

      // Pre-existing check
      if (goldenFinding.expected_pre_existing !== undefined) {
        preExistingChecked++;
        if (actual.pre_existing !== goldenFinding.expected_pre_existing) {
          preExistingPass = false;
        }
      }

      // Persisting ID exactness: persisting findings must carry exact round-1 ID
      if (goldenFinding.expected_status === "persisting") {
        const expectedId = idMap[goldenFinding.description];
        if (expectedId) {
          persistingIdsChecked++;
          if (actual.id !== expectedId) {
            persistingIdsPass = false;
          }
        }
      }

      // Metadata freshness: persisting findings must carry round-2 metadata
      if (goldenFinding.expected_status === "persisting") {
        metadataFreshChecked++;
        if (actual.impact !== goldenFinding.expected_impact ||
            actual.confidence !== goldenFinding.expected_confidence) {
          metadataFreshPass = false;
        }
      }
    }
  }

  // Resolved findings checks
  let resolvedMatched = 0;
  let resolvedTotal = 0;
  let resolvedIdsPass = true;
  let resolvedIdsChecked = 0;

  for (let ri = 0; ri < golden.rounds.length; ri++) {
    const goldenRound = golden.rounds[ri];
    if (!goldenRound.expected_resolved) continue;

    const actualResolved = actualResolvedFindings[ri] ?? [];
    resolvedTotal += goldenRound.expected_resolved.length;

    for (const expectedResolved of goldenRound.expected_resolved) {
      // Find matching resolved finding by keyword overlap
      const match = actualResolved.find((f) => {
        const keywords = expectedResolved.description.toLowerCase().split(/\s+/);
        return keywords.some(
          (k) => k.length > 3 && (f.title.toLowerCase().includes(k) || f.description.toLowerCase().includes(k)),
        );
      });

      if (match) {
        resolvedMatched++;

        // Prefix check (always applies if specified)
        if (expectedResolved.expected_id_prefix && !match.id.startsWith(expectedResolved.expected_id_prefix)) {
          resolvedIdsPass = false;
        }

        // Exact ID check via idMap — only count as checked if idMap has an entry
        const expectedId = idMap[expectedResolved.description];
        if (expectedId) {
          resolvedIdsChecked++;
          if (match.id !== expectedId) {
            resolvedIdsPass = false;
          }
        }
      }
    }
  }

  return {
    rounds: roundResults,
    resolved_matched: resolvedMatched,
    resolved_total: resolvedTotal,
    resolved_ids_exact: { pass: resolvedIdsPass, checked: resolvedIdsChecked, total: resolvedTotal },
    status_correct: { pass: statusPass, checked: statusChecked, total: statusTotal },
    pre_existing_correct: { pass: preExistingPass, checked: preExistingChecked, total: preExistingTotal },
    persisting_ids_exact: { pass: persistingIdsPass, checked: persistingIdsChecked, total: persistingIdsTotal },
    persisting_metadata_fresh: { pass: metadataFreshPass, checked: metadataFreshChecked, total: metadataFreshTotal },
  };
}
