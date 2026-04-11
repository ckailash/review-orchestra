import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  compareFindings,
  assignFindingIds,
  summarizeFinding,
  buildComparisonPrompt,
} from "../src/finding-comparison";
import type { Finding, FindingComparisonConfig } from "../src/types";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "",
    file: "src/auth.ts",
    line: 42,
    confidence: "verified",
    impact: "critical",
    severity: "p0",
    category: "security",
    title: "SQL injection",
    description: "Bad",
    suggestion: "Fix",
    reviewer: "claude",
    pre_existing: false,
    ...overrides,
  };
}

const LLM_CONFIG: FindingComparisonConfig = {
  method: "llm",
  model: "claude-haiku-4-5",
  timeoutMs: 60000,
  fallback: "heuristic",
};

const HEURISTIC_CONFIG: FindingComparisonConfig = {
  method: "heuristic",
  model: "claude-haiku-4-5",
  timeoutMs: 60000,
  fallback: "heuristic",
};

describe("finding comparison", () => {
  describe("compareFindings", () => {
    it("tags all findings as new on first round (no previous findings)", async () => {
      const current = [
        makeFinding({ file: "src/a.ts", title: "Bug A" }),
        makeFinding({ file: "src/b.ts", title: "Bug B" }),
      ];

      const result = await compareFindings(current, []);

      expect(result.newFindings).toHaveLength(2);
      expect(result.persistingFindings).toHaveLength(0);
      expect(result.resolvedFindings).toHaveLength(0);
    });

    it("identifies persisting findings by file + title.toLowerCase()", async () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
      ];

      const result = await compareFindings(current, previous);

      expect(result.newFindings).toHaveLength(0);
      expect(result.persistingFindings).toHaveLength(1);
      expect(result.resolvedFindings).toHaveLength(0);
    });

    it("uses case-insensitive title matching", async () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL Injection" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "sql injection" }),
      ];

      const result = await compareFindings(current, previous);

      expect(result.newFindings).toHaveLength(0);
      expect(result.persistingFindings).toHaveLength(1);
      // Persisting finding should keep the original ID
      expect(result.persistingFindings[0].id).toBe("r1-f-001");
    });

    it("identifies resolved findings (in previous but not current)", async () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
        makeFinding({ id: "r1-f-002", file: "src/b.ts", title: "XSS vulnerability" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
      ];

      const result = await compareFindings(current, previous);

      expect(result.persistingFindings).toHaveLength(1);
      expect(result.resolvedFindings).toHaveLength(1);
      expect(result.resolvedFindings[0].id).toBe("r1-f-002");
      expect(result.resolvedFindings[0].title).toBe("XSS vulnerability");
    });

    it("identifies new findings (in current but not previous)", async () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
        makeFinding({ file: "src/new.ts", title: "New bug" }),
      ];

      const result = await compareFindings(current, previous);

      expect(result.newFindings).toHaveLength(1);
      expect(result.newFindings[0].file).toBe("src/new.ts");
      expect(result.persistingFindings).toHaveLength(1);
      expect(result.resolvedFindings).toHaveLength(0);
    });

    it("requires exact file match (different files are different findings)", async () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
      ];
      const current = [
        makeFinding({ file: "src/other.ts", title: "SQL injection" }),
      ];

      const result = await compareFindings(current, previous);

      expect(result.newFindings).toHaveLength(1);
      expect(result.persistingFindings).toHaveLength(0);
      expect(result.resolvedFindings).toHaveLength(1);
    });

    it("handles mixed new, persisting, and resolved findings", async () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/a.ts", title: "Bug A" }),
        makeFinding({ id: "r1-f-002", file: "src/b.ts", title: "Bug B" }),
        makeFinding({ id: "r1-f-003", file: "src/c.ts", title: "Bug C" }),
      ];
      const current = [
        makeFinding({ file: "src/a.ts", title: "Bug A" }),       // persisting
        makeFinding({ file: "src/d.ts", title: "Bug D" }),       // new
        makeFinding({ file: "src/e.ts", title: "Bug E" }),       // new
      ];

      const result = await compareFindings(current, previous);

      expect(result.newFindings).toHaveLength(2);
      expect(result.persistingFindings).toHaveLength(1);
      expect(result.persistingFindings[0].id).toBe("r1-f-001");
      expect(result.resolvedFindings).toHaveLength(2);
      expect(result.resolvedFindings.map(f => f.id).sort()).toEqual(["r1-f-002", "r1-f-003"]);
    });

    it("treats findings at different lines as same when file + title match", async () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", line: 10, title: "Null check missing" }),
        makeFinding({ id: "r1-f-002", file: "src/auth.ts", line: 50, title: "Null check missing" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", line: 10, title: "Null check missing" }),
        makeFinding({ file: "src/auth.ts", line: 50, title: "Null check missing" }),
      ];

      const result = await compareFindings(current, previous);

      // With file + title key (no line), both previous entries map to the same key.
      // The Map keeps the last one (r1-f-002). Both current entries also map to the
      // same key and both match against the Map entry, so both become persisting
      // with the same preserved ID.
      expect(result.persistingFindings).toHaveLength(2);
      expect(result.persistingFindings.every(f => f.id === "r1-f-002")).toBe(true);
      expect(result.newFindings).toHaveLength(0);
      expect(result.resolvedFindings).toHaveLength(0);
    });

    it("matches findings with same file, line, and title (exact match)", async () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", line: 42, title: "SQL injection" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", line: 42, title: "SQL injection" }),
      ];

      const result = await compareFindings(current, previous);

      expect(result.persistingFindings).toHaveLength(1);
      expect(result.persistingFindings[0].id).toBe("r1-f-001");
      expect(result.newFindings).toHaveLength(0);
      expect(result.resolvedFindings).toHaveLength(0);
    });

    it("returns resolved findings as-is from previous round", async () => {
      const previous = [
        makeFinding({
          id: "r1-f-001",
          file: "src/auth.ts",
          title: "SQL injection",
          status: "new",
          severity: "p0",
          description: "Original description",
        }),
      ];
      const current: Finding[] = [];

      const result = await compareFindings(current, previous);

      expect(result.resolvedFindings).toHaveLength(1);
      expect(result.resolvedFindings[0]).toEqual(previous[0]);
    });
  });

  describe("assignFindingIds", () => {
    it("assigns round-scoped IDs to new findings in rN-f-NNN format", async () => {
      const newFindings = [
        makeFinding({ file: "src/a.ts", title: "Bug A" }),
        makeFinding({ file: "src/b.ts", title: "Bug B" }),
        makeFinding({ file: "src/c.ts", title: "Bug C" }),
      ];

      const result = await assignFindingIds(newFindings, [], 1);

      expect(result.findings[0].id).toBe("r1-f-001");
      expect(result.findings[1].id).toBe("r1-f-002");
      expect(result.findings[2].id).toBe("r1-f-003");
    });

    it("assigns status 'new' to new findings", async () => {
      const newFindings = [
        makeFinding({ file: "src/a.ts", title: "Bug A" }),
      ];

      const result = await assignFindingIds(newFindings, [], 1);

      expect(result.findings[0].status).toBe("new");
    });

    it("assigns status 'persisting' to persisting findings", async () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
      ];

      const result = await assignFindingIds(current, previous, 2);

      expect(result.findings[0].status).toBe("persisting");
      expect(result.findings[0].id).toBe("r1-f-001");
    });

    it("preserves original ID for persisting findings across rounds", async () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection", status: "new" }),
        makeFinding({ id: "r1-f-002", file: "src/b.ts", title: "XSS", status: "new" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
        makeFinding({ file: "src/b.ts", title: "XSS" }),
        makeFinding({ file: "src/c.ts", title: "New Bug" }),
      ];

      const result = await assignFindingIds(current, previous, 2);

      const persisting = result.findings.filter(f => f.status === "persisting");
      const newOnes = result.findings.filter(f => f.status === "new");

      expect(persisting).toHaveLength(2);
      expect(persisting.find(f => f.title === "SQL injection")?.id).toBe("r1-f-001");
      expect(persisting.find(f => f.title === "XSS")?.id).toBe("r1-f-002");
      expect(newOnes).toHaveLength(1);
      expect(newOnes[0].id).toBe("r2-f-001");
    });

    it("zero-pads the sequential number to 3 digits", async () => {
      const findings = Array.from({ length: 12 }, (_, i) =>
        makeFinding({ file: `src/f${i}.ts`, title: `Bug ${i}` })
      );

      const result = await assignFindingIds(findings, [], 1);

      expect(result.findings[0].id).toBe("r1-f-001");
      expect(result.findings[9].id).toBe("r1-f-010");
      expect(result.findings[11].id).toBe("r1-f-012");
    });

    it("returns resolved findings in separate array", async () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
        makeFinding({ id: "r1-f-002", file: "src/old.ts", title: "Old bug" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
      ];

      const result = await assignFindingIds(current, previous, 2);

      expect(result.findings).toHaveLength(1);
      expect(result.resolvedFindings).toHaveLength(1);
      expect(result.resolvedFindings[0].id).toBe("r1-f-002");
    });

    it("first round: all findings are new with r1-f-NNN IDs", async () => {
      const findings = [
        makeFinding({ file: "src/a.ts", title: "Bug A" }),
        makeFinding({ file: "src/b.ts", title: "Bug B" }),
        makeFinding({ file: "src/c.ts", title: "Bug C" }),
      ];

      const result = await assignFindingIds(findings, [], 1);

      expect(result.findings).toHaveLength(3);
      expect(result.resolvedFindings).toHaveLength(0);
      expect(result.findings.every(f => f.status === "new")).toBe(true);
      expect(result.findings[0].id).toBe("r1-f-001");
      expect(result.findings[1].id).toBe("r1-f-002");
      expect(result.findings[2].id).toBe("r1-f-003");
    });

    it("handles empty current findings (all resolved)", async () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/a.ts", title: "Bug A" }),
      ];

      const result = await assignFindingIds([], previous, 2);

      expect(result.findings).toHaveLength(0);
      expect(result.resolvedFindings).toHaveLength(1);
    });

    it("handles both empty current and previous findings", async () => {
      const result = await assignFindingIds([], [], 1);

      expect(result.findings).toHaveLength(0);
      expect(result.resolvedFindings).toHaveLength(0);
    });
  });

  describe("summarizeFinding", () => {
    it("produces correct 3-line format", () => {
      const finding = makeFinding({
        file: "src/auth/middleware.ts",
        line: 42,
        category: "security",
        severity: "p0",
        description: "userId parameter interpolated directly into SQL query without parameterization",
        suggestion: "Use parameterized queries with $1 placeholders",
      });

      const result = summarizeFinding(finding, "PREV-1");
      const lines = result.split("\n");

      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe("[PREV-1] file:src/auth/middleware.ts line:42 cat:security sev:p0");
      expect(lines[1]).toBe("  Issue: userId parameter interpolated directly into SQL query without parameterization");
      expect(lines[2]).toBe("  Fix: Use parameterized queries with $1 placeholders");
    });

    it("truncates long description to ~100 chars", () => {
      const longDesc = "A".repeat(150);
      const finding = makeFinding({
        description: longDesc,
      });

      const result = summarizeFinding(finding, "CUR-1");
      const lines = result.split("\n");

      const issueLine = lines[1];
      // "  Issue: " prefix is 9 chars. Content should be truncated to 97 + "..." = 100 chars
      const issueContent = issueLine.replace("  Issue: ", "");
      expect(issueContent.length).toBeLessThanOrEqual(100);
      expect(issueContent).toMatch(/\.\.\.$/);
    });

    it("truncates long suggestion to ~100 chars", () => {
      const longSuggestion = "B".repeat(150);
      const finding = makeFinding({
        suggestion: longSuggestion,
      });

      const result = summarizeFinding(finding, "CUR-2");
      const lines = result.split("\n");

      const fixLine = lines[2];
      const fixContent = fixLine.replace("  Fix: ", "");
      expect(fixContent.length).toBeLessThanOrEqual(100);
      expect(fixContent).toMatch(/\.\.\.$/);
    });

    it("appends title when description is short (< 20 chars)", () => {
      const finding = makeFinding({
        title: "SQL injection vulnerability",
        description: "Bad query",
        suggestion: "Use parameterized queries with $1 placeholders to avoid injection attacks in all endpoints",
      });

      const result = summarizeFinding(finding, "CUR-1");
      const lines = result.split("\n");

      expect(lines[1]).toContain("(title: SQL injection vulnerability)");
    });

    it("appends title when suggestion is short (< 20 chars)", () => {
      const finding = makeFinding({
        title: "Null pointer dereference",
        description: "The variable obj is dereferenced without a null check in the main handler function",
        suggestion: "Add null check",
      });

      const result = summarizeFinding(finding, "PREV-2");
      const lines = result.split("\n");

      expect(lines[2]).toContain("(title: Null pointer dereference)");
    });

    it("does not append title when description >= 20 chars", () => {
      const finding = makeFinding({
        title: "SQL injection",
        description: "This is a sufficiently long description that should not need title",
        suggestion: "Use parameterized queries with placeholders",
      });

      const result = summarizeFinding(finding, "CUR-1");
      const lines = result.split("\n");

      expect(lines[1]).not.toContain("(title:");
    });

    it("handles missing optional fields without crashing", () => {
      const finding = makeFinding({
        expected: undefined,
        observed: undefined,
        evidence: undefined,
      });

      expect(() => summarizeFinding(finding, "CUR-1")).not.toThrow();
      const result = summarizeFinding(finding, "CUR-1");
      const lines = result.split("\n");
      expect(lines).toHaveLength(3);
    });

    it("uses correct label in output", () => {
      const finding = makeFinding();
      const result = summarizeFinding(finding, "PREV-42");
      expect(result).toMatch(/^\[PREV-42\]/);
    });
  });

  describe("buildComparisonPrompt", () => {
    it("includes previous and current sections with summaries", () => {
      const previous = "PREV-1 summary\nPREV-2 summary";
      const current = "CUR-1 summary\nCUR-2 summary";

      const prompt = buildComparisonPrompt(previous, current);

      expect(prompt).toContain("## Previous round findings:");
      expect(prompt).toContain(previous);
      expect(prompt).toContain("## Current round findings:");
      expect(prompt).toContain(current);
    });

    it("includes JSON output format instruction", () => {
      const prompt = buildComparisonPrompt("prev", "cur");

      expect(prompt).toContain('"matches"');
      expect(prompt).toContain('"current"');
      expect(prompt).toContain('"previous"');
      expect(prompt).toContain("Return JSON only");
    });

    it("includes matching rules (same root cause, file renames, 1:1 constraint)", () => {
      const prompt = buildComparisonPrompt("prev", "cur");

      expect(prompt).toContain("same root cause");
      expect(prompt).toContain("renamed");
      expect(prompt).toContain("at most one");
    });

    it("includes null convention for unmatched findings", () => {
      const prompt = buildComparisonPrompt("prev", "cur");

      expect(prompt).toContain("null");
      expect(prompt).toContain("no match");
    });

    it("includes system instructions about comparing findings", () => {
      const prompt = buildComparisonPrompt("prev", "cur");

      expect(prompt).toContain("comparing code review findings");
      expect(prompt).toContain("same underlying code problem");
    });
  });

  describe("compareFindings LLM path", () => {
    let mockSpawnWithStreaming: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const processModule = await import("../src/process");
      mockSpawnWithStreaming = vi.spyOn(processModule, "spawnWithStreaming") as unknown as ReturnType<typeof vi.fn>;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("short-circuits on empty previousFindings (mock not called)", async () => {
      const current = [
        makeFinding({ file: "src/a.ts", title: "Bug A" }),
      ];

      const result = await compareFindings(current, [], LLM_CONFIG);

      expect(result.newFindings).toHaveLength(1);
      expect(result.persistingFindings).toHaveLength(0);
      expect(result.resolvedFindings).toHaveLength(0);
      expect(mockSpawnWithStreaming).not.toHaveBeenCalled();
    });

    it("uses heuristic when method='heuristic' (mock not called)", async () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
      ];

      const result = await compareFindings(current, previous, HEURISTIC_CONFIG);

      expect(result.persistingFindings).toHaveLength(1);
      expect(result.persistingFindings[0].id).toBe("r1-f-001");
      expect(mockSpawnWithStreaming).not.toHaveBeenCalled();
    });

    it("falls back on LLM spawn error + logs warning", async () => {
      const logModule = await import("../src/log");
      const logSpy = vi.spyOn(logModule, "log");

      mockSpawnWithStreaming.mockRejectedValue(new Error("claude binary not found"));

      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
      ];

      const result = await compareFindings(current, previous, LLM_CONFIG);

      // Should fall back to heuristic
      expect(result.persistingFindings).toHaveLength(1);
      expect(result.persistingFindings[0].id).toBe("r1-f-001");

      // Should log warning
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("falling back to heuristic matching"),
      );
    });

    it("falls back on malformed JSON response", async () => {
      const logModule = await import("../src/log");
      const logSpy = vi.spyOn(logModule, "log");

      mockSpawnWithStreaming.mockResolvedValue("I cannot help with that request.");

      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
      ];

      const result = await compareFindings(current, previous, LLM_CONFIG);

      expect(result.persistingFindings).toHaveLength(1);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("falling back to heuristic matching"),
      );
    });

    it("falls back on invalid match IDs in response", async () => {
      const logModule = await import("../src/log");
      const logSpy = vi.spyOn(logModule, "log");

      mockSpawnWithStreaming.mockResolvedValue(
        JSON.stringify({
          matches: [
            { current: "CUR-1", previous: "PREV-99" },
          ],
        }),
      );

      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
      ];

      const result = await compareFindings(current, previous, LLM_CONFIG);

      expect(result.persistingFindings).toHaveLength(1);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("falling back to heuristic matching"),
      );
    });

    it("falls back when LLM returns duplicate CUR-id in matches", async () => {
      const logModule = await import("../src/log");
      const logSpy = vi.spyOn(logModule, "log");

      mockSpawnWithStreaming.mockResolvedValue(
        JSON.stringify({
          matches: [
            { current: "CUR-1", previous: "PREV-1" },
            { current: "CUR-1", previous: "PREV-2" },
          ],
        }),
      );

      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
        makeFinding({ id: "r1-f-002", file: "src/b.ts", title: "XSS" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
        makeFinding({ file: "src/b.ts", title: "XSS" }),
      ];

      const result = await compareFindings(current, previous, LLM_CONFIG);

      // Should fall back to heuristic
      expect(result.persistingFindings).toHaveLength(2);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("falling back to heuristic matching"),
      );
    });

    it("falls back when LLM returns duplicate PREV-id in matches", async () => {
      const logModule = await import("../src/log");
      const logSpy = vi.spyOn(logModule, "log");

      mockSpawnWithStreaming.mockResolvedValue(
        JSON.stringify({
          matches: [
            { current: "CUR-1", previous: "PREV-1" },
            { current: "CUR-2", previous: "PREV-1" },
          ],
        }),
      );

      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
        makeFinding({ id: "r1-f-002", file: "src/b.ts", title: "XSS" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
        makeFinding({ file: "src/b.ts", title: "XSS" }),
      ];

      const result = await compareFindings(current, previous, LLM_CONFIG);

      // Should fall back to heuristic
      expect(result.persistingFindings).toHaveLength(2);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("falling back to heuristic matching"),
      );
    });

    it("falls back when LLM omits a CUR-id from matches", async () => {
      const logModule = await import("../src/log");
      const logSpy = vi.spyOn(logModule, "log");

      // Only includes CUR-1, omits CUR-2
      mockSpawnWithStreaming.mockResolvedValue(
        JSON.stringify({
          matches: [
            { current: "CUR-1", previous: "PREV-1" },
          ],
        }),
      );

      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
        makeFinding({ file: "src/b.ts", title: "XSS" }),
      ];

      const result = await compareFindings(current, previous, LLM_CONFIG);

      // Should fall back to heuristic
      expect(result.newFindings).toHaveLength(1);
      expect(result.persistingFindings).toHaveLength(1);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("falling back to heuristic matching"),
      );
    });

    it("falls back when matches array length != current findings count", async () => {
      const logModule = await import("../src/log");
      const logSpy = vi.spyOn(logModule, "log");

      // 3 matches but only 2 current findings
      mockSpawnWithStreaming.mockResolvedValue(
        JSON.stringify({
          matches: [
            { current: "CUR-1", previous: "PREV-1" },
            { current: "CUR-2", previous: null },
            { current: "CUR-3", previous: null },
          ],
        }),
      );

      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
        makeFinding({ file: "src/b.ts", title: "XSS" }),
      ];

      const result = await compareFindings(current, previous, LLM_CONFIG);

      // Should fall back to heuristic
      expect(result.persistingFindings).toHaveLength(1);
      expect(result.newFindings).toHaveLength(1);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("falling back to heuristic matching"),
      );
    });

    it("fallback='error' propagates LLM error", async () => {
      mockSpawnWithStreaming.mockRejectedValue(new Error("spawn failed"));

      const errorConfig: FindingComparisonConfig = {
        ...LLM_CONFIG,
        fallback: "error",
      };

      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
      ];

      await expect(
        compareFindings(current, previous, errorConfig),
      ).rejects.toThrow("spawn failed");
    });

    it("LLM spawns claude with correct args (check mock call args)", async () => {
      mockSpawnWithStreaming.mockResolvedValue(
        JSON.stringify({
          matches: [
            { current: "CUR-1", previous: "PREV-1" },
          ],
        }),
      );

      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
      ];

      await compareFindings(current, previous, LLM_CONFIG);

      expect(mockSpawnWithStreaming).toHaveBeenCalledWith(
        expect.objectContaining({
          bin: "claude",
          args: ["-p", "-", "--output-format", "text", "--model", "claude-haiku-4-5"],
          label: "finding-comparison",
          inactivityTimeout: 60000,
          catastrophicTimeout: 600000,
        }),
      );

      // Verify prompt is passed as input
      const callArgs = mockSpawnWithStreaming.mock.calls[0][0];
      expect(callArgs.input).toContain("Previous round findings:");
      expect(callArgs.input).toContain("Current round findings:");
    });

    it("end-to-end with mocked valid LLM response → correct ComparisonResult", async () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection", description: "User input in SQL" }),
        makeFinding({ id: "r1-f-002", file: "src/api.ts", title: "XSS in template", description: "Unescaped output" }),
        makeFinding({ id: "r1-f-003", file: "src/old.ts", title: "Memory leak", description: "Unbounded cache" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection risk", description: "Unsanitized query parameter" }),
        makeFinding({ file: "src/api.ts", title: "Cross-site scripting", description: "Raw HTML in response" }),
        makeFinding({ file: "src/new.ts", title: "Race condition", description: "Concurrent access" }),
      ];

      // LLM matches CUR-1→PREV-1 (same SQL issue), CUR-2→PREV-2 (same XSS), CUR-3→null (new)
      mockSpawnWithStreaming.mockResolvedValue(
        JSON.stringify({
          matches: [
            { current: "CUR-1", previous: "PREV-1" },
            { current: "CUR-2", previous: "PREV-2" },
            { current: "CUR-3", previous: null },
          ],
        }),
      );

      const result = await compareFindings(current, previous, LLM_CONFIG);

      // CUR-1 and CUR-2 matched → persisting with previous IDs
      expect(result.persistingFindings).toHaveLength(2);
      expect(result.persistingFindings[0].id).toBe("r1-f-001");
      expect(result.persistingFindings[0].file).toBe("src/auth.ts");
      expect(result.persistingFindings[1].id).toBe("r1-f-002");
      expect(result.persistingFindings[1].file).toBe("src/api.ts");

      // CUR-3 unmatched → new
      expect(result.newFindings).toHaveLength(1);
      expect(result.newFindings[0].file).toBe("src/new.ts");

      // PREV-3 unmatched → resolved
      expect(result.resolvedFindings).toHaveLength(1);
      expect(result.resolvedFindings[0].id).toBe("r1-f-003");
    });
  });

  describe("assignFindingIds backward compatibility", () => {
    let mockSpawnWithStreaming: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const processModule = await import("../src/process");
      mockSpawnWithStreaming = vi.spyOn(processModule, "spawnWithStreaming") as unknown as ReturnType<typeof vi.fn>;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("assignFindingIds without config uses heuristic", async () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
        makeFinding({ file: "src/new.ts", title: "New bug" }),
      ];

      const result = await assignFindingIds(current, previous, 2);

      expect(result.findings).toHaveLength(2);
      const persisting = result.findings.filter(f => f.status === "persisting");
      const newOnes = result.findings.filter(f => f.status === "new");
      expect(persisting).toHaveLength(1);
      expect(persisting[0].id).toBe("r1-f-001");
      expect(newOnes).toHaveLength(1);
      expect(newOnes[0].id).toBe("r2-f-001");

      // No LLM call should have been made
      expect(mockSpawnWithStreaming).not.toHaveBeenCalled();
    });

    it("heuristic fallback produces identical result to direct heuristic call", async () => {
      const logModule = await import("../src/log");
      vi.spyOn(logModule, "log");

      mockSpawnWithStreaming.mockRejectedValue(new Error("spawn failed"));

      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
        makeFinding({ id: "r1-f-002", file: "src/b.ts", title: "XSS" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
        makeFinding({ file: "src/c.ts", title: "New bug" }),
      ];

      // Get LLM fallback result
      const llmResult = await compareFindings(current, previous, LLM_CONFIG);

      // Get direct heuristic result (no config = heuristic)
      const heuristicResult = await compareFindings(current, previous);

      // Results should be identical
      expect(llmResult.newFindings).toEqual(heuristicResult.newFindings);
      expect(llmResult.persistingFindings).toEqual(heuristicResult.persistingFindings);
      expect(llmResult.resolvedFindings).toEqual(heuristicResult.resolvedFindings);
    });
  });
});
