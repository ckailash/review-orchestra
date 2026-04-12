import { describe, it, expect } from "vitest";
import { parseJudgeOutput, fallbackJudge, buildJudgePrompt } from "../evals/judge";
import type { Finding } from "../src/types";
import type { GoldenFixture, GoldenFinding } from "../evals/judge";

function makeFinding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    file: "test.ts",
    line: 1,
    confidence: "likely",
    impact: "functional",
    severity: "p1",
    category: "bug",
    title: "Test finding",
    description: "A test finding",
    suggestion: "Fix it",
    reviewer: "test-reviewer",
    pre_existing: false,
    ...overrides,
  };
}

function makeGolden(expected: GoldenFinding[]): GoldenFixture {
  return {
    fixture: "test-fixture",
    expected_findings: expected,
  };
}

// Helper to wrap judge output in the format parseJudgeOutput expects (raw JSON string)
function wrapJudgeOutput(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

describe("parseJudgeOutput", () => {
  describe("golden_index boundary checking", () => {
    it("filters out matches where golden_index >= expected_findings.length", () => {
      const actual = [makeFinding({ id: "f-001" }), makeFinding({ id: "f-002" })];
      const golden = makeGolden([
        { description: "SQL injection", expected_impact: "critical", expected_confidence: "verified" },
      ]);

      const raw = wrapJudgeOutput({
        matches: [
          { golden_index: 0, actual_id: "f-001", severity_match: true },
          { golden_index: 5, actual_id: "f-002", severity_match: true }, // out of range
        ],
        hallucinated_ids: [],
        missed_golden_indices: [],
      });

      const result = parseJudgeOutput("test", raw, actual, golden);
      expect(result.matched).toHaveLength(1);
      expect(result.matched[0].golden.description).toBe("SQL injection");
      expect(result.matched[0].actual.id).toBe("f-001");
      // f-002 should be hallucinated since its match was filtered out
      expect(result.hallucinated).toHaveLength(1);
      expect(result.hallucinated[0].id).toBe("f-002");
    });

    it("filters out matches where golden_index < 0", () => {
      const actual = [makeFinding({ id: "f-001" }), makeFinding({ id: "f-002" })];
      const golden = makeGolden([
        { description: "XSS vulnerability", expected_impact: "critical", expected_confidence: "verified" },
      ]);

      const raw = wrapJudgeOutput({
        matches: [
          { golden_index: -1, actual_id: "f-001", severity_match: true }, // negative index
          { golden_index: 0, actual_id: "f-002", severity_match: true },
        ],
        hallucinated_ids: [],
        missed_golden_indices: [],
      });

      const result = parseJudgeOutput("test", raw, actual, golden);
      expect(result.matched).toHaveLength(1);
      expect(result.matched[0].actual.id).toBe("f-002");
      // f-001 should be hallucinated since its match was filtered out
      expect(result.hallucinated).toHaveLength(1);
      expect(result.hallucinated[0].id).toBe("f-001");
    });

    it("filters out matches with golden_index exactly equal to length", () => {
      const actual = [makeFinding({ id: "f-001" })];
      const golden = makeGolden([
        { description: "Buffer overflow", expected_impact: "critical", expected_confidence: "verified" },
      ]);

      const raw = wrapJudgeOutput({
        matches: [
          { golden_index: 1, actual_id: "f-001", severity_match: true }, // exactly length (1)
        ],
        hallucinated_ids: [],
        missed_golden_indices: [],
      });

      const result = parseJudgeOutput("test", raw, actual, golden);
      expect(result.matched).toHaveLength(0);
      expect(result.missed).toHaveLength(1);
      expect(result.hallucinated).toHaveLength(1);
    });
  });

  describe("missed findings computed from match set", () => {
    it("computes missed findings by diffing golden indices against matched indices", () => {
      const actual = [makeFinding({ id: "f-001" })];
      const golden = makeGolden([
        { description: "SQL injection", expected_impact: "critical", expected_confidence: "verified" },
        { description: "XSS attack", expected_impact: "critical", expected_confidence: "likely" },
        { description: "CSRF vulnerability", expected_impact: "functional", expected_confidence: "possible" },
      ]);

      const raw = wrapJudgeOutput({
        matches: [
          { golden_index: 0, actual_id: "f-001", severity_match: true },
        ],
        // LLM only reports index 2 as missed, but index 1 is also missed
        hallucinated_ids: [],
        missed_golden_indices: [2],
      });

      const result = parseJudgeOutput("test", raw, actual, golden);
      expect(result.matched).toHaveLength(1);
      // Both indices 1 and 2 should be missed (computed from match set, not LLM output)
      expect(result.missed).toHaveLength(2);
      expect(result.missed.map((m) => m.description)).toContain("XSS attack");
      expect(result.missed.map((m) => m.description)).toContain("CSRF vulnerability");
    });

    it("reports all golden findings as missed when no matches", () => {
      const actual = [makeFinding({ id: "f-001" })];
      const golden = makeGolden([
        { description: "Finding A", expected_impact: "critical", expected_confidence: "verified" },
        { description: "Finding B", expected_impact: "functional", expected_confidence: "likely" },
      ]);

      const raw = wrapJudgeOutput({
        matches: [],
        hallucinated_ids: ["f-001"],
        missed_golden_indices: [0], // LLM only says index 0 is missed, but both are
      });

      const result = parseJudgeOutput("test", raw, actual, golden);
      expect(result.missed).toHaveLength(2);
    });

    it("ignores LLM missed_golden_indices and computes from match set", () => {
      const actual = [makeFinding({ id: "f-001" }), makeFinding({ id: "f-002" })];
      const golden = makeGolden([
        { description: "Finding A", expected_impact: "critical", expected_confidence: "verified" },
        { description: "Finding B", expected_impact: "functional", expected_confidence: "likely" },
      ]);

      const raw = wrapJudgeOutput({
        matches: [
          { golden_index: 0, actual_id: "f-001", severity_match: true },
          { golden_index: 1, actual_id: "f-002", severity_match: false },
        ],
        hallucinated_ids: [],
        // LLM incorrectly says index 0 is missed, but it's matched
        missed_golden_indices: [0],
      });

      const result = parseJudgeOutput("test", raw, actual, golden);
      expect(result.matched).toHaveLength(2);
      expect(result.missed).toHaveLength(0);
    });
  });

  describe("hallucinated findings computed from match set", () => {
    it("computes hallucinated findings by diffing actual IDs against matched IDs", () => {
      const actual = [
        makeFinding({ id: "f-001" }),
        makeFinding({ id: "f-002" }),
        makeFinding({ id: "f-003" }),
      ];
      const golden = makeGolden([
        { description: "SQL injection", expected_impact: "critical", expected_confidence: "verified" },
      ]);

      const raw = wrapJudgeOutput({
        matches: [
          { golden_index: 0, actual_id: "f-001", severity_match: true },
        ],
        // LLM only reports f-002 as hallucinated, but f-003 is also hallucinated
        hallucinated_ids: ["f-002"],
        missed_golden_indices: [],
      });

      const result = parseJudgeOutput("test", raw, actual, golden);
      expect(result.matched).toHaveLength(1);
      // Both f-002 and f-003 should be hallucinated (computed from match set)
      expect(result.hallucinated).toHaveLength(2);
      expect(result.hallucinated.map((h) => h.id)).toContain("f-002");
      expect(result.hallucinated.map((h) => h.id)).toContain("f-003");
    });

    it("reports all actual findings as hallucinated when no matches", () => {
      const actual = [makeFinding({ id: "f-001" }), makeFinding({ id: "f-002" })];
      const golden = makeGolden([
        { description: "Finding A", expected_impact: "critical", expected_confidence: "verified" },
      ]);

      const raw = wrapJudgeOutput({
        matches: [],
        hallucinated_ids: [], // LLM says none are hallucinated, but both are
        missed_golden_indices: [0],
      });

      const result = parseJudgeOutput("test", raw, actual, golden);
      expect(result.hallucinated).toHaveLength(2);
    });

    it("ignores LLM hallucinated_ids and computes from match set", () => {
      const actual = [makeFinding({ id: "f-001" }), makeFinding({ id: "f-002" })];
      const golden = makeGolden([
        { description: "Finding A", expected_impact: "critical", expected_confidence: "verified" },
        { description: "Finding B", expected_impact: "functional", expected_confidence: "likely" },
      ]);

      const raw = wrapJudgeOutput({
        matches: [
          { golden_index: 0, actual_id: "f-001", severity_match: true },
          { golden_index: 1, actual_id: "f-002", severity_match: false },
        ],
        // LLM incorrectly says f-001 is hallucinated, but it's matched
        hallucinated_ids: ["f-001"],
        missed_golden_indices: [],
      });

      const result = parseJudgeOutput("test", raw, actual, golden);
      expect(result.matched).toHaveLength(2);
      expect(result.hallucinated).toHaveLength(0);
    });
  });

  describe("deduplication", () => {
    it("deduplicates by golden_index (keeps first)", () => {
      const actual = [makeFinding({ id: "f-001" }), makeFinding({ id: "f-002" })];
      const golden = makeGolden([
        { description: "SQL injection", expected_impact: "critical", expected_confidence: "verified" },
      ]);

      const raw = wrapJudgeOutput({
        matches: [
          { golden_index: 0, actual_id: "f-001", severity_match: true },
          { golden_index: 0, actual_id: "f-002", severity_match: false }, // duplicate golden_index
        ],
        hallucinated_ids: [],
        missed_golden_indices: [],
      });

      const result = parseJudgeOutput("test", raw, actual, golden);
      expect(result.matched).toHaveLength(1);
      expect(result.matched[0].actual.id).toBe("f-001");
    });

    it("deduplicates by actual_id (keeps first)", () => {
      const actual = [makeFinding({ id: "f-001" })];
      const golden = makeGolden([
        { description: "SQL injection", expected_impact: "critical", expected_confidence: "verified" },
        { description: "XSS attack", expected_impact: "critical", expected_confidence: "likely" },
      ]);

      const raw = wrapJudgeOutput({
        matches: [
          { golden_index: 0, actual_id: "f-001", severity_match: true },
          { golden_index: 1, actual_id: "f-001", severity_match: false }, // duplicate actual_id
        ],
        hallucinated_ids: [],
        missed_golden_indices: [],
      });

      const result = parseJudgeOutput("test", raw, actual, golden);
      expect(result.matched).toHaveLength(1);
      expect(result.matched[0].golden.description).toBe("SQL injection");
      expect(result.missed).toHaveLength(1);
      expect(result.missed[0].description).toBe("XSS attack");
    });
  });

  describe("metrics computation", () => {
    it("computes correct precision and recall", () => {
      const actual = [makeFinding({ id: "f-001" }), makeFinding({ id: "f-002" }), makeFinding({ id: "f-003" })];
      const golden = makeGolden([
        { description: "Finding A", expected_impact: "critical", expected_confidence: "verified" },
        { description: "Finding B", expected_impact: "functional", expected_confidence: "likely" },
      ]);

      const raw = wrapJudgeOutput({
        matches: [
          { golden_index: 0, actual_id: "f-001", severity_match: true },
        ],
        hallucinated_ids: ["f-002", "f-003"],
        missed_golden_indices: [1],
      });

      const result = parseJudgeOutput("test", raw, actual, golden);
      expect(result.precision).toBeCloseTo(1 / 3); // 1 TP / 3 actual
      expect(result.recall).toBeCloseTo(1 / 2); // 1 TP / 2 expected
    });

    it("computes severity_accuracy from severity_match flags", () => {
      const actual = [makeFinding({ id: "f-001" }), makeFinding({ id: "f-002" })];
      const golden = makeGolden([
        { description: "Finding A", expected_impact: "critical", expected_confidence: "verified" },
        { description: "Finding B", expected_impact: "functional", expected_confidence: "likely" },
      ]);

      const raw = wrapJudgeOutput({
        matches: [
          { golden_index: 0, actual_id: "f-001", severity_match: true },
          { golden_index: 1, actual_id: "f-002", severity_match: false },
        ],
        hallucinated_ids: [],
        missed_golden_indices: [],
      });

      const result = parseJudgeOutput("test", raw, actual, golden);
      expect(result.severity_accuracy).toBeCloseTo(0.5); // 1/2 severity correct
    });

    it("returns precision 1 when no actual findings", () => {
      const golden = makeGolden([
        { description: "Finding A", expected_impact: "critical", expected_confidence: "verified" },
      ]);

      const raw = wrapJudgeOutput({
        matches: [],
        hallucinated_ids: [],
        missed_golden_indices: [0],
      });

      const result = parseJudgeOutput("test", raw, [], golden);
      expect(result.precision).toBe(1);
      expect(result.recall).toBe(0);
    });

    it("returns recall 1 when no expected findings", () => {
      const actual = [makeFinding({ id: "f-001" })];
      const golden = makeGolden([]);

      const raw = wrapJudgeOutput({
        matches: [],
        hallucinated_ids: ["f-001"],
        missed_golden_indices: [],
      });

      const result = parseJudgeOutput("test", raw, actual, golden);
      expect(result.recall).toBe(1);
      expect(result.precision).toBe(0);
    });
  });

  describe("fallback behavior", () => {
    it("falls back to fallbackJudge on invalid JSON", () => {
      const actual = [makeFinding({ id: "f-001", title: "SQL injection found", description: "Dangerous SQL injection vulnerability" })];
      const golden = makeGolden([
        { description: "SQL injection vulnerability in query builder", expected_impact: "critical", expected_confidence: "verified" },
      ]);

      const result = parseJudgeOutput("test", "not valid json at all", actual, golden);
      // Should not throw, should fall back
      expect(result.fixture).toBe("test");
    });

    it("falls back when parsed object has no matches field", () => {
      const actual = [makeFinding({ id: "f-001" })];
      const golden = makeGolden([
        { description: "Finding A", expected_impact: "critical", expected_confidence: "verified" },
      ]);

      const raw = JSON.stringify({ some_other_field: "value" });
      const result = parseJudgeOutput("test", raw, actual, golden);
      expect(result.fixture).toBe("test");
    });
  });

  describe("actual_id not found in actual findings", () => {
    it("filters out matches where actual_id does not exist in actual findings", () => {
      const actual = [makeFinding({ id: "f-001" })];
      const golden = makeGolden([
        { description: "Finding A", expected_impact: "critical", expected_confidence: "verified" },
        { description: "Finding B", expected_impact: "functional", expected_confidence: "likely" },
      ]);

      const raw = wrapJudgeOutput({
        matches: [
          { golden_index: 0, actual_id: "f-001", severity_match: true },
          { golden_index: 1, actual_id: "f-nonexistent", severity_match: true }, // nonexistent actual
        ],
        hallucinated_ids: [],
        missed_golden_indices: [],
      });

      const result = parseJudgeOutput("test", raw, actual, golden);
      expect(result.matched).toHaveLength(1);
      // Finding B is missed because its match had a nonexistent actual_id
      expect(result.missed).toHaveLength(1);
      expect(result.missed[0].description).toBe("Finding B");
    });

    it("unresolved match before valid match does not misalign golden indices", () => {
      // Match at index 0 has an unresolved actual_id, match at index 1 is valid.
      // Before the fix, positional indexing (matched.map((_, i) => matches[i].golden_index))
      // would map matched[0] (from matches[1]) to matches[0].golden_index (wrong golden).
      const actual = [makeFinding({ id: "f-002" })]; // only f-002 exists
      const golden = makeGolden([
        { description: "Finding A", expected_impact: "critical", expected_confidence: "verified" },
        { description: "Finding B", expected_impact: "functional", expected_confidence: "likely" },
      ]);

      const raw = wrapJudgeOutput({
        matches: [
          { golden_index: 0, actual_id: "f-nonexistent", severity_match: true }, // unresolved at index 0
          { golden_index: 1, actual_id: "f-002", severity_match: true },         // valid at index 1
        ],
        hallucinated_ids: [],
        missed_golden_indices: [],
      });

      const result = parseJudgeOutput("test", raw, actual, golden);
      // Only one match should resolve (f-002 matched to Finding B at golden_index 1)
      expect(result.matched).toHaveLength(1);
      expect(result.matched[0].golden.description).toBe("Finding B");
      expect(result.matched[0].actual.id).toBe("f-002");
      // Finding A (golden_index 0) should be missed because its match was unresolved
      expect(result.missed).toHaveLength(1);
      expect(result.missed[0].description).toBe("Finding A");
      // f-002 is matched, so no hallucinated findings
      expect(result.hallucinated).toHaveLength(0);
    });
  });
});

describe("fallbackJudge", () => {
  it("uses keyword length > 5 threshold", () => {
    // "query" is 5 chars, should NOT match (> 5 means length must be at least 6)
    const actual = [makeFinding({ id: "f-001", title: "query optimization issue", description: "The query is slow" })];
    const golden = makeGolden([
      { description: "query parameter not sanitized", expected_impact: "critical", expected_confidence: "verified" },
    ]);

    const result = fallbackJudge("test", actual, golden);
    // "query" is 5 chars, not > 5, so should not match
    expect(result.matched).toHaveLength(0);
    expect(result.missed).toHaveLength(1);
  });

  it("matches keywords longer than 5 chars", () => {
    // "injection" is 9 chars, should match
    const actual = [makeFinding({ id: "f-001", title: "SQL injection found", description: "SQL injection vulnerability" })];
    const golden = makeGolden([
      { description: "SQL injection in the query builder", expected_impact: "critical", expected_confidence: "verified" },
    ]);

    const result = fallbackJudge("test", actual, golden);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].actual.id).toBe("f-001");
  });

  it("computes missed and hallucinated correctly", () => {
    const actual = [
      makeFinding({ id: "f-001", title: "SQL injection found", description: "SQL injection vulnerability" }),
      makeFinding({ id: "f-002", title: "Unused variable", description: "Variable x is unused" }),
    ];
    const golden = makeGolden([
      { description: "SQL injection in the query builder", expected_impact: "critical", expected_confidence: "verified" },
      { description: "Race condition in file writer", expected_impact: "functional", expected_confidence: "likely" },
    ]);

    const result = fallbackJudge("test", actual, golden);
    expect(result.matched).toHaveLength(1);
    expect(result.missed).toHaveLength(1);
    expect(result.missed[0].description).toBe("Race condition in file writer");
    expect(result.hallucinated).toHaveLength(1);
    expect(result.hallucinated[0].id).toBe("f-002");
  });

  it("returns severity_accuracy 0", () => {
    const actual = [makeFinding({ id: "f-001", title: "injection attack", description: "injection vulnerability" })];
    const golden = makeGolden([
      { description: "SQL injection vulnerability", expected_impact: "critical", expected_confidence: "verified" },
    ]);

    const result = fallbackJudge("test", actual, golden);
    expect(result.severity_accuracy).toBe(0);
  });
});

describe("buildJudgePrompt", () => {
  it("includes severity matching criteria", () => {
    const actual = [makeFinding({ id: "f-001" })];
    const golden = makeGolden([
      { description: "SQL injection", expected_impact: "critical", expected_confidence: "verified" },
    ]);

    const prompt = buildJudgePrompt(actual, golden);
    expect(prompt).toContain("expected_impact");
    expect(prompt).toContain("expected_confidence");
    expect(prompt).toContain("impact");
    expect(prompt).toContain("confidence");
    expect(prompt).toContain("severity_match is true ONLY when BOTH axes match");
  });

  it("includes match and non-match examples", () => {
    const actual = [makeFinding({ id: "f-001" })];
    const golden = makeGolden([
      { description: "SQL injection", expected_impact: "critical", expected_confidence: "verified" },
    ]);

    const prompt = buildJudgePrompt(actual, golden);
    expect(prompt).toContain("Example: Match");
    expect(prompt).toContain("This IS a match");
    expect(prompt).toContain("Example: Non-match");
    expect(prompt).toContain("This is NOT a match");
  });
});
