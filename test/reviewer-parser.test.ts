import { describe, it, expect } from "vitest";
import { parseReviewerOutput, computePLevel } from "../src/reviewer-parser";
import type { Finding, PLevel } from "../src/types";

describe("computePLevel", () => {
  it("computes P0 for verified+critical", () => {
    expect(computePLevel("verified", "critical")).toBe("p0");
  });

  it("computes P0 for likely+critical", () => {
    expect(computePLevel("likely", "critical")).toBe("p0");
  });

  it("computes P1 for verified+functional", () => {
    expect(computePLevel("verified", "functional")).toBe("p1");
  });

  it("computes P1 for likely+functional", () => {
    expect(computePLevel("likely", "functional")).toBe("p1");
  });

  it("computes P1 for possible+critical", () => {
    expect(computePLevel("possible", "critical")).toBe("p1");
  });

  it("computes P2 for verified+quality", () => {
    expect(computePLevel("verified", "quality")).toBe("p2");
  });

  it("computes P2 for speculative+critical", () => {
    expect(computePLevel("speculative", "critical")).toBe("p2");
  });

  it("computes P2 for possible+functional", () => {
    expect(computePLevel("possible", "functional")).toBe("p2");
  });

  it("computes P3 for speculative+nitpick", () => {
    expect(computePLevel("speculative", "nitpick")).toBe("p3");
  });

  it("computes P3 for verified+nitpick", () => {
    expect(computePLevel("verified", "nitpick")).toBe("p3");
  });

  it("computes P3 for possible+quality", () => {
    expect(computePLevel("possible", "quality")).toBe("p3");
  });

  // Full matrix check
  const matrix: [string, string, PLevel][] = [
    ["verified", "critical", "p0"],
    ["verified", "functional", "p1"],
    ["verified", "quality", "p2"],
    ["verified", "nitpick", "p3"],
    ["likely", "critical", "p0"],
    ["likely", "functional", "p1"],
    ["likely", "quality", "p2"],
    ["likely", "nitpick", "p3"],
    ["possible", "critical", "p1"],
    ["possible", "functional", "p2"],
    ["possible", "quality", "p3"],
    ["possible", "nitpick", "p3"],
    ["speculative", "critical", "p2"],
    ["speculative", "functional", "p3"],
    ["speculative", "quality", "p3"],
    ["speculative", "nitpick", "p3"],
  ];

  for (const [confidence, impact, expected] of matrix) {
    it(`${confidence} × ${impact} → ${expected}`, () => {
      expect(
        computePLevel(
          confidence as Finding["confidence"],
          impact as Finding["impact"]
        )
      ).toBe(expected);
    });
  }
});

