import type { Confidence, Finding, Impact, PLevel } from "./types";

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

function extractJson(raw: string): unknown | null {
  // Try direct parse first
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

  // Try finding first { or [ in the text
  const firstBrace = raw.indexOf("{");
  const firstBracket = raw.indexOf("[");
  const startIdx =
    firstBrace === -1
      ? firstBracket
      : firstBracket === -1
        ? firstBrace
        : Math.min(firstBrace, firstBracket);

  if (startIdx !== -1) {
    const substr = raw.slice(startIdx);
    try {
      return JSON.parse(substr);
    } catch {
      // noop
    }
  }

  return null;
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

  return {
    id: (raw.id as string) || `${reviewer}-${index}`,
    file: (raw.file as string) ?? "",
    line: (raw.line as number) ?? 0,
    confidence,
    impact,
    severity: computePLevel(confidence, impact),
    category: (raw.category as string) ?? "general",
    title: (raw.title as string) ?? "",
    description: (raw.description as string) ?? "",
    suggestion: (raw.suggestion as string) ?? "",
    reviewer,
    pre_existing: (raw.pre_existing as boolean) ?? false,
  };
}

export function parseReviewerOutput(raw: string, reviewer: string): Finding[] {
  const parsed = extractJson(raw);
  if (parsed === null) return [];

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
