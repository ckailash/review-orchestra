import { describe, it, expect } from "vitest";
import {
  compareFindings,
  assignFindingIds,
} from "../src/finding-comparison";
import type { Finding } from "../src/types";

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

describe("finding comparison", () => {
  describe("compareFindings", () => {
    it("tags all findings as new on first round (no previous findings)", () => {
      const current = [
        makeFinding({ file: "src/a.ts", title: "Bug A" }),
        makeFinding({ file: "src/b.ts", title: "Bug B" }),
      ];

      const result = compareFindings(current, []);

      expect(result.newFindings).toHaveLength(2);
      expect(result.persistingFindings).toHaveLength(0);
      expect(result.resolvedFindings).toHaveLength(0);
    });

    it("identifies persisting findings by file + title.toLowerCase()", () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
      ];

      const result = compareFindings(current, previous);

      expect(result.newFindings).toHaveLength(0);
      expect(result.persistingFindings).toHaveLength(1);
      expect(result.resolvedFindings).toHaveLength(0);
    });

    it("uses case-insensitive title matching", () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL Injection" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "sql injection" }),
      ];

      const result = compareFindings(current, previous);

      expect(result.newFindings).toHaveLength(0);
      expect(result.persistingFindings).toHaveLength(1);
      // Persisting finding should keep the original ID
      expect(result.persistingFindings[0].id).toBe("r1-f-001");
    });

    it("identifies resolved findings (in previous but not current)", () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
        makeFinding({ id: "r1-f-002", file: "src/b.ts", title: "XSS vulnerability" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
      ];

      const result = compareFindings(current, previous);

      expect(result.persistingFindings).toHaveLength(1);
      expect(result.resolvedFindings).toHaveLength(1);
      expect(result.resolvedFindings[0].id).toBe("r1-f-002");
      expect(result.resolvedFindings[0].title).toBe("XSS vulnerability");
    });

    it("identifies new findings (in current but not previous)", () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
        makeFinding({ file: "src/new.ts", title: "New bug" }),
      ];

      const result = compareFindings(current, previous);

      expect(result.newFindings).toHaveLength(1);
      expect(result.newFindings[0].file).toBe("src/new.ts");
      expect(result.persistingFindings).toHaveLength(1);
      expect(result.resolvedFindings).toHaveLength(0);
    });

    it("requires exact file match (different files are different findings)", () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
      ];
      const current = [
        makeFinding({ file: "src/other.ts", title: "SQL injection" }),
      ];

      const result = compareFindings(current, previous);

      expect(result.newFindings).toHaveLength(1);
      expect(result.persistingFindings).toHaveLength(0);
      expect(result.resolvedFindings).toHaveLength(1);
    });

    it("handles mixed new, persisting, and resolved findings", () => {
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

      const result = compareFindings(current, previous);

      expect(result.newFindings).toHaveLength(2);
      expect(result.persistingFindings).toHaveLength(1);
      expect(result.persistingFindings[0].id).toBe("r1-f-001");
      expect(result.resolvedFindings).toHaveLength(2);
      expect(result.resolvedFindings.map(f => f.id).sort()).toEqual(["r1-f-002", "r1-f-003"]);
    });

    it("treats findings at different lines as same when file + title match", () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", line: 10, title: "Null check missing" }),
        makeFinding({ id: "r1-f-002", file: "src/auth.ts", line: 50, title: "Null check missing" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", line: 10, title: "Null check missing" }),
        makeFinding({ file: "src/auth.ts", line: 50, title: "Null check missing" }),
      ];

      const result = compareFindings(current, previous);

      // With file + title key (no line), both previous entries map to the same key.
      // The Map keeps the last one (r1-f-002). Both current entries also map to the
      // same key and both match against the Map entry, so both become persisting
      // with the same preserved ID.
      expect(result.persistingFindings).toHaveLength(2);
      expect(result.persistingFindings.every(f => f.id === "r1-f-002")).toBe(true);
      expect(result.newFindings).toHaveLength(0);
      expect(result.resolvedFindings).toHaveLength(0);
    });

    it("matches findings with same file, line, and title (exact match)", () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", line: 42, title: "SQL injection" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", line: 42, title: "SQL injection" }),
      ];

      const result = compareFindings(current, previous);

      expect(result.persistingFindings).toHaveLength(1);
      expect(result.persistingFindings[0].id).toBe("r1-f-001");
      expect(result.newFindings).toHaveLength(0);
      expect(result.resolvedFindings).toHaveLength(0);
    });

    it("returns resolved findings as-is from previous round", () => {
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

      const result = compareFindings(current, previous);

      expect(result.resolvedFindings).toHaveLength(1);
      expect(result.resolvedFindings[0]).toEqual(previous[0]);
    });
  });

  describe("assignFindingIds", () => {
    it("assigns round-scoped IDs to new findings in rN-f-NNN format", () => {
      const newFindings = [
        makeFinding({ file: "src/a.ts", title: "Bug A" }),
        makeFinding({ file: "src/b.ts", title: "Bug B" }),
        makeFinding({ file: "src/c.ts", title: "Bug C" }),
      ];

      const result = assignFindingIds(newFindings, [], 1);

      expect(result.findings[0].id).toBe("r1-f-001");
      expect(result.findings[1].id).toBe("r1-f-002");
      expect(result.findings[2].id).toBe("r1-f-003");
    });

    it("assigns status 'new' to new findings", () => {
      const newFindings = [
        makeFinding({ file: "src/a.ts", title: "Bug A" }),
      ];

      const result = assignFindingIds(newFindings, [], 1);

      expect(result.findings[0].status).toBe("new");
    });

    it("assigns status 'persisting' to persisting findings", () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
      ];

      const result = assignFindingIds(current, previous, 2);

      expect(result.findings[0].status).toBe("persisting");
      expect(result.findings[0].id).toBe("r1-f-001");
    });

    it("preserves original ID for persisting findings across rounds", () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection", status: "new" }),
        makeFinding({ id: "r1-f-002", file: "src/b.ts", title: "XSS", status: "new" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
        makeFinding({ file: "src/b.ts", title: "XSS" }),
        makeFinding({ file: "src/c.ts", title: "New Bug" }),
      ];

      const result = assignFindingIds(current, previous, 2);

      const persisting = result.findings.filter(f => f.status === "persisting");
      const newOnes = result.findings.filter(f => f.status === "new");

      expect(persisting).toHaveLength(2);
      expect(persisting.find(f => f.title === "SQL injection")?.id).toBe("r1-f-001");
      expect(persisting.find(f => f.title === "XSS")?.id).toBe("r1-f-002");
      expect(newOnes).toHaveLength(1);
      expect(newOnes[0].id).toBe("r2-f-001");
    });

    it("zero-pads the sequential number to 3 digits", () => {
      const findings = Array.from({ length: 12 }, (_, i) =>
        makeFinding({ file: `src/f${i}.ts`, title: `Bug ${i}` })
      );

      const result = assignFindingIds(findings, [], 1);

      expect(result.findings[0].id).toBe("r1-f-001");
      expect(result.findings[9].id).toBe("r1-f-010");
      expect(result.findings[11].id).toBe("r1-f-012");
    });

    it("returns resolved findings in separate array", () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/auth.ts", title: "SQL injection" }),
        makeFinding({ id: "r1-f-002", file: "src/old.ts", title: "Old bug" }),
      ];
      const current = [
        makeFinding({ file: "src/auth.ts", title: "SQL injection" }),
      ];

      const result = assignFindingIds(current, previous, 2);

      expect(result.findings).toHaveLength(1);
      expect(result.resolvedFindings).toHaveLength(1);
      expect(result.resolvedFindings[0].id).toBe("r1-f-002");
    });

    it("first round: all findings are new with r1-f-NNN IDs", () => {
      const findings = [
        makeFinding({ file: "src/a.ts", title: "Bug A" }),
        makeFinding({ file: "src/b.ts", title: "Bug B" }),
        makeFinding({ file: "src/c.ts", title: "Bug C" }),
      ];

      const result = assignFindingIds(findings, [], 1);

      expect(result.findings).toHaveLength(3);
      expect(result.resolvedFindings).toHaveLength(0);
      expect(result.findings.every(f => f.status === "new")).toBe(true);
      expect(result.findings[0].id).toBe("r1-f-001");
      expect(result.findings[1].id).toBe("r1-f-002");
      expect(result.findings[2].id).toBe("r1-f-003");
    });

    it("handles empty current findings (all resolved)", () => {
      const previous = [
        makeFinding({ id: "r1-f-001", file: "src/a.ts", title: "Bug A" }),
      ];

      const result = assignFindingIds([], previous, 2);

      expect(result.findings).toHaveLength(0);
      expect(result.resolvedFindings).toHaveLength(1);
    });

    it("handles both empty current and previous findings", () => {
      const result = assignFindingIds([], [], 1);

      expect(result.findings).toHaveLength(0);
      expect(result.resolvedFindings).toHaveLength(0);
    });
  });
});
