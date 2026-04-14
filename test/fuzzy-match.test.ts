import { describe, it, expect } from "vitest";
import { tokenize, jaccardSimilarity, isFuzzyMatch } from "../src/fuzzy-match";
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
    title: "SQL injection vulnerability",
    description: "Unsanitized input in query",
    suggestion: "Use parameterized queries",
    reviewer: "claude",
    pre_existing: false,
    ...overrides,
  };
}

describe("tokenize", () => {
  it("lowercases all characters", () => {
    const tokens = tokenize("SQL Injection VULNERABILITY");
    expect(tokens).toEqual(new Set(["sql", "injection", "vulnerability"]));
  });

  it("strips punctuation and special characters", () => {
    const tokens = tokenize("don't use eval() here!");
    expect(tokens).toEqual(new Set(["dont", "use", "eval", "here"]));
  });

  it("splits on whitespace", () => {
    const tokens = tokenize("multiple   spaces\ttabs\nnewlines");
    expect(tokens).toEqual(new Set(["multiple", "spaces", "tabs", "newlines"]));
  });

  it("filters tokens with length <= 1", () => {
    const tokens = tokenize("a b c do it x");
    expect(tokens).toEqual(new Set(["do", "it"]));
  });

  it("returns empty set for empty or whitespace-only input", () => {
    expect(tokenize("")).toEqual(new Set());
    expect(tokenize("   ")).toEqual(new Set());
  });

  it("returns empty set when all tokens are single characters", () => {
    expect(tokenize("a b c")).toEqual(new Set());
  });

  it("handles mixed punctuation and short tokens", () => {
    const tokens = tokenize("I'm a SQL-injection bug!");
    // "im" (stripped apostrophe), "sqlinjection" (stripped hyphen), "bug"
    expect(tokens).toEqual(new Set(["im", "sqlinjection", "bug"]));
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1.0 for identical sets", () => {
    const set = new Set(["sql", "injection"]);
    expect(jaccardSimilarity(set, set)).toBe(1.0);
  });

  it("returns 0.0 for completely disjoint sets", () => {
    const a = new Set(["sql", "injection"]);
    const b = new Set(["memory", "leak"]);
    expect(jaccardSimilarity(a, b)).toBe(0.0);
  });

  it("returns correct ratio for partial overlap", () => {
    const a = new Set(["sql", "injection", "vulnerability"]);
    const b = new Set(["sql", "injection", "bug"]);
    // intersection: {sql, injection} = 2, union: {sql, injection, vulnerability, bug} = 4
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5);
  });

  it("returns 0 when both sets are empty", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it("returns 0 when one set is empty", () => {
    const a = new Set(["sql"]);
    expect(jaccardSimilarity(a, new Set())).toBe(0);
    expect(jaccardSimilarity(new Set(), a)).toBe(0);
  });
});

