import { describe, it, expect } from "vitest";
import { consolidate } from "../src/consolidator";
import type { Finding } from "../src/types";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
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
    ...overrides,
  };
}

// Simple diff with one hunk: src/auth.ts lines 40-50 were changed
const simpleDiff = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -38,7 +38,13 @@ function authenticate(req) {
   const token = req.headers.auth;
   const userId = req.params.id;
-  const user = db.query("SELECT * FROM users WHERE id = " + userId);
+  const user = db.query("SELECT * FROM users WHERE id = $1", [userId]);
+  if (!user) {
+    throw new Error("not found");
+  }
   return user;
 }`;

describe("consolidate", () => {
  describe("deduplication", () => {
    it("deduplicates findings from different reviewers at the same file:line with the same title", () => {
      const findings: Finding[] = [
        makeFinding({ id: "c-001", reviewer: "claude" }),
        makeFinding({ id: "x-001", reviewer: "codex" }),
      ];

      const result = consolidate(findings, simpleDiff);
      expect(result).toHaveLength(1);
    });

    it("keeps findings at different lines as separate", () => {
      const findings: Finding[] = [
        makeFinding({ id: "c-001", line: 42 }),
        makeFinding({ id: "c-002", line: 100, title: "Different bug" }),
      ];

      const result = consolidate(findings, simpleDiff);
      expect(result).toHaveLength(2);
    });

    it("keeps findings at the same line but different titles as separate", () => {
      const findings: Finding[] = [
        makeFinding({ id: "c-001", title: "SQL injection" }),
        makeFinding({
          id: "c-002",
          title: "Missing input validation",
          impact: "functional",
        }),
      ];

      const result = consolidate(findings, simpleDiff);
      expect(result).toHaveLength(2);
    });

    it("when deduplicating, keeps the finding with higher severity", () => {
      const findings: Finding[] = [
        makeFinding({
          id: "c-001",
          reviewer: "claude",
          confidence: "possible",
          impact: "functional",
          severity: "p2",
        }),
        makeFinding({
          id: "x-001",
          reviewer: "codex",
          confidence: "verified",
          impact: "critical",
          severity: "p0",
        }),
      ];

      const result = consolidate(findings, simpleDiff);
      expect(result).toHaveLength(1);
      expect(result[0].severity).toBe("p0");
    });
  });

  describe("pre-existing tagging", () => {
    it("tags findings outside the diff hunks as pre_existing", () => {
      const findings: Finding[] = [
        makeFinding({ id: "c-001", line: 42 }), // inside hunk (38-50)
        makeFinding({
          id: "c-002",
          line: 10,
          title: "Another issue",
        }), // outside hunk
      ];

      const result = consolidate(findings, simpleDiff);
      const inHunk = result.find((f) => f.line === 42);
      const outsideHunk = result.find((f) => f.line === 10);
      expect(inHunk?.pre_existing).toBe(false);
      expect(outsideHunk?.pre_existing).toBe(true);
    });

    it("tags findings in a file not in the diff as pre_existing", () => {
      const findings: Finding[] = [
        makeFinding({ id: "c-001", file: "src/other.ts", line: 1 }),
      ];

      const result = consolidate(findings, simpleDiff);
      expect(result[0].pre_existing).toBe(true);
    });
  });

  describe("equal severity tie-breaking on optional field richness", () => {
    it("prefers the finding with more populated optional fields when severity is equal (VAL-CONSOL-001)", () => {
      const sparse = makeFinding({
        id: "c-001",
        reviewer: "claude",
        severity: "p1",
        confidence: "likely",
        impact: "functional",
      });
      const rich = makeFinding({
        id: "x-001",
        reviewer: "codex",
        severity: "p1",
        confidence: "likely",
        impact: "functional",
        expected: "Parameterized queries should be used",
        observed: "String concatenation used for SQL",
        evidence: ["Line 42: db.query('SELECT * FROM users WHERE id = ' + userId)"],
      });

      const result = consolidate([sparse, rich], simpleDiff);
      expect(result).toHaveLength(1);
      expect(result[0].expected).toBe("Parameterized queries should be used");
      expect(result[0].observed).toBe("String concatenation used for SQL");
      expect(result[0].evidence).toEqual(["Line 42: db.query('SELECT * FROM users WHERE id = ' + userId)"]);
    });

    it("higher severity wins even with fewer optional fields than lower-severity duplicate (VAL-CONSOL-003)", () => {
      const highSev = makeFinding({
        id: "c-001",
        reviewer: "claude",
        severity: "p0",
        confidence: "verified",
        impact: "critical",
        // no optional fields
      });
      const lowSevRich = makeFinding({
        id: "x-001",
        reviewer: "codex",
        severity: "p2",
        confidence: "possible",
        impact: "functional",
        expected: "Should use parameterized queries",
        observed: "Uses string concat",
        evidence: ["Line 42 shows the issue"],
      });

      const result = consolidate([highSev, lowSevRich], simpleDiff);
      expect(result).toHaveLength(1);
      expect(result[0].severity).toBe("p0");
      expect(result[0].expected).toBeUndefined();
      expect(result[0].observed).toBeUndefined();
      expect(result[0].evidence).toBeUndefined();
    });

    it("preserves first-in order when severity and richness are equal (VAL-CONSOL-004)", () => {
      const first = makeFinding({
        id: "c-001",
        reviewer: "claude",
        severity: "p1",
        confidence: "likely",
        impact: "functional",
        expected: "First reviewer expected",
      });
      const second = makeFinding({
        id: "x-001",
        reviewer: "codex",
        severity: "p1",
        confidence: "likely",
        impact: "functional",
        expected: "Second reviewer expected",
      });

      const result = consolidate([first, second], simpleDiff);
      expect(result).toHaveLength(1);
      expect(result[0].expected).toBe("First reviewer expected");
      expect(result[0].reviewer).toBe("claude");
    });

    it("existing behavior: higher severity wins (VAL-CONSOL-002)", () => {
      const findings: Finding[] = [
        makeFinding({
          id: "c-001",
          reviewer: "claude",
          severity: "p2",
          confidence: "possible",
          impact: "functional",
          expected: "Should be safe",
          observed: "Not safe",
        }),
        makeFinding({
          id: "x-001",
          reviewer: "codex",
          severity: "p0",
          confidence: "verified",
          impact: "critical",
        }),
      ];

      const result = consolidate(findings, simpleDiff);
      expect(result).toHaveLength(1);
      expect(result[0].severity).toBe("p0");
      expect(result[0].reviewer).toBe("codex");
    });
  });

  describe("line=0 handling", () => {
    it("finding with line=0 is treated as NOT pre-existing regardless of diff hunks", () => {
      // line=0 means unknown location — consolidator treats it as inDiff=true
      const finding = makeFinding({
        id: "c-001",
        file: "src/auth.ts",
        line: 0,
        title: "Global issue with unknown line",
      });

      const result = consolidate([finding], simpleDiff);
      expect(result).toHaveLength(1);
      expect(result[0].pre_existing).toBe(false);
      expect(result[0].line).toBe(0);
    });
  });

  describe("empty inputs", () => {
    it("returns empty array for no findings", () => {
      const result = consolidate([], simpleDiff);
      expect(result).toEqual([]);
    });
  });

  describe("multi-file diff", () => {
    const multiDiff = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -38,7 +38,13 @@ function authenticate(req) {
-  old line
+  new line
diff --git a/src/api.ts b/src/api.ts
--- a/src/api.ts
+++ b/src/api.ts
@@ -10,3 +10,5 @@ function handler() {
-  old api
+  new api
+  extra line`;

    it("handles findings across multiple files", () => {
      const findings: Finding[] = [
        makeFinding({ id: "c-001", file: "src/auth.ts", line: 40 }),
        makeFinding({
          id: "c-002",
          file: "src/api.ts",
          line: 12,
          title: "API issue",
        }),
        makeFinding({
          id: "c-003",
          file: "src/api.ts",
          line: 100,
          title: "Far away",
        }),
      ];

      const result = consolidate(findings, multiDiff);
      const auth = result.find((f) => f.file === "src/auth.ts");
      const apiInHunk = result.find(
        (f) => f.file === "src/api.ts" && f.line === 12
      );
      const apiOutside = result.find(
        (f) => f.file === "src/api.ts" && f.line === 100
      );

      expect(auth?.pre_existing).toBe(false);
      expect(apiInHunk?.pre_existing).toBe(false);
      expect(apiOutside?.pre_existing).toBe(true);
    });
  });

  describe("semantic (fuzzy) dedup", () => {
    it("merges two findings from different reviewers, same file, same line, different titles for same bug (VAL-CON-001)", () => {
      const findings: Finding[] = [
        makeFinding({
          id: "c-001",
          reviewer: "claude",
          file: "src/auth.ts",
          line: 42,
          title: "SQL injection vulnerability",
          severity: "p1",
          category: "security",
        }),
        makeFinding({
          id: "x-001",
          reviewer: "codex",
          file: "src/auth.ts",
          line: 42,
          title: "Unsanitized SQL query input",
          severity: "p1",
          category: "security",
        }),
      ];

      const result = consolidate(findings, simpleDiff);
      expect(result).toHaveLength(1);
    });

    it("merged finding has comma-joined reviewer names (VAL-CON-002)", () => {
      const findings: Finding[] = [
        makeFinding({
          id: "c-001",
          reviewer: "claude",
          file: "src/auth.ts",
          line: 42,
          title: "SQL injection vulnerability",
          severity: "p1",
          category: "security",
        }),
        makeFinding({
          id: "x-001",
          reviewer: "codex",
          file: "src/auth.ts",
          line: 42,
          title: "Unsanitized SQL query input",
          severity: "p1",
          category: "security",
        }),
      ];

      const result = consolidate(findings, simpleDiff);
      expect(result).toHaveLength(1);
      expect(result[0].reviewer).toBe("claude,codex");
    });

    it("merged finding keeps higher severity (VAL-CON-003)", () => {
      const findings: Finding[] = [
        makeFinding({
          id: "c-001",
          reviewer: "claude",
          file: "src/auth.ts",
          line: 42,
          title: "SQL injection vulnerability",
          severity: "p2",
          category: "security",
        }),
        makeFinding({
          id: "x-001",
          reviewer: "codex",
          file: "src/auth.ts",
          line: 42,
          title: "Unsanitized SQL query input",
          severity: "p0",
          category: "security",
        }),
      ];

      const result = consolidate(findings, simpleDiff);
      expect(result).toHaveLength(1);
      expect(result[0].severity).toBe("p0");
    });

    it("merged finding keeps the one with more populated optional fields when severity ties (VAL-CON-004)", () => {
      const findings: Finding[] = [
        makeFinding({
          id: "c-001",
          reviewer: "claude",
          file: "src/auth.ts",
          line: 42,
          title: "SQL injection vulnerability",
          severity: "p1",
          category: "security",
        }),
        makeFinding({
          id: "x-001",
          reviewer: "codex",
          file: "src/auth.ts",
          line: 42,
          title: "Unsanitized SQL query input",
          severity: "p1",
          category: "security",
          expected: "Parameterized queries",
          observed: "String concatenation",
          evidence: ["Line 42"],
        }),
      ];

      const result = consolidate(findings, simpleDiff);
      expect(result).toHaveLength(1);
      expect(result[0].expected).toBe("Parameterized queries");
      expect(result[0].observed).toBe("String concatenation");
      expect(result[0].reviewer).toBe("claude,codex");
    });

    it("two findings from same reviewer, same file, nearby lines are NOT fuzzy-merged (VAL-CON-005)", () => {
      const findings: Finding[] = [
        makeFinding({
          id: "c-001",
          reviewer: "claude",
          file: "src/auth.ts",
          line: 42,
          title: "SQL injection vulnerability",
          severity: "p1",
          category: "security",
        }),
        makeFinding({
          id: "c-002",
          reviewer: "claude",
          file: "src/auth.ts",
          line: 43,
          title: "Unsanitized SQL query input",
          severity: "p1",
          category: "security",
        }),
      ];

      const result = consolidate(findings, simpleDiff);
      expect(result).toHaveLength(2);
      // Both findings should retain their original reviewer
      expect(result.every((f) => f.reviewer === "claude")).toBe(true);
    });

    it("two findings from different reviewers, same file, same line, genuinely different issues are NOT merged (VAL-CON-006)", () => {
      const findings: Finding[] = [
        makeFinding({
          id: "c-001",
          reviewer: "claude",
          file: "src/auth.ts",
          line: 42,
          title: "SQL injection vulnerability",
          severity: "p1",
          category: "security",
        }),
        makeFinding({
          id: "x-001",
          reviewer: "codex",
          file: "src/auth.ts",
          line: 42,
          title: "Missing error handling for null user",
          severity: "p1",
          category: "error-handling",
        }),
      ];

      const result = consolidate(findings, simpleDiff);
      expect(result).toHaveLength(2);
    });

    it("after A+B merge, C with overlapping reviewer is NOT merged into the result (reviewer-set dedup)", () => {
      // A (claude, line=10) and B (codex, line=10) should merge → 'claude,codex'
      // C (claude, line=11) must NOT merge with the result because 'claude' is already in the merged set
      const findings: Finding[] = [
        makeFinding({
          id: "a-001",
          reviewer: "claude",
          file: "src/auth.ts",
          line: 10,
          title: "SQL injection vulnerability",
          severity: "p1",
          category: "security",
        }),
        makeFinding({
          id: "b-001",
          reviewer: "codex",
          file: "src/auth.ts",
          line: 10,
          title: "Unsanitized SQL query input",
          severity: "p1",
          category: "security",
        }),
        makeFinding({
          id: "c-001",
          reviewer: "claude",
          file: "src/auth.ts",
          line: 11,
          title: "SQL injection in query builder",
          severity: "p1",
          category: "security",
        }),
      ];

      const result = consolidate(findings, simpleDiff);
      // A+B merge into one, C stays separate → 2 findings
      expect(result).toHaveLength(2);
      // One finding should be the merged A+B with comma-joined reviewers
      const mergedFinding = result.find((f) => f.reviewer.includes(","));
      expect(mergedFinding).toBeDefined();
      expect(mergedFinding!.reviewer).toBe("claude,codex");
      // The other finding should be C with its original reviewer
      const separateFinding = result.find((f) => !f.reviewer.includes(","));
      expect(separateFinding).toBeDefined();
      expect(separateFinding!.reviewer).toBe("claude");
      expect(separateFinding!.id).toBe("c-001");
    });
  });
});
