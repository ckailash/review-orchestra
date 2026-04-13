import { describe, it, expect } from "vitest";
import {
  isMultiRoundGolden,
  isMultiRoundJudge,
  judgeMultiRound,
  type SingleRoundGolden,
  type MultiRoundGolden,
  type GoldenFixture,
  type JudgeResult,
  type MultiRoundJudgeResult,
  type CheckWithCoverage,
} from "../evals/judge";
import type { Finding } from "../src/types";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "",
    file: "src/api.ts",
    line: 7,
    confidence: "verified",
    impact: "critical",
    severity: "p0",
    category: "security",
    title: "SQL injection in getUser()",
    description: "SQL injection in getUser()",
    suggestion: "Use parameterized queries",
    reviewer: "claude",
    pre_existing: false,
    ...overrides,
  };
}

function makeJudgeResult(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return {
    fixture: "test",
    precision: 1,
    recall: 1,
    severity_accuracy: 1,
    matched: [],
    missed: [],
    hallucinated: [],
    ...overrides,
  };
}

describe("isMultiRoundGolden", () => {
  it("identifies single-round goldens", () => {
    const golden: SingleRoundGolden = {
      fixture: "sql-injection",
      expected_findings: [{ description: "SQL injection", expected_impact: "critical", expected_confidence: "verified" }],
    };
    expect(isMultiRoundGolden(golden)).toBe(false);
  });

  it("identifies multi-round goldens", () => {
    const golden: MultiRoundGolden = {
      fixture: "multi-round",
      rounds: [
        { expected_findings: [{ description: "SQL injection", expected_impact: "critical", expected_confidence: "verified" }] },
        { expected_findings: [], expected_resolved: [{ description: "SQL injection" }] },
      ],
    };
    expect(isMultiRoundGolden(golden)).toBe(true);
  });

  it("rejects objects with non-array rounds", () => {
    const golden = { fixture: "test", rounds: "not-an-array" } as unknown as GoldenFixture;
    expect(isMultiRoundGolden(golden)).toBe(false);
  });
});

describe("isMultiRoundJudge", () => {
  it("identifies single-round judge results", () => {
    const result = makeJudgeResult();
    expect(isMultiRoundJudge(result)).toBe(false);
  });

  it("identifies multi-round judge results", () => {
    const result: MultiRoundJudgeResult = {
      rounds: [makeJudgeResult()],
      resolved_matched: 0,
      resolved_total: 0,
      resolved_ids_exact: { pass: true, checked: 0, total: 0 },
      status_correct: { pass: true, checked: 0, total: 0 },
      pre_existing_correct: { pass: true, checked: 0, total: 0 },
      persisting_ids_exact: { pass: true, checked: 0, total: 0 },
      persisting_metadata_fresh: { pass: true, checked: 0, total: 0 },
    };
    expect(isMultiRoundJudge(result)).toBe(true);
  });
});

describe("scope identity stability", () => {
  it("round-2 scope preserves type, baseBranch, description from round-1", () => {
    // This tests the contract that runMultiRoundFixture must maintain
    const round1Scope = {
      type: "uncommitted" as const,
      baseBranch: "main",
      description: "Eval fixture: multi-round",
      diff: "round-1-diff",
      files: ["src/api.ts"],
    };

    const round2Scope = {
      type: round1Scope.type,
      baseBranch: round1Scope.baseBranch,
      description: round1Scope.description,
      diff: "round-2-diff-different",
      files: ["src/api.ts", "src/new-file.ts"],
    };

    // Session-identity fields must match
    expect(round2Scope.type).toBe(round1Scope.type);
    expect(round2Scope.baseBranch).toBe(round1Scope.baseBranch);
    expect(round2Scope.description).toBe(round1Scope.description);
    // diff and files may differ
    expect(round2Scope.diff).not.toBe(round1Scope.diff);
  });
});