describe("isFuzzyMatch", () => {
  it("returns true for same file + same line + different titles describing same bug", () => {
    const a = makeFinding({
      file: "src/auth.ts",
      line: 42,
      title: "SQL injection vulnerability",
      category: "security",
    });
    const b = makeFinding({
      file: "src/auth.ts",
      line: 42,
      title: "Unsanitized SQL query allows injection",
      category: "input-validation",
    });
    expect(isFuzzyMatch(a, b)).toBe(true);
  });

  it("returns true for same file + lines within 5 + overlapping title tokens", () => {
    const a = makeFinding({
      file: "src/auth.ts",
      line: 42,
      title: "SQL injection in query builder",
      category: "security",
    });
    const b = makeFinding({
      file: "src/auth.ts",
      line: 46,
      title: "Query builder SQL injection risk",
      category: "input-validation",
    });
    expect(isFuzzyMatch(a, b)).toBe(true);
  });

  it("returns true for same file + lines within 3 + same category + some title-token overlap", () => {
    // Lines within 3 + same category is a strong proximity signal, but we
    // also require at least one shared title token so that unrelated bugs
    // in the same region don't collapse together.
    const a = makeFinding({
      file: "src/auth.ts",
      line: 42,
      title: "Hardcoded credentials in source",
      category: "security",
    });
    const b = makeFinding({
      file: "src/auth.ts",
      line: 44,
      title: "Plaintext credentials exposed in logs",
      category: "security",
    });
    expect(isFuzzyMatch(a, b)).toBe(true);
  });

  it("returns false for same file + nearby lines + same broad category but no shared title tokens", () => {
    // Regression for r1-f-014: two unrelated `logic` findings sitting a few
    // lines apart previously merged into one via the category heuristic,
    // silently dropping one of the reports.
    const a = makeFinding({
      file: "src/retry.ts",
      line: 10,
      title: "Missing null check",
      category: "logic",
    });
    const b = makeFinding({
      file: "src/retry.ts",
      line: 12,
      title: "Incorrect retry count",
      category: "logic",
    });
    expect(isFuzzyMatch(a, b)).toBe(false);
  });

  it("returns false for different files", () => {
    const a = makeFinding({
      file: "src/auth.ts",
      line: 42,
      title: "SQL injection vulnerability",
      category: "security",
    });
    const b = makeFinding({
      file: "src/db.ts",
      line: 42,
      title: "SQL injection vulnerability",
      category: "security",
    });
    expect(isFuzzyMatch(a, b)).toBe(false);
  });

  it("returns false for same file but lines > 5 apart", () => {
    const a = makeFinding({
      file: "src/auth.ts",
      line: 42,
      title: "SQL injection vulnerability",
      category: "security",
    });
    const b = makeFinding({
      file: "src/auth.ts",
      line: 48,
      title: "SQL injection vulnerability",
      category: "security",
    });
    expect(isFuzzyMatch(a, b)).toBe(false);
  });

  it("returns false for same file + nearby lines but genuinely different issues (different categories, no token overlap)", () => {
    const a = makeFinding({
      file: "src/auth.ts",
      line: 42,
      title: "SQL injection vulnerability",
      category: "security",
    });
    const b = makeFinding({
      file: "src/auth.ts",
      line: 44,
      title: "Memory leak in connection pool",
      category: "performance",
    });
    expect(isFuzzyMatch(a, b)).toBe(false);
  });

  it("returns true at exact boundary: lines exactly 5 apart with Jaccard > 0.3", () => {
    const a = makeFinding({
      file: "src/auth.ts",
      line: 40,
      title: "SQL injection in database query",
      category: "security",
    });
    const b = makeFinding({
      file: "src/auth.ts",
      line: 45,
      title: "SQL injection found in query",
      category: "input-validation",
    });
    expect(isFuzzyMatch(a, b)).toBe(true);
  });

  it("returns true at exact boundary: lines exactly 3 apart with same category and shared title token", () => {
    const a = makeFinding({
      file: "src/auth.ts",
      line: 40,
      title: "Hardcoded credentials found",
      category: "security",
    });
    const b = makeFinding({
      file: "src/auth.ts",
      line: 43,
      title: "Plaintext credentials exposure",
      category: "security",
    });
    expect(isFuzzyMatch(a, b)).toBe(true);
  });

  it("returns false when lines exactly 4 apart with same category but low token overlap", () => {
    // Lines within 5 (so first condition is met for line proximity)
    // But Jaccard should be <= 0.3, and category matches but distance > 3
    const a = makeFinding({
      file: "src/auth.ts",
      line: 40,
      title: "Hardcoded credentials found",
      category: "security",
    });
    const b = makeFinding({
      file: "src/auth.ts",
      line: 44,
      title: "Plaintext password exposure",
      category: "security",
    });
    // Lines 4 apart: > 3 so category shortcut doesn't apply
    // Jaccard of {hardcoded, credentials, found} vs {plaintext, password, exposure} = 0/6 = 0
    // So overall should be false
    expect(isFuzzyMatch(a, b)).toBe(false);
  });
});
