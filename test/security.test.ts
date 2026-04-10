import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

describe("security edge cases", () => {
  describe("reviewer-parser: malformed inputs", () => {
    let parseReviewerOutput: typeof import("../src/reviewer-parser").parseReviewerOutput;
    let computePLevel: typeof import("../src/reviewer-parser").computePLevel;

    beforeEach(async () => {
      const mod = await import("../src/reviewer-parser");
      parseReviewerOutput = mod.parseReviewerOutput;
      computePLevel = mod.computePLevel;
    });

    it("handles invalid confidence values gracefully", () => {
      const raw = JSON.stringify({
        findings: [
          {
            id: "f-001",
            file: "x.ts",
            line: 1,
            confidence: "definitely",
            impact: "critical",
            category: "security",
            title: "Bug",
            description: "Bad",
            suggestion: "Fix",
          },
        ],
        metadata: { reviewer: "test", round: 1, timestamp: "2026-01-01T00:00:00Z" },
      });
      const result = parseReviewerOutput(raw, "test");
      expect(result[0].confidence).toBe("possible"); // defaults to "possible"
      expect(result[0].severity).toBe("p1"); // possible + critical = p1
    });

    it("handles invalid impact values gracefully", () => {
      const raw = JSON.stringify({
        findings: [
          {
            id: "f-001",
            file: "x.ts",
            line: 1,
            confidence: "verified",
            impact: "catastrophic",
            category: "security",
            title: "Bug",
            description: "Bad",
            suggestion: "Fix",
          },
        ],
        metadata: { reviewer: "test", round: 1, timestamp: "2026-01-01T00:00:00Z" },
      });
      const result = parseReviewerOutput(raw, "test");
      expect(result[0].impact).toBe("quality"); // defaults to "quality"
      expect(result[0].severity).toBe("p2"); // verified + quality = p2
    });

    it("handles completely empty JSON", () => {
      expect(parseReviewerOutput("{}", "test")).toEqual([]);
    });

    it("handles null findings", () => {
      const raw = JSON.stringify({ findings: null });
      expect(parseReviewerOutput(raw, "test")).toEqual([]);
    });

    it("handles findings with missing fields", () => {
      const raw = JSON.stringify({
        findings: [{ id: "f-001" }],
        metadata: { reviewer: "test", round: 1, timestamp: "2026-01-01T00:00:00Z" },
      });
      const result = parseReviewerOutput(raw, "test");
      expect(result[0].file).toBe("");
      expect(result[0].line).toBe(0);
      expect(result[0].confidence).toBe("possible");
      expect(result[0].impact).toBe("quality");
    });

    it("handles extremely large input without crashing", () => {
      const bigString = "x".repeat(1_000_000);
      const result = parseReviewerOutput(bigString, "test");
      expect(result).toEqual([]);
    });

    it("handles nested JSON within markdown with extra content", () => {
      const raw = `I found issues:
\`\`\`json
{"findings": [{"id": "f-001", "file": "a.ts", "line": 1, "confidence": "verified", "impact": "critical", "category": "sec", "title": "bug", "description": "d", "suggestion": "s"}]}
\`\`\`
And here is more text with another JSON: {"findings": [{"id": "should-not-match"}]}`;
      const result = parseReviewerOutput(raw, "test");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("f-001");
    });
  });

  describe("consolidator: edge cases", () => {
    let consolidate: typeof import("../src/consolidator").consolidate;

    beforeEach(async () => {
      const mod = await import("../src/consolidator");
      consolidate = mod.consolidate;
    });

    it("handles diff with no hunks (empty diff)", () => {
      const findings = [
        {
          id: "f-001",
          file: "a.ts",
          line: 1,
          confidence: "verified" as const,
          impact: "critical" as const,
          severity: "p0" as const,
          category: "sec",
          title: "Bug",
          description: "d",
          suggestion: "s",
          reviewer: "test",
          pre_existing: false,
        },
      ];
      const result = consolidate(findings, "");
      expect(result[0].pre_existing).toBe(true); // no hunks = everything is pre-existing
    });

    it("handles findings with identical titles but different case", () => {
      const findings = [
        {
          id: "f-001",
          file: "a.ts",
          line: 10,
          confidence: "verified" as const,
          impact: "critical" as const,
          severity: "p0" as const,
          category: "sec",
          title: "SQL Injection",
          description: "d1",
          suggestion: "s1",
          reviewer: "claude",
          pre_existing: false,
        },
        {
          id: "f-002",
          file: "a.ts",
          line: 10,
          confidence: "likely" as const,
          impact: "critical" as const,
          severity: "p0" as const,
          category: "sec",
          title: "sql injection",
          description: "d2",
          suggestion: "s2",
          reviewer: "codex",
          pre_existing: false,
        },
      ];
      const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -8,3 +8,5 @@
+new code
+more code`;
      const result = consolidate(findings, diff);
      expect(result).toHaveLength(1); // deduped by case-insensitive title
    });
  });


  describe("state: corruption resilience", () => {
    const TEST_DIR = "/tmp/review-orchestra-test-security-state";

    beforeEach(() => {
      if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
      mkdirSync(TEST_DIR, { recursive: true });
    });

    afterEach(() => {
      if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    });

    it("recovers from corrupted state file", async () => {
      const { SessionManager } = await import("../src/state");

      writeFileSync(join(TEST_DIR, "session.json"), "not valid json {{{");
      const sm = new SessionManager(TEST_DIR);
      expect(sm.getState().status).toBe("active"); // falls back to default
    });

    it("recovers from partially written state file", async () => {
      const { SessionManager } = await import("../src/state");

      writeFileSync(join(TEST_DIR, "session.json"), '{"status": "running", "currentRound": 1');
      const sm = new SessionManager(TEST_DIR);
      expect(sm.getState().status).toBe("active"); // invalid JSON, falls back
    });

    it("recovers from state file with wrong shape", async () => {
      const { SessionManager } = await import("../src/state");

      writeFileSync(join(TEST_DIR, "session.json"), '{"foo": "bar"}');
      const sm = new SessionManager(TEST_DIR);
      expect(sm.getState().status).toBe("active"); // missing required fields
    });
  });

  describe("toolchain: malformed package.json", () => {
    const TEST_DIR = "/tmp/review-orchestra-test-security-toolchain";

    beforeEach(() => {
      if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
      mkdirSync(TEST_DIR, { recursive: true });
    });

    afterEach(() => {
      if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    });

    it("handles malformed package.json without crashing", async () => {
      const { detectToolchain } = await import("../src/toolchain");

      writeFileSync(join(TEST_DIR, "package.json"), "not json at all");
      const info = detectToolchain(TEST_DIR);
      expect(info.language).toBe("unknown");
      expect(info.commands).toEqual([]);
    });

    it("handles package.json with no scripts field", async () => {
      const { detectToolchain } = await import("../src/toolchain");

      writeFileSync(join(TEST_DIR, "package.json"), '{"name": "test"}');
      const info = detectToolchain(TEST_DIR);
      expect(info.language).toBe("JavaScript");
      expect(info.commands).toEqual([]);
    });
  });

});
