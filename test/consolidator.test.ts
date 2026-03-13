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
});
