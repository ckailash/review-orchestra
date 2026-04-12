import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import type { Finding } from "../src/types";

// We import the module under test — these will fail initially (red phase)
import { appendFindings, backfillResolved } from "../src/findings-store";

const TEST_DIR = "/tmp/review-orchestra-test-findings-store";
const JSONL_FILE = join(TEST_DIR, "findings.jsonl");

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "r1-f-001",
    file: "src/auth.ts",
    line: 42,
    confidence: "verified",
    impact: "critical",
    severity: "p0",
    category: "security",
    title: "SQL injection via unsanitized user input",
    description: "The userId parameter is interpolated directly into SQL.",
    suggestion: "Use parameterized queries.",
    reviewer: "claude",
    pre_existing: false,
    status: "new",
    ...overrides,
  };
}

function readLines(): string[] {
  if (!existsSync(JSONL_FILE)) return [];
  const content = readFileSync(JSONL_FILE, "utf-8").trim();
  if (content === "") return [];
  return content.split("\n");
}

function parseLine(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("appendFindings", () => {
  // VAL-STORE-001: directory creation
  it("creates directory and file on first write", () => {
    const finding = makeFinding();
    appendFindings({
      findings: [finding],
      sessionId: "20260314-100000",
      round: 1,
      project: "/Users/kailash/code/myapp",
      baseDir: TEST_DIR,
    });

    expect(existsSync(TEST_DIR)).toBe(true);
    expect(existsSync(JSONL_FILE)).toBe(true);
    const lines = readLines();
    expect(lines).toHaveLength(1);
  });

  // VAL-STORE-002: JSONL line schema correctness
  it("writes JSONL lines with correct schema and all required fields", () => {
    const finding = makeFinding({ status: "new" });
    appendFindings({
      findings: [finding],
      sessionId: "20260314-100000",
      round: 1,
      project: "/Users/kailash/code/myapp",
      baseDir: TEST_DIR,
    });

    const lines = readLines();
    expect(lines).toHaveLength(1);
    const parsed = parseLine(lines[0]);

    // timestamp is ISO 8601
    expect(typeof parsed.timestamp).toBe("string");
    expect(new Date(parsed.timestamp as string).toISOString()).toBe(
      parsed.timestamp,
    );

    // project is absolute path string
    expect(parsed.project).toBe("/Users/kailash/code/myapp");

    // sessionId matches YYYYMMDD-HHMMSS
    expect(parsed.sessionId).toBe("20260314-100000");

    // round is positive integer
    expect(parsed.round).toBe(1);

    // finding is the full Finding object
    const f = parsed.finding as Finding;
    expect(f.id).toBe("r1-f-001");
    expect(f.file).toBe("src/auth.ts");
    expect(f.line).toBe(42);
    expect(f.confidence).toBe("verified");
    expect(f.impact).toBe("critical");
    expect(f.severity).toBe("p0");
    expect(f.category).toBe("security");
    expect(f.title).toBe("SQL injection via unsanitized user input");
    expect(f.description).toBe(
      "The userId parameter is interpolated directly into SQL.",
    );
    expect(f.suggestion).toBe("Use parameterized queries.");
    expect(f.reviewer).toBe("claude");

    // status mirrors finding.status
    expect(parsed.status).toBe("new");

    // resolved_in_round is null for newly appended
    expect(parsed.resolved_in_round).toBeNull();
  });

  // VAL-STORE-003: Multiple findings in a single round
  it("appends multiple lines for multiple findings with same session context", () => {
    const findings = [
      makeFinding({ id: "r1-f-001", title: "Finding one" }),
      makeFinding({ id: "r1-f-002", title: "Finding two" }),
      makeFinding({ id: "r1-f-003", title: "Finding three" }),
    ];

    appendFindings({
      findings,
      sessionId: "20260314-100000",
      round: 1,
      project: "/Users/kailash/code/myapp",
      baseDir: TEST_DIR,
    });

    const lines = readLines();
    expect(lines).toHaveLength(3);

    // All lines have same sessionId, round, project
    for (const line of lines) {
      const parsed = parseLine(line);
      expect(parsed.sessionId).toBe("20260314-100000");
      expect(parsed.round).toBe(1);
      expect(parsed.project).toBe("/Users/kailash/code/myapp");
    }

    // Each has a distinct finding.id
    const ids = lines.map((l) => (parseLine(l).finding as Finding).id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(["r1-f-001", "r1-f-002", "r1-f-003"]);
  });

  // VAL-STORE-004: Empty findings array is a no-op
  it("does nothing when findings array is empty (no file created)", () => {
    appendFindings({
      findings: [],
      sessionId: "20260314-100000",
      round: 1,
      project: "/Users/kailash/code/myapp",
      baseDir: TEST_DIR,
    });

    // File should not be created
    expect(existsSync(JSONL_FILE)).toBe(false);
  });

  it("does nothing when findings array is empty (file already exists)", () => {
    // Pre-create a file with one line
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(JSONL_FILE, '{"existing":"data"}\n');

    appendFindings({
      findings: [],
      sessionId: "20260314-100000",
      round: 1,
      project: "/Users/kailash/code/myapp",
      baseDir: TEST_DIR,
    });

    // File should still have exactly one line
    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('{"existing":"data"}');
  });

  // VAL-STORE-005: Multi-round append
  it("appends to existing file across rounds without modifying earlier lines", () => {
    const round1Findings = [
      makeFinding({ id: "r1-f-001" }),
      makeFinding({ id: "r1-f-002" }),
      makeFinding({ id: "r1-f-003" }),
    ];

    appendFindings({
      findings: round1Findings,
      sessionId: "20260314-100000",
      round: 1,
      project: "/Users/kailash/code/myapp",
      baseDir: TEST_DIR,
    });

    const round1Lines = readLines();
    expect(round1Lines).toHaveLength(3);

    const round2Findings = [
      makeFinding({ id: "r2-f-001", status: "new" }),
      makeFinding({ id: "r1-f-001", status: "persisting" }),
    ];

    appendFindings({
      findings: round2Findings,
      sessionId: "20260314-100000",
      round: 2,
      project: "/Users/kailash/code/myapp",
      baseDir: TEST_DIR,
    });

    const allLines = readLines();
    expect(allLines).toHaveLength(5);

    // Round 1 lines are unchanged
    expect(allLines[0]).toBe(round1Lines[0]);
    expect(allLines[1]).toBe(round1Lines[1]);
    expect(allLines[2]).toBe(round1Lines[2]);

    // Round 2 lines have correct round
    expect(parseLine(allLines[3]).round).toBe(2);
    expect(parseLine(allLines[4]).round).toBe(2);
  });

  // VAL-STORE-006: Persisting findings retain original ID
  it("stores persisting findings with their original ID and correct round/status", () => {
    const finding = makeFinding({
      id: "r1-f-001",
      status: "persisting",
    });

    appendFindings({
      findings: [finding],
      sessionId: "20260314-100000",
      round: 2,
      project: "/Users/kailash/code/myapp",
      baseDir: TEST_DIR,
    });

    const lines = readLines();
    expect(lines).toHaveLength(1);
    const parsed = parseLine(lines[0]);
    expect((parsed.finding as Finding).id).toBe("r1-f-001");
    expect(parsed.round).toBe(2);
    expect(parsed.status).toBe("persisting");
  });

  // VAL-STORE-008: Idempotency — duplicate findings don't cause errors
  it("appends duplicate findings without error (append-only semantics)", () => {
    const finding = makeFinding({ id: "r1-f-001" });

    appendFindings({
      findings: [finding],
      sessionId: "20260314-100000",
      round: 1,
      project: "/Users/kailash/code/myapp",
      baseDir: TEST_DIR,
    });

    appendFindings({
      findings: [finding],
      sessionId: "20260314-100000",
      round: 1,
      project: "/Users/kailash/code/myapp",
      baseDir: TEST_DIR,
    });

    const lines = readLines();
    expect(lines).toHaveLength(2);
    // Both lines are valid
    for (const line of lines) {
      const parsed = parseLine(line);
      expect((parsed.finding as Finding).id).toBe("r1-f-001");
    }
  });

  // VAL-STORE-009: Finding with optional fields
  it("preserves optional fields (expected, observed, evidence) when present", () => {
    const finding = makeFinding({
      expected: "Database queries use parameterized inputs",
      observed: "userId is interpolated directly into the SQL query string",
      evidence: [
        "Line 42: db.query(`SELECT * FROM users WHERE id = ${userId}`)",
      ],
    });

    appendFindings({
      findings: [finding],
      sessionId: "20260314-100000",
      round: 1,
      project: "/Users/kailash/code/myapp",
      baseDir: TEST_DIR,
    });

    const lines = readLines();
    const parsed = parseLine(lines[0]);
    const f = parsed.finding as Finding;
    expect(f.expected).toBe("Database queries use parameterized inputs");
    expect(f.observed).toBe(
      "userId is interpolated directly into the SQL query string",
    );
    expect(f.evidence).toEqual([
      "Line 42: db.query(`SELECT * FROM users WHERE id = ${userId}`)",
    ]);
  });

  it("omits optional fields when absent from finding", () => {
    const finding = makeFinding();
    // Remove optional fields explicitly
    delete finding.expected;
    delete finding.observed;
    delete finding.evidence;

    appendFindings({
      findings: [finding],
      sessionId: "20260314-100000",
      round: 1,
      project: "/Users/kailash/code/myapp",
      baseDir: TEST_DIR,
    });

    const lines = readLines();
    const parsed = parseLine(lines[0]);
    const f = parsed.finding as Finding;
    expect(f.expected).toBeUndefined();
    expect(f.observed).toBeUndefined();
    expect(f.evidence).toBeUndefined();
  });

  // VAL-STORE-007: Concurrent writes don't corrupt the file
  it("handles concurrent appends without corrupting lines", async () => {
    const findings1 = Array.from({ length: 5 }, (_, i) =>
      makeFinding({ id: `session1-f-${i}` }),
    );
    const findings2 = Array.from({ length: 5 }, (_, i) =>
      makeFinding({ id: `session2-f-${i}` }),
    );

    // Run two appends concurrently
    await Promise.all([
      Promise.resolve(
        appendFindings({
          findings: findings1,
          sessionId: "20260314-100000",
          round: 1,
          project: "/Users/kailash/code/project1",
          baseDir: TEST_DIR,
        }),
      ),
      Promise.resolve(
        appendFindings({
          findings: findings2,
          sessionId: "20260314-100001",
          round: 1,
          project: "/Users/kailash/code/project2",
          baseDir: TEST_DIR,
        }),
      ),
    ]);

    const lines = readLines();
    expect(lines).toHaveLength(10);
    // Every line must be valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("backfillResolved", () => {
  // VAL-RESOLVE-001: Backfill sets resolved_in_round on matching entries
  it("sets resolved_in_round on matching JSONL entries", () => {
    // Write initial findings
    appendFindings({
      findings: [
        makeFinding({ id: "r1-f-001" }),
        makeFinding({ id: "r1-f-002" }),
      ],
      sessionId: "20260314-100000",
      round: 1,
      project: "/Users/kailash/code/myapp",
      baseDir: TEST_DIR,
    });

    // Backfill one finding as resolved in round 2
    backfillResolved({
      resolvedFindings: [makeFinding({ id: "r1-f-001" })],
      sessionId: "20260314-100000",
      resolvedInRound: 2,
      baseDir: TEST_DIR,
    });

    const lines = readLines();
    expect(lines).toHaveLength(2);

    const line1 = parseLine(lines[0]);
    expect(line1.resolved_in_round).toBe(2);

    const line2 = parseLine(lines[1]);
    expect(line2.resolved_in_round).toBeNull();
  });

  // VAL-RESOLVE-002: Backfill matches by finding ID + sessionId
  it("matches by finding ID + sessionId (other sessions unaffected)", () => {
    // Session 1 findings
    appendFindings({
      findings: [makeFinding({ id: "r1-f-001" })],
      sessionId: "20260314-100000",
      round: 1,
      project: "/Users/kailash/code/myapp",
      baseDir: TEST_DIR,
    });

    // Session 2 findings (same ID, different session)
    appendFindings({
      findings: [makeFinding({ id: "r1-f-001" })],
      sessionId: "20260315-120000",
      round: 1,
      project: "/Users/kailash/code/myapp",
      baseDir: TEST_DIR,
    });

    // Backfill only session 1
    backfillResolved({
      resolvedFindings: [makeFinding({ id: "r1-f-001" })],
      sessionId: "20260314-100000",
      resolvedInRound: 2,
      baseDir: TEST_DIR,
    });

    const lines = readLines();
    expect(lines).toHaveLength(2);

    // Session 1 entry is resolved
    const session1Line = parseLine(lines[0]);
    expect(session1Line.sessionId).toBe("20260314-100000");
    expect(session1Line.resolved_in_round).toBe(2);

    // Session 2 entry is NOT resolved
    const session2Line = parseLine(lines[1]);
    expect(session2Line.sessionId).toBe("20260315-120000");
    expect(session2Line.resolved_in_round).toBeNull();
  });

  // VAL-RESOLVE-003: Atomic rewrite
  it("rewrites the file atomically (same line count, non-matching lines unchanged)", () => {
    appendFindings({
      findings: [
        makeFinding({ id: "r1-f-001" }),
        makeFinding({ id: "r1-f-002" }),
        makeFinding({ id: "r1-f-003" }),
      ],
      sessionId: "20260314-100000",
      round: 1,
      project: "/Users/kailash/code/myapp",
      baseDir: TEST_DIR,
    });

    const preBackfillLines = readLines();

    backfillResolved({
      resolvedFindings: [makeFinding({ id: "r1-f-002" })],
      sessionId: "20260314-100000",
      resolvedInRound: 2,
      baseDir: TEST_DIR,
    });

    const postBackfillLines = readLines();

    // Same number of lines
    expect(postBackfillLines).toHaveLength(3);

    // Non-matching lines unchanged byte-for-byte
    expect(postBackfillLines[0]).toBe(preBackfillLines[0]);
    expect(postBackfillLines[2]).toBe(preBackfillLines[2]);

    // Matching line updated
    const updated = parseLine(postBackfillLines[1]);
    expect(updated.resolved_in_round).toBe(2);

    // No temp file left behind
    expect(existsSync(join(TEST_DIR, "findings.jsonl.tmp"))).toBe(false);
  });

  // VAL-RESOLVE-004: Empty resolvedFindings is a no-op
  it("does nothing when resolvedFindings is empty", () => {
    appendFindings({
      findings: [makeFinding({ id: "r1-f-001" })],
      sessionId: "20260314-100000",
      round: 1,
      project: "/Users/kailash/code/myapp",
      baseDir: TEST_DIR,
    });

    const beforeContent = readFileSync(JSONL_FILE, "utf-8");

    backfillResolved({
      resolvedFindings: [],
      sessionId: "20260314-100000",
      resolvedInRound: 2,
      baseDir: TEST_DIR,
    });

    const afterContent = readFileSync(JSONL_FILE, "utf-8");
    expect(afterContent).toBe(beforeContent);
  });

  // VAL-RESOLVE-005: Missing file is a no-op
  it("does nothing when findings.jsonl does not exist", () => {
    expect(() =>
      backfillResolved({
        resolvedFindings: [makeFinding({ id: "r1-f-001" })],
        sessionId: "20260314-100000",
        resolvedInRound: 2,
        baseDir: TEST_DIR,
      }),
    ).not.toThrow();

    // File should not be created
    expect(existsSync(JSONL_FILE)).toBe(false);
  });

  // VAL-RESOLVE-006: Multiple resolved findings in one call
  it("updates multiple resolved findings in a single call", () => {
    appendFindings({
      findings: [
        makeFinding({ id: "r1-f-001" }),
        makeFinding({ id: "r1-f-002" }),
        makeFinding({ id: "r1-f-003" }),
        makeFinding({ id: "r1-f-004" }),
      ],
      sessionId: "20260314-100000",
      round: 1,
      project: "/Users/kailash/code/myapp",
      baseDir: TEST_DIR,
    });

    backfillResolved({
      resolvedFindings: [
        makeFinding({ id: "r1-f-001" }),
        makeFinding({ id: "r1-f-003" }),
        makeFinding({ id: "r1-f-004" }),
      ],
      sessionId: "20260314-100000",
      resolvedInRound: 3,
      baseDir: TEST_DIR,
    });

    const lines = readLines();
    expect(lines).toHaveLength(4);

    // r1-f-001 resolved
    expect(parseLine(lines[0]).resolved_in_round).toBe(3);
    // r1-f-002 NOT resolved
    expect(parseLine(lines[1]).resolved_in_round).toBeNull();
    // r1-f-003 resolved
    expect(parseLine(lines[2]).resolved_in_round).toBe(3);
    // r1-f-004 resolved
    expect(parseLine(lines[3]).resolved_in_round).toBe(3);
  });

  // VAL-RESOLVE-007: Skip already-resolved findings
  it("does not overwrite already-resolved entries (first resolution wins)", () => {
    appendFindings({
      findings: [makeFinding({ id: "r1-f-001" })],
      sessionId: "20260314-100000",
      round: 1,
      project: "/Users/kailash/code/myapp",
      baseDir: TEST_DIR,
    });

    // Resolve in round 2
    backfillResolved({
      resolvedFindings: [makeFinding({ id: "r1-f-001" })],
      sessionId: "20260314-100000",
      resolvedInRound: 2,
      baseDir: TEST_DIR,
    });

    // Attempt to resolve again in round 3 — should be skipped
    backfillResolved({
      resolvedFindings: [makeFinding({ id: "r1-f-001" })],
      sessionId: "20260314-100000",
      resolvedInRound: 3,
      baseDir: TEST_DIR,
    });

    const lines = readLines();
    expect(lines).toHaveLength(1);
    // Still resolved in round 2, NOT updated to 3
    expect(parseLine(lines[0]).resolved_in_round).toBe(2);
  });

  it("handles backfill when all entries are already resolved", () => {
    appendFindings({
      findings: [
        makeFinding({ id: "r1-f-001" }),
        makeFinding({ id: "r1-f-002" }),
      ],
      sessionId: "20260314-100000",
      round: 1,
      project: "/Users/kailash/code/myapp",
      baseDir: TEST_DIR,
    });

    // Resolve all in round 2
    backfillResolved({
      resolvedFindings: [
        makeFinding({ id: "r1-f-001" }),
        makeFinding({ id: "r1-f-002" }),
      ],
      sessionId: "20260314-100000",
      resolvedInRound: 2,
      baseDir: TEST_DIR,
    });

    const beforeContent = readFileSync(JSONL_FILE, "utf-8");

    // Try to resolve again in round 3 — all already resolved, effective no-op
    backfillResolved({
      resolvedFindings: [
        makeFinding({ id: "r1-f-001" }),
        makeFinding({ id: "r1-f-002" }),
      ],
      sessionId: "20260314-100000",
      resolvedInRound: 3,
      baseDir: TEST_DIR,
    });

    const afterContent = readFileSync(JSONL_FILE, "utf-8");
    // File content should be identical (no changes needed)
    expect(afterContent).toBe(beforeContent);
  });
});
