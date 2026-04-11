import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { Orchestrator, type OrchestratorCallbacks } from "../src/orchestrator";
import { loadConfig } from "../src/config";
import type { DiffScope, Finding, SessionState } from "../src/types";

// Mock external dependencies — we don't want to run actual headless CLI processes
vi.mock("../src/reviewers/index", () => ({
  createReviewers: vi.fn(),
}));

// Mock fs.readFileSync for the review prompt
vi.mock("fs", async () => {
  const actual = await vi.importActual("fs");
  return {
    ...actual,
    readFileSync: vi.fn((path: string, ...args: unknown[]) => {
      if (typeof path === "string" && path.includes("prompts/review.md")) {
        return "Review this code.";
      }
      return (actual as typeof import("fs")).readFileSync(path, ...args as [BufferEncoding]);
    }),
  };
});

const TEST_STATE_DIR = "/tmp/review-orchestra-test-orchestrator";

const mockScope: DiffScope = {
  type: "branch",
  diff: `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,5 @@
+const x = 1;
+const y = 2;
 export function auth() {}`,
  files: ["src/auth.ts"],
  baseBranch: "main",
  description: "branch feat/auth vs main",
};

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f-001",
    file: "src/auth.ts",
    line: 2,
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

beforeEach(() => {
  if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
  vi.restoreAllMocks();
});