describe("parseReviewerOutput", () => {
  it("parses well-formed JSON findings output", () => {
    const raw = JSON.stringify({
      findings: [
        {
          id: "f-001",
          file: "src/auth.ts",
          line: 42,
          confidence: "verified",
          impact: "critical",
          severity: "p0",
          category: "security",
          title: "SQL injection",
          description: "Unsanitized input",
          suggestion: "Use parameterized queries",
          reviewer: "claude",
          pre_existing: false,
        },
      ],
      metadata: {
        reviewer: "claude",
        round: 1,
        timestamp: "2026-03-13T10:00:00Z",
        files_reviewed: 5,
        diff_scope: "branch:feat/auth vs main",
      },
    });

    const result = parseReviewerOutput(raw, "claude");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("f-001");
    expect(result[0].severity).toBe("p0");
    expect(result[0].reviewer).toBe("claude");
  });

  it("recomputes severity from confidence × impact even if provided", () => {
    const raw = JSON.stringify({
      findings: [
        {
          id: "f-001",
          file: "src/auth.ts",
          line: 42,
          confidence: "possible",
          impact: "functional",
          severity: "p0", // wrong — should be p2
          category: "logic",
          title: "Bug",
          description: "Off by one",
          suggestion: "Fix index",
          reviewer: "claude",
          pre_existing: false,
        },
      ],
      metadata: { reviewer: "claude", round: 1, timestamp: "2026-03-13T10:00:00Z" },
    });

    const result = parseReviewerOutput(raw, "claude");
    expect(result[0].severity).toBe("p2");
  });

  it("stamps reviewer name on all findings", () => {
    const raw = JSON.stringify({
      findings: [
        {
          id: "f-001",
          file: "src/x.ts",
          line: 1,
          confidence: "likely",
          impact: "quality",
          category: "style",
          title: "Naming",
          description: "Bad name",
          suggestion: "Rename",
        },
      ],
      metadata: { reviewer: "codex", round: 1, timestamp: "2026-03-13T10:00:00Z" },
    });

    const result = parseReviewerOutput(raw, "codex");
    expect(result[0].reviewer).toBe("codex");
  });

  it("defaults pre_existing to false when not specified", () => {
    const raw = JSON.stringify({
      findings: [
        {
          id: "f-001",
          file: "src/x.ts",
          line: 1,
          confidence: "likely",
          impact: "quality",
          category: "style",
          title: "Naming",
          description: "Bad name",
          suggestion: "Rename",
        },
      ],
      metadata: { reviewer: "claude", round: 1, timestamp: "2026-03-13T10:00:00Z" },
    });

    const result = parseReviewerOutput(raw, "claude");
    expect(result[0].pre_existing).toBe(false);
  });

  it("handles findings array at top level (no wrapper)", () => {
    const raw = JSON.stringify([
      {
        id: "f-001",
        file: "src/x.ts",
        line: 1,
        confidence: "verified",
        impact: "functional",
        category: "logic",
        title: "Bug",
        description: "Broken",
        suggestion: "Fix",
      },
    ]);

    const result = parseReviewerOutput(raw, "claude");
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("p1");
    expect(result[0].reviewer).toBe("claude");
  });

  it("extracts JSON from mixed text output", () => {
    const raw = `Here is my review:

\`\`\`json
{
  "findings": [
    {
      "id": "f-001",
      "file": "src/x.ts",
      "line": 10,
      "confidence": "likely",
      "impact": "critical",
      "category": "security",
      "title": "Injection",
      "description": "Bad",
      "suggestion": "Fix"
    }
  ]
}
\`\`\`

That's all I found.`;

    const result = parseReviewerOutput(raw, "claude");
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("p0");
  });

  it("returns empty array for output with no findings", () => {
    const raw = "I reviewed the code and found no issues.";
    const result = parseReviewerOutput(raw, "claude");
    expect(result).toEqual([]);
  });

  it("unwraps claude CLI JSON envelope", () => {
    const innerFindings = {
      findings: [
        {
          id: "f-001",
          file: "src/auth.ts",
          line: 42,
          confidence: "verified",
          impact: "critical",
          category: "security",
          title: "SQL injection",
          description: "Unsanitized input",
          suggestion: "Fix",
        },
      ],
      metadata: {},
    };
    // claude -p --output-format json wraps the result in an envelope
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "```json\n" + JSON.stringify(innerFindings) + "\n```",
    });

    const result = parseReviewerOutput(envelope, "claude");
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("SQL injection");
    expect(result[0].severity).toBe("p0");
  });

  it("unwraps envelope with plain JSON result (no code block)", () => {
    const innerFindings = {
      findings: [{ id: "f-001", file: "x.ts", line: 1, confidence: "likely", impact: "functional", category: "logic", title: "Bug", description: "Bad", suggestion: "Fix" }],
    };
    const envelope = JSON.stringify({
      type: "result",
      result: JSON.stringify(innerFindings),
    });

    const result = parseReviewerOutput(envelope, "test");
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Bug");
  });

  it("preserves expected, observed, and evidence when all provided", () => {
    const raw = JSON.stringify({
      findings: [
        {
          id: "f-quality",
          file: "src/foo.ts",
          line: 10,
          confidence: "verified",
          impact: "critical",
          category: "logic",
          title: "Wrong return",
          description: "Returns null instead of empty array",
          suggestion: "Return []",
          expected: "Function returns an empty array when input is empty",
          observed: "Function returns null when input is empty",
          evidence: ["Line 10: return null;", "Caller at line 50 does .length on result"],
        },
      ],
    });

    const result = parseReviewerOutput(raw, "test-reviewer");
    expect(result).toHaveLength(1);
    expect(result[0].expected).toBe("Function returns an empty array when input is empty");
    expect(result[0].observed).toBe("Function returns null when input is empty");
    expect(result[0].evidence).toEqual(["Line 10: return null;", "Caller at line 50 does .length on result"]);
  });

  it("parses finding without new fields (backward compat)", () => {
    const raw = JSON.stringify({
      findings: [
        {
          id: "f-old",
          file: "src/bar.ts",
          line: 5,
          confidence: "likely",
          impact: "functional",
          category: "logic",
          title: "Off by one",
          description: "Loop goes one too far",
          suggestion: "Use < instead of <=",
        },
      ],
    });

    const result = parseReviewerOutput(raw, "test-reviewer");
    expect(result).toHaveLength(1);
    expect(result[0].expected).toBeUndefined();
    expect(result[0].observed).toBeUndefined();
    expect(result[0].evidence).toBeUndefined();
    // Ensure the key is not present at all on the object
    expect("expected" in result[0]).toBe(false);
    expect("observed" in result[0]).toBe(false);
    expect("evidence" in result[0]).toBe(false);
  });

  it("normalizes non-string expected/observed to undefined", () => {
    const raw = JSON.stringify({
      findings: [
        {
          id: "f-bad-types",
          file: "src/baz.ts",
          line: 20,
          confidence: "possible",
          impact: "quality",
          category: "style",
          title: "Bad types",
          description: "desc",
          suggestion: "fix",
          expected: 42,
          observed: null,
        },
      ],
    });

    const result = parseReviewerOutput(raw, "test-reviewer");
    expect(result).toHaveLength(1);
    expect(result[0].expected).toBeUndefined();
    expect(result[0].observed).toBeUndefined();
    expect("expected" in result[0]).toBe(false);
    expect("observed" in result[0]).toBe(false);
  });

  it("normalizes non-array evidence to undefined", () => {
    const raw = JSON.stringify({
      findings: [
        {
          id: "f-bad-ev",
          file: "src/qux.ts",
          line: 30,
          confidence: "likely",
          impact: "functional",
          category: "logic",
          title: "Bad evidence",
          description: "desc",
          suggestion: "fix",
          evidence: "single string",
        },
      ],
    });

    const result = parseReviewerOutput(raw, "test-reviewer");
    expect(result).toHaveLength(1);
    expect(result[0].evidence).toBeUndefined();
    expect("evidence" in result[0]).toBe(false);
  });

  it("filters mixed types in evidence array to valid strings only", () => {
    const raw = JSON.stringify({
      findings: [
        {
          id: "f-mixed-ev",
          file: "src/mixed.ts",
          line: 40,
          confidence: "verified",
          impact: "critical",
          category: "security",
          title: "Mixed evidence",
          description: "desc",
          suggestion: "fix",
          evidence: ["valid", 42, null],
        },
      ],
    });

    const result = parseReviewerOutput(raw, "test-reviewer");
    expect(result).toHaveLength(1);
    expect(result[0].evidence).toEqual(["valid"]);
  });

  it("allows partial field population (expected without observed)", () => {
    const raw = JSON.stringify({
      findings: [
        {
          id: "f-partial",
          file: "src/partial.ts",
          line: 50,
          confidence: "likely",
          impact: "functional",
          category: "logic",
          title: "Partial fields",
          description: "desc",
          suggestion: "fix",
          expected: "Should return 42",
        },
      ],
    });

    const result = parseReviewerOutput(raw, "test-reviewer");
    expect(result).toHaveLength(1);
    expect(result[0].expected).toBe("Should return 42");
    expect(result[0].observed).toBeUndefined();
    expect("observed" in result[0]).toBe(false);
  });

  it("generates ids when missing", () => {
    const raw = JSON.stringify({
      findings: [
        {
          file: "src/x.ts",
          line: 1,
          confidence: "verified",
          impact: "critical",
          category: "security",
          title: "Bug",
          description: "Bad",
          suggestion: "Fix",
        },
        {
          file: "src/y.ts",
          line: 5,
          confidence: "likely",
          impact: "functional",
          category: "logic",
          title: "Bug2",
          description: "Bad2",
          suggestion: "Fix2",
        },
      ],
      metadata: { reviewer: "claude", round: 1, timestamp: "2026-03-13T10:00:00Z" },
    });

    const result = parseReviewerOutput(raw, "claude");
    expect(result[0].id).toBeTruthy();
    expect(result[1].id).toBeTruthy();
    expect(result[0].id).not.toBe(result[1].id);
  });
});
