import type { Confidence, Finding, Impact, PLevel } from "./types";
import { extractJson, unwrapCliEnvelope } from "./json-utils";

const P_LEVEL_MATRIX: Record<Confidence, Record<Impact, PLevel>> = {
  verified: { critical: "p0", functional: "p1", quality: "p2", nitpick: "p3" },
  likely: { critical: "p0", functional: "p1", quality: "p2", nitpick: "p3" },
  possible: { critical: "p1", functional: "p2", quality: "p3", nitpick: "p3" },
  speculative: {
    critical: "p2",
    functional: "p3",
    quality: "p3",
    nitpick: "p3",
  },
};

export function computePLevel(confidence: Confidence, impact: Impact): PLevel {
  return P_LEVEL_MATRIX[confidence][impact];
}

const VALID_CONFIDENCE = new Set<string>([
  "verified",
  "likely",
  "possible",
  "speculative",
]);
const VALID_IMPACT = new Set<string>([
  "critical",
  "functional",
  "quality",
  "nitpick",
]);

function normalizeFinding(
  raw: Record<string, unknown>,
  reviewer: string,
  index: number
): Finding {
  const confidence: Confidence = VALID_CONFIDENCE.has(raw.confidence as string)
    ? (raw.confidence as Confidence)
    : "possible";
  const impact: Impact = VALID_IMPACT.has(raw.impact as string)
    ? (raw.impact as Impact)
    : "quality";

  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" ? v : (v != null ? String(v) : fallback);

  return {
    id: str(raw.id, "") || `${reviewer}-${index}`,
    file: str(raw.file, ""),
    line: typeof raw.line === "number" ? raw.line : (parseInt(String(raw.line), 10) || 0),
    confidence,
    impact,
    severity: computePLevel(confidence, impact),
    category: str(raw.category, "general"),
    title: str(raw.title, ""),
    description: str(raw.description, ""),
    suggestion: str(raw.suggestion, ""),
    reviewer,
    pre_existing: typeof raw.pre_existing === "boolean" ? raw.pre_existing : false,
  };
}

export function parseReviewerOutput(raw: string, reviewer: string): Finding[] {
  const rawParsed = extractJson(raw);
  if (rawParsed === null) return [];

  const parsed = unwrapCliEnvelope(rawParsed);

  let rawFindings: Record<string, unknown>[];

  if (Array.isArray(parsed)) {
    rawFindings = parsed;
  } else if (
    typeof parsed === "object" &&
    parsed !== null &&
    "findings" in parsed
  ) {
    const obj = parsed as Record<string, unknown>;
    rawFindings = obj.findings as Record<string, unknown>[];
  } else {
    return [];
  }

  if (!Array.isArray(rawFindings) || rawFindings.length === 0) return [];

  return rawFindings.map((f, i) => normalizeFinding(f, reviewer, i));
}