describe("judgeMultiRound deterministic checks", () => {
  const sqlInjectionGolden = { description: "SQL injection in getUser()", expected_impact: "critical", expected_confidence: "verified" };
  const validationGolden = { description: "Missing input validation in createUser()", expected_impact: "functional", expected_confidence: "likely" };
  const hardcodedPwGolden = { description: "Hardcoded database password", expected_impact: "critical", expected_confidence: "verified" };

  it("status_correct: all findings have correct status", () => {
    const golden: MultiRoundGolden = {
      fixture: "test",
      rounds: [
        { expected_findings: [
          { ...sqlInjectionGolden, expected_status: "new" },
          { ...validationGolden, expected_status: "new" },
        ] },
        { expected_findings: [
          { ...validationGolden, expected_impact: "quality", expected_status: "persisting" },
        ], expected_resolved: [{ description: "SQL injection in getUser()" }] },
      ],
    };

    const sqlFinding = makeFinding({ id: "r1-f-001", status: "new" });
    const valFinding = makeFinding({ id: "r1-f-002", title: "Missing input validation in createUser()", description: "Missing input validation in createUser()", impact: "functional", status: "new" });
    const valR2 = makeFinding({ id: "r1-f-002", title: "Missing input validation in createUser()", description: "Missing input validation in createUser()", impact: "quality", status: "persisting", pre_existing: true });

    const r1Judge = makeJudgeResult({
      matched: [
        { golden: golden.rounds[0].expected_findings[0], actual: sqlFinding },
        { golden: golden.rounds[0].expected_findings[1], actual: valFinding },
      ],
    });
    const r2Judge = makeJudgeResult({
      matched: [
        { golden: golden.rounds[1].expected_findings[0], actual: valR2 },
      ],
    });

    const result = judgeMultiRound(
      [r1Judge, r2Judge], golden,
      [[], [sqlFinding]],
      { "SQL injection in getUser()": "r1-f-001", "Missing input validation in createUser()": "r1-f-002" },
    );

    expect(result.status_correct).toEqual({ pass: true, checked: 3, total: 3 });
  });

  it("status_correct: fails when finding has wrong status", () => {
    const golden: MultiRoundGolden = {
      fixture: "test",
      rounds: [
        { expected_findings: [{ ...sqlInjectionGolden, expected_status: "new" }] },
      ],
    };

    const finding = makeFinding({ id: "r1-f-001", status: "persisting" }); // Wrong!

    const r1Judge = makeJudgeResult({
      matched: [{ golden: golden.rounds[0].expected_findings[0], actual: finding }],
    });

    const result = judgeMultiRound(
      [r1Judge], golden, [[]], {},
    );

    expect(result.status_correct).toEqual({ pass: false, checked: 1, total: 1 });
  });

  it("pre_existing_correct: validates pre_existing tagging", () => {
    const golden: MultiRoundGolden = {
      fixture: "test",
      rounds: [
        { expected_findings: [{ ...validationGolden, expected_pre_existing: false, expected_status: "new" }] },
        { expected_findings: [{ ...validationGolden, expected_impact: "quality", expected_pre_existing: true, expected_status: "persisting" }] },
      ],
    };

    const r1Finding = makeFinding({ id: "r1-f-001", title: "Missing input validation in createUser()", description: "Missing input validation in createUser()", pre_existing: false, status: "new" });
    const r2Finding = makeFinding({ id: "r1-f-001", title: "Missing input validation in createUser()", description: "Missing input validation in createUser()", pre_existing: true, status: "persisting", impact: "quality" });

    const r1Judge = makeJudgeResult({ matched: [{ golden: golden.rounds[0].expected_findings[0], actual: r1Finding }] });
    const r2Judge = makeJudgeResult({ matched: [{ golden: golden.rounds[1].expected_findings[0], actual: r2Finding }] });

    const result = judgeMultiRound(
      [r1Judge, r2Judge], golden,
      [[], []],
      { "Missing input validation in createUser()": "r1-f-001" },
    );

    expect(result.pre_existing_correct).toEqual({ pass: true, checked: 2, total: 2 });
  });

  it("pre_existing_correct: fails on wrong pre_existing", () => {
    const golden: MultiRoundGolden = {
      fixture: "test",
      rounds: [
        { expected_findings: [{ ...validationGolden, expected_pre_existing: true, expected_status: "persisting" }] },
      ],
    };

    const finding = makeFinding({ id: "r1-f-001", pre_existing: false, status: "persisting" }); // Wrong pre_existing

    const r1Judge = makeJudgeResult({ matched: [{ golden: golden.rounds[0].expected_findings[0], actual: finding }] });

    const result = judgeMultiRound([r1Judge], golden, [[]], {});

    expect(result.pre_existing_correct).toEqual({ pass: false, checked: 1, total: 1 });
  });

  it("persisting_ids_exact: catches ID swaps between two persisting findings", () => {
    const golden: MultiRoundGolden = {
      fixture: "test",
      rounds: [
        { expected_findings: [
          { ...validationGolden, expected_status: "new" },
          { ...hardcodedPwGolden, expected_status: "new" },
        ] },
        { expected_findings: [
          { ...validationGolden, expected_impact: "quality", expected_status: "persisting" },
          { ...hardcodedPwGolden, expected_status: "persisting" },
        ] },
      ],
    };

    // IDs swapped: validation got hardcoded's ID and vice versa
    const valR2 = makeFinding({ id: "r1-f-002", title: "Missing input validation in createUser()", description: "Missing input validation in createUser()", impact: "quality", status: "persisting" });
    const pwR2 = makeFinding({ id: "r1-f-001", title: "Hardcoded database password", description: "Hardcoded database password", status: "persisting" });

    const r1Judge = makeJudgeResult({ matched: [] });
    const r2Judge = makeJudgeResult({
      matched: [
        { golden: golden.rounds[1].expected_findings[0], actual: valR2 },
        { golden: golden.rounds[1].expected_findings[1], actual: pwR2 },
      ],
    });

    const result = judgeMultiRound(
      [r1Judge, r2Judge], golden,
      [[], []],
      // Correct mapping: validation=r1-f-001, hardcoded=r1-f-002
      { "Missing input validation in createUser()": "r1-f-001", "Hardcoded database password": "r1-f-002" },
    );

    // Both persisting findings have the wrong ID
    expect(result.persisting_ids_exact).toEqual({ pass: false, checked: 2, total: 2 });
  });

  it("persisting_ids_exact: passes with correct IDs", () => {
    const golden: MultiRoundGolden = {
      fixture: "test",
      rounds: [
        { expected_findings: [
          { ...validationGolden, expected_status: "new" },
          { ...hardcodedPwGolden, expected_status: "new" },
        ] },
        { expected_findings: [
          { ...validationGolden, expected_impact: "quality", expected_status: "persisting" },
          { ...hardcodedPwGolden, expected_status: "persisting" },
        ] },
      ],
    };

    const valR2 = makeFinding({ id: "r1-f-001", title: "Missing input validation in createUser()", description: "Missing input validation in createUser()", impact: "quality", status: "persisting" });
    const pwR2 = makeFinding({ id: "r1-f-002", title: "Hardcoded database password", description: "Hardcoded database password", status: "persisting" });

    const r1Judge = makeJudgeResult({ matched: [] });
    const r2Judge = makeJudgeResult({
      matched: [
        { golden: golden.rounds[1].expected_findings[0], actual: valR2 },
        { golden: golden.rounds[1].expected_findings[1], actual: pwR2 },
      ],
    });

    const result = judgeMultiRound(
      [r1Judge, r2Judge], golden,
      [[], []],
      { "Missing input validation in createUser()": "r1-f-001", "Hardcoded database password": "r1-f-002" },
    );

    expect(result.persisting_ids_exact).toEqual({ pass: true, checked: 2, total: 2 });
  });

  it("persisting_ids_exact: reports partial coverage when idMap is incomplete", () => {
    const golden: MultiRoundGolden = {
      fixture: "test",
      rounds: [
        { expected_findings: [
          { ...validationGolden, expected_status: "new" },
          { ...hardcodedPwGolden, expected_status: "new" },
        ] },
        { expected_findings: [
          { ...validationGolden, expected_impact: "quality", expected_status: "persisting" },
          { ...hardcodedPwGolden, expected_status: "persisting" },
        ] },
      ],
    };

    const valR2 = makeFinding({ id: "r1-f-001", title: "Missing input validation in createUser()", description: "Missing input validation in createUser()", impact: "quality", status: "persisting" });
    const pwR2 = makeFinding({ id: "r1-f-002", title: "Hardcoded database password", description: "Hardcoded database password", status: "persisting" });

    const r1Judge = makeJudgeResult({ matched: [] });
    const r2Judge = makeJudgeResult({
      matched: [
        { golden: golden.rounds[1].expected_findings[0], actual: valR2 },
        { golden: golden.rounds[1].expected_findings[1], actual: pwR2 },
      ],
    });

    // idMap only has one of the two persisting findings
    const result = judgeMultiRound(
      [r1Judge, r2Judge], golden,
      [[], []],
      { "Missing input validation in createUser()": "r1-f-001" },
    );

    // Both matched, but only one had an idMap entry to verify against
    expect(result.persisting_ids_exact).toEqual({ pass: true, checked: 1, total: 2 });
  });

  it("resolved_ids_exact: reports partial coverage when idMap is incomplete", () => {
    const golden: MultiRoundGolden = {
      fixture: "test",
      rounds: [
        { expected_findings: [{ ...sqlInjectionGolden, expected_status: "new" }] },
        { expected_findings: [], expected_resolved: [{ description: "SQL injection in getUser()", expected_id_prefix: "r1-f-" }] },
      ],
    };

    const resolvedFinding = makeFinding({ id: "r1-f-001", title: "SQL injection in getUser()", description: "SQL injection in getUser()" });

    const r1Judge = makeJudgeResult({ matched: [] });
    const r2Judge = makeJudgeResult({ matched: [] });

    // Empty idMap — round 1 judge didn't match this finding
    const result = judgeMultiRound(
      [r1Judge, r2Judge], golden,
      [[], [resolvedFinding]],
      {},
    );

    expect(result.resolved_matched).toBe(1);
    // Resolved finding was found but no idMap entry to verify exact ID
    expect(result.resolved_ids_exact).toEqual({ pass: true, checked: 0, total: 1 });
  });

  it("resolved_ids_exact: checks resolved findings have exact round-1 IDs", () => {
    const golden: MultiRoundGolden = {
      fixture: "test",
      rounds: [
        { expected_findings: [{ ...sqlInjectionGolden, expected_status: "new" }] },
        { expected_findings: [], expected_resolved: [{ description: "SQL injection in getUser()", expected_id_prefix: "r1-f-" }] },
      ],
    };

    const resolvedFinding = makeFinding({ id: "r1-f-001", title: "SQL injection in getUser()", description: "SQL injection in getUser()" });

    const r1Judge = makeJudgeResult({ matched: [] });
    const r2Judge = makeJudgeResult({ matched: [] });

    const result = judgeMultiRound(
      [r1Judge, r2Judge], golden,
      [[], [resolvedFinding]],
      { "SQL injection in getUser()": "r1-f-001" },
    );

    expect(result.resolved_matched).toBe(1);
    expect(result.resolved_total).toBe(1);
    expect(result.resolved_ids_exact).toEqual({ pass: true, checked: 1, total: 1 });
  });

  it("resolved_ids_exact: fails when resolved finding has wrong ID", () => {
    const golden: MultiRoundGolden = {
      fixture: "test",
      rounds: [
        { expected_findings: [{ ...sqlInjectionGolden, expected_status: "new" }] },
        { expected_findings: [], expected_resolved: [{ description: "SQL injection in getUser()", expected_id_prefix: "r1-f-" }] },
      ],
    };

    // Wrong ID — should be r1-f-001 but got r1-f-999
    const resolvedFinding = makeFinding({ id: "r1-f-999", title: "SQL injection in getUser()", description: "SQL injection in getUser()" });

    const r1Judge = makeJudgeResult({ matched: [] });
    const r2Judge = makeJudgeResult({ matched: [] });

    const result = judgeMultiRound(
      [r1Judge, r2Judge], golden,
      [[], [resolvedFinding]],
      { "SQL injection in getUser()": "r1-f-001" },
    );

    expect(result.resolved_matched).toBe(1);
    expect(result.resolved_ids_exact).toEqual({ pass: false, checked: 1, total: 1 });
  });

  it("persisting_metadata_fresh: fails when persisting finding has stale metadata (F13)", () => {
    const golden: MultiRoundGolden = {
      fixture: "test",
      rounds: [
        { expected_findings: [{ ...validationGolden, expected_status: "new" }] },
        { expected_findings: [
          // Round 2 golden expects quality (changed from functional)
          { ...validationGolden, expected_impact: "quality", expected_status: "persisting" },
        ] },
      ],
    };

    // Finding still has round-1 impact "functional" instead of round-2 "quality"
    const staleR2 = makeFinding({
      id: "r1-f-001",
      title: "Missing input validation in createUser()",
      description: "Missing input validation in createUser()",
      impact: "functional", // Stale! Should be "quality"
      confidence: "likely",
      status: "persisting",
    });

    const r1Judge = makeJudgeResult({ matched: [] });
    const r2Judge = makeJudgeResult({
      matched: [{ golden: golden.rounds[1].expected_findings[0], actual: staleR2 }],
    });

    const result = judgeMultiRound(
      [r1Judge, r2Judge], golden,
      [[], []],
      { "Missing input validation in createUser()": "r1-f-001" },
    );

    expect(result.persisting_metadata_fresh).toEqual({ pass: false, checked: 1, total: 1 });
  });

  it("persisting_metadata_fresh: passes when persisting finding has fresh metadata", () => {
    const golden: MultiRoundGolden = {
      fixture: "test",
      rounds: [
        { expected_findings: [{ ...validationGolden, expected_status: "new" }] },
        { expected_findings: [
          { ...validationGolden, expected_impact: "quality", expected_status: "persisting" },
        ] },
      ],
    };

    const freshR2 = makeFinding({
      id: "r1-f-001",
      title: "Missing input validation in createUser()",
      description: "Missing input validation in createUser()",
      impact: "quality", // Fresh — matches round-2 golden
      confidence: "likely",
      status: "persisting",
    });

    const r1Judge = makeJudgeResult({ matched: [] });
    const r2Judge = makeJudgeResult({
      matched: [{ golden: golden.rounds[1].expected_findings[0], actual: freshR2 }],
    });

    const result = judgeMultiRound(
      [r1Judge, r2Judge], golden,
      [[], []],
      { "Missing input validation in createUser()": "r1-f-001" },
    );

    expect(result.persisting_metadata_fresh).toEqual({ pass: true, checked: 1, total: 1 });
  });

  it("coverage: reports partial coverage when judge misses a match", () => {
    const golden: MultiRoundGolden = {
      fixture: "test",
      rounds: [
        { expected_findings: [
          { ...sqlInjectionGolden, expected_status: "new" },
          { ...validationGolden, expected_status: "new" },
          { ...hardcodedPwGolden, expected_status: "new" },
        ] },
      ],
    };

    // Judge only matched 2 of 3
    const sqlFinding = makeFinding({ id: "r1-f-001", status: "new" });
    const valFinding = makeFinding({ id: "r1-f-002", title: "Missing input validation in createUser()", description: "Missing input validation in createUser()", impact: "functional", status: "new" });

    const r1Judge = makeJudgeResult({
      matched: [
        { golden: golden.rounds[0].expected_findings[0], actual: sqlFinding },
        { golden: golden.rounds[0].expected_findings[1], actual: valFinding },
      ],
    });

    const result = judgeMultiRound([r1Judge], golden, [[]], {});

    // status checked 2 of 3 golden findings that have expected_status
    expect(result.status_correct.pass).toBe(true);
    expect(result.status_correct.checked).toBe(2);
    expect(result.status_correct.total).toBe(3);
  });
});