describe("Orchestrator", () => {
  it("runs a single round when reviewers find no issues", async () => {
    const { createReviewers } = await import("../src/reviewers/index");

    vi.mocked(createReviewers).mockReturnValue([
      {
        name: "mock-reviewer",
        review: vi.fn().mockResolvedValue({ findings: [], rawOutput: "" }),
      },
    ]);

    const config = loadConfig({ thresholds: { stopAt: "p1" } });
    const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
    const result = await orchestrator.run(mockScope);

    expect(result.round).toBe(1);
    expect(result.findings).toEqual([]);
    expect(result.reviewerErrors).toEqual([]);
  });

  it("fires callbacks at each phase", async () => {
    const { createReviewers } = await import("../src/reviewers/index");

    vi.mocked(createReviewers).mockReturnValue([
      {
        name: "mock-reviewer",
        review: vi.fn().mockResolvedValue({ findings: [], rawOutput: "" }),
      },
    ]);

    const callbacks: OrchestratorCallbacks = {
      onRoundStart: vi.fn(),
      onReviewComplete: vi.fn(),
      onConsolidated: vi.fn(),
      onComplete: vi.fn(),
    };

    const config = loadConfig({ thresholds: { stopAt: "p1" } });
    const orchestrator = new Orchestrator(config, TEST_STATE_DIR, callbacks);
    await orchestrator.run(mockScope);

    expect(callbacks.onRoundStart).toHaveBeenCalledWith(1);
    expect(callbacks.onReviewComplete).toHaveBeenCalledWith("mock-reviewer", []);
    expect(callbacks.onConsolidated).toHaveBeenCalled();
    expect(callbacks.onComplete).toHaveBeenCalled();
  });

  it("tags pre-existing findings correctly", async () => {
    const { createReviewers } = await import("../src/reviewers/index");

    // Finding at line 100 is outside the hunk (lines 1-5), so it'll be tagged pre-existing
    vi.mocked(createReviewers).mockReturnValue([
      {
        name: "mock-reviewer",
        review: vi.fn().mockResolvedValue({
          findings: [makeFinding({ id: "f-001", line: 100 })],
          rawOutput: "mock raw output",
        }),
      },
    ]);

    const config = loadConfig({ thresholds: { stopAt: "p1" } });
    const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
    const result = await orchestrator.run(mockScope);

    // Pre-existing P0 should be in findings with pre_existing flag
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].pre_existing).toBe(true);
  });

  it("returns ReviewResult with all required fields", async () => {
    const { createReviewers } = await import("../src/reviewers/index");

    vi.mocked(createReviewers).mockReturnValue([
      {
        name: "mock-reviewer",
        review: vi.fn().mockResolvedValue({ findings: [makeFinding()], rawOutput: "mock raw output" }),
      },
    ]);

    const config = loadConfig({ thresholds: { stopAt: "p1" } });
    const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
    const result = await orchestrator.run(mockScope);

    // Verify all 8 ReviewResult fields are present and correct
    expect(result.sessionId).toMatch(/^\d{8}-\d{6}$/); // timestamp ID
    expect(result.round).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.resolvedFindings).toEqual([]);
    expect(result.reviewerErrors).toEqual([]);
    expect(result.worktreeHash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
    expect(result.scope).toEqual(mockScope);
    expect(result.metadata).toBeDefined();
    expect(result.metadata.files_reviewed).toBe(1);
    expect(result.metadata.round).toBe(1);
    expect(result.metadata.reviewer).toBe("mock-reviewer");
    expect(result.metadata.timestamp).toBeTruthy();
    expect(result.metadata.diff_scope).toBe(mockScope.description);
  });

  it("captures reviewer errors in ReviewResult", async () => {
    const { createReviewers } = await import("../src/reviewers/index");

    vi.mocked(createReviewers).mockReturnValue([
      {
        name: "good-reviewer",
        review: vi.fn().mockResolvedValue({ findings: [makeFinding()], rawOutput: "mock raw output" }),
      },
      {
        name: "bad-reviewer",
        review: vi.fn().mockRejectedValue(new Error("connection timeout")),
      },
    ]);

    const config = loadConfig({ thresholds: { stopAt: "p1" } });
    const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
    const result = await orchestrator.run(mockScope);

    expect(result.findings).toHaveLength(1);
    expect(result.reviewerErrors).toHaveLength(1);
    expect(result.reviewerErrors[0]).toEqual({
      reviewer: "bad-reviewer",
      error: "connection timeout",
    });
  });

  it("does not duplicate findings when recovering with some reviewers remaining", async () => {
    const { createReviewers } = await import("../src/reviewers/index");

    const savedFinding = makeFinding({ id: "saved-001", title: "Saved finding from reviewer-a", reviewer: "reviewer-a" });
    const newFinding = makeFinding({ id: "new-001", title: "New finding from reviewer-b", reviewer: "reviewer-b" });

    vi.mocked(createReviewers).mockReturnValue([
      {
        name: "reviewer-a",
        review: vi.fn().mockRejectedValue(new Error("should not be called")),
      },
      {
        name: "reviewer-b",
        review: vi.fn().mockResolvedValue({ findings: [newFinding], rawOutput: "mock raw" }),
      },
    ]);

    // Pre-seed session.json with an incomplete round where only reviewer-a completed
    mkdirSync(TEST_STATE_DIR, { recursive: true });
    const crashedState: SessionState = {
      sessionId: "20260315-143022",
      status: "active",
      currentRound: 1,
      rounds: [
        {
          number: 1,
          phase: "reviewing",
          reviews: {
            "reviewer-a": {
              findings: [savedFinding],
              metadata: {
                reviewer: "reviewer-a",
                round: 1,
                timestamp: "2026-03-15T14:30:22Z",
                files_reviewed: 1,
                diff_scope: "branch feat/auth vs main",
              },
            },
          },
          consolidated: [],
          worktreeHash: "hash1",
          startedAt: "2026-03-15T14:30:22Z",
          completedAt: null,
        },
      ],
      scope: mockScope,
      worktreeHash: "hash1",
      startedAt: "2026-03-15T14:30:22Z",
      completedAt: null,
    };
    writeFileSync(
      join(TEST_STATE_DIR, "session.json"),
      JSON.stringify(crashedState, null, 2),
    );

    const config = loadConfig({ thresholds: { stopAt: "p1" } });
    const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
    const result = await orchestrator.run(mockScope);

    // reviewer-a's finding should appear exactly once
    const reviewerAFindings = result.findings.filter(f => f.reviewer === "reviewer-a");
    expect(reviewerAFindings).toHaveLength(1);

    // reviewer-b's finding should appear exactly once
    const reviewerBFindings = result.findings.filter(f => f.reviewer === "reviewer-b");
    expect(reviewerBFindings).toHaveLength(1);

    // Total findings should be the sum of unique findings from both reviewers
    expect(result.findings).toHaveLength(2);
    expect(result.sessionId).toBe("20260315-143022");
  });

  it("skips to consolidation when recovering with all reviewers already completed", async () => {
    const { createReviewers } = await import("../src/reviewers/index");

    const savedFinding = makeFinding({ id: "saved-001", title: "Saved finding" });
    const reviewFn = vi.fn();

    vi.mocked(createReviewers).mockReturnValue([
      {
        name: "reviewer-a",
        review: reviewFn,
      },
      {
        name: "reviewer-b",
        review: reviewFn,
      },
    ]);

    // Pre-seed session.json with an incomplete round where ALL reviewers completed
    mkdirSync(TEST_STATE_DIR, { recursive: true });
    const crashedState: SessionState = {
      sessionId: "20260315-143022",
      status: "active",
      currentRound: 1,
      rounds: [
        {
          number: 1,
          phase: "reviewing",
          reviews: {
            "reviewer-a": {
              findings: [savedFinding],
              metadata: {
                reviewer: "reviewer-a",
                round: 1,
                timestamp: "2026-03-15T14:30:22Z",
                files_reviewed: 1,
                diff_scope: "branch feat/auth vs main",
              },
            },
            "reviewer-b": {
              findings: [makeFinding({ id: "saved-002", title: "Another finding", reviewer: "reviewer-b" })],
              metadata: {
                reviewer: "reviewer-b",
                round: 1,
                timestamp: "2026-03-15T14:30:23Z",
                files_reviewed: 1,
                diff_scope: "branch feat/auth vs main",
              },
            },
          },
          consolidated: [],
          worktreeHash: "hash1",
          startedAt: "2026-03-15T14:30:22Z",
          completedAt: null,
        },
      ],
      scope: mockScope,
      worktreeHash: "hash1",
      startedAt: "2026-03-15T14:30:22Z",
      completedAt: null,
    };
    writeFileSync(
      join(TEST_STATE_DIR, "session.json"),
      JSON.stringify(crashedState, null, 2),
    );

    const callbacks: OrchestratorCallbacks = {
      onRoundStart: vi.fn(),
      onConsolidated: vi.fn(),
      onComplete: vi.fn(),
    };

    const config = loadConfig({ thresholds: { stopAt: "p1" } });
    const orchestrator = new Orchestrator(config, TEST_STATE_DIR, callbacks);
    const result = await orchestrator.run(mockScope);

    // Reviewers should NOT have been called (all were already completed)
    expect(reviewFn).not.toHaveBeenCalled();

    // Consolidation should have run with the saved findings
    expect(callbacks.onConsolidated).toHaveBeenCalled();
    expect(callbacks.onComplete).toHaveBeenCalled();

    // Result should contain findings from saved reviews (consolidated)
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.reviewerErrors).toEqual([]);
    expect(result.round).toBe(1);
    expect(result.sessionId).toBe("20260315-143022");
  });
});