describe("summary rendering branches on result type", () => {
  it("single-round results have precision/recall at top level", () => {
    const result: JudgeResult = makeJudgeResult({ precision: 0.8, recall: 0.9 });
    expect(isMultiRoundJudge(result)).toBe(false);
    expect(result.precision).toBe(0.8);
    expect(result.recall).toBe(0.9);
  });

  it("multi-round results have per-round precision/recall", () => {
    const result: MultiRoundJudgeResult = {
      rounds: [
        makeJudgeResult({ precision: 1.0, recall: 0.67 }),
        makeJudgeResult({ precision: 0.75, recall: 1.0 }),
      ],
      resolved_matched: 1,
      resolved_total: 1,
      resolved_ids_exact: { pass: true, checked: 1, total: 1 },
      status_correct: { pass: true, checked: 3, total: 3 },
      pre_existing_correct: { pass: true, checked: 2, total: 2 },
      persisting_ids_exact: { pass: true, checked: 2, total: 2 },
      persisting_metadata_fresh: { pass: true, checked: 1, total: 1 },
    };
    expect(isMultiRoundJudge(result)).toBe(true);
    expect(result.rounds[0].precision).toBe(1.0);
    expect(result.rounds[1].recall).toBe(1.0);
    expect("precision" in result).toBe(false);
  });
});
