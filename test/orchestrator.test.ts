import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { Orchestrator, type OrchestratorCallbacks } from "../src/orchestrator";
import { loadConfig } from "../src/config";
import type { DiffScope, Finding, SessionState } from "../src/types";
import { appendFindings, backfillResolved } from "../src/findings-store";

// Mock external dependencies — we don't want to run actual headless CLI processes
vi.mock("../src/reviewers/index", () => ({
  createReviewers: vi.fn(),
}));

// Mock findings-store so we can verify orchestrator calls it correctly
vi.mock("../src/findings-store", () => ({
  appendFindings: vi.fn(),
  backfillResolved: vi.fn(),
}));

// Mock preflight so tests don't require actual claude/codex binaries
vi.mock("../src/preflight", () => ({
  runPreflight: vi.fn(() => ({
    ok: true,
    errors: [],
    warnings: [],
    disabledReviewers: [],
  })),
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
    const newFinding = makeFinding({ id: "new-001", title: "New finding from reviewer-b", reviewer: "reviewer-b", file: "src/api.ts", category: "error-handling" });

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

  it("recovers when remaining reviewers all fail but prior reviews exist", async () => {
    // Crash recovery scenario: reviewer-a finished pre-crash, reviewer-b is
    // re-run and fails. Without the fix, runReviews throws "All reviewers
    // failed" — even though reviewer-a's findings are sitting in saved state.
    const { createReviewers } = await import("../src/reviewers/index");

    const savedFinding = makeFinding({
      id: "saved-001",
      title: "Saved finding from reviewer-a",
      reviewer: "reviewer-a",
    });

    vi.mocked(createReviewers).mockReturnValue([
      {
        name: "reviewer-a",
        review: vi.fn().mockRejectedValue(new Error("should not be called")),
      },
      {
        name: "reviewer-b",
        review: vi.fn().mockRejectedValue(new Error("connection timeout")),
      },
    ]);

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
    // Must not throw — saved reviewer-a findings are sufficient to proceed.
    const result = await orchestrator.run(mockScope);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe("Saved finding from reviewer-a");
    expect(result.reviewerErrors).toHaveLength(1);
    expect(result.reviewerErrors[0]).toEqual({
      reviewer: "reviewer-b",
      error: "connection timeout",
    });
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

  it("preserves reviewer errors from the original run when recovering from consolidation", async () => {
    // Crash recovery from the 'consolidating' phase initialised reviewerErrors
    // to [] regardless of what the original run had observed. If reviewer-b
    // failed in the original run, the recovered ReviewResult would silently
    // claim 0 reviewer errors. Persisted Round.reviewerErrors fixes this.
    const { createReviewers } = await import("../src/reviewers/index");
    const findingA = makeFinding({ id: "saved-001", title: "A finding", reviewer: "reviewer-a" });
    const reviewFn = vi.fn();

    vi.mocked(createReviewers).mockReturnValue([
      { name: "reviewer-a", review: reviewFn },
      { name: "reviewer-b", review: reviewFn },
    ]);

    mkdirSync(TEST_STATE_DIR, { recursive: true });
    const crashedState: SessionState = {
      sessionId: "20260315-160000",
      status: "active",
      currentRound: 1,
      rounds: [
        {
          number: 1,
          phase: "consolidating",
          reviews: {
            "reviewer-a": {
              findings: [findingA],
              metadata: {
                reviewer: "reviewer-a",
                round: 1,
                timestamp: "2026-03-15T16:00:00Z",
                files_reviewed: 1,
                diff_scope: "branch feat/auth vs main",
              },
            },
          },
          // reviewer-b failed in the original run — persisted alongside the
          // round so recovery can surface it instead of pretending it didn't
          // happen.
          reviewerErrors: [{ reviewer: "reviewer-b", error: "spawn EACCES" }],
          consolidated: [],
          worktreeHash: "hash1",
          startedAt: "2026-03-15T16:00:00Z",
          completedAt: null,
        },
      ],
      scope: mockScope,
      worktreeHash: "hash1",
      startedAt: "2026-03-15T16:00:00Z",
      completedAt: null,
    };
    writeFileSync(
      join(TEST_STATE_DIR, "session.json"),
      JSON.stringify(crashedState, null, 2),
    );

    const config = loadConfig({ thresholds: { stopAt: "p1" } });
    const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
    const result = await orchestrator.run(mockScope);
    expect(reviewFn).not.toHaveBeenCalled();
    expect(result.reviewerErrors).toEqual([
      { reviewer: "reviewer-b", error: "spawn EACCES" },
    ]);
  });

  it("resumes from consolidation when recovering from crash during consolidation phase", async () => {
    const { createReviewers } = await import("../src/reviewers/index");

    const findingA = makeFinding({ id: "saved-001", title: "Finding from reviewer-a", reviewer: "reviewer-a" });
    const findingB = makeFinding({ id: "saved-002", title: "Finding from reviewer-b", reviewer: "reviewer-b" });
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

    // Pre-seed session.json with a round in the "consolidating" phase
    // This simulates a crash after all reviewers completed but during consolidation
    mkdirSync(TEST_STATE_DIR, { recursive: true });
    const crashedState: SessionState = {
      sessionId: "20260315-150000",
      status: "active",
      currentRound: 1,
      rounds: [
        {
          number: 1,
          phase: "consolidating",
          reviews: {
            "reviewer-a": {
              findings: [findingA],
              metadata: {
                reviewer: "reviewer-a",
                round: 1,
                timestamp: "2026-03-15T15:00:00Z",
                files_reviewed: 1,
                diff_scope: "branch feat/auth vs main",
              },
            },
            "reviewer-b": {
              findings: [findingB],
              metadata: {
                reviewer: "reviewer-b",
                round: 1,
                timestamp: "2026-03-15T15:00:01Z",
                files_reviewed: 1,
                diff_scope: "branch feat/auth vs main",
              },
            },
          },
          consolidated: [],
          worktreeHash: "hash1",
          startedAt: "2026-03-15T15:00:00Z",
          completedAt: null,
        },
      ],
      scope: mockScope,
      worktreeHash: "hash1",
      startedAt: "2026-03-15T15:00:00Z",
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

    // No reviewers should have been called — they already completed before crash
    expect(reviewFn).not.toHaveBeenCalled();

    // Consolidation should have run with the saved findings
    expect(callbacks.onConsolidated).toHaveBeenCalled();
    expect(callbacks.onComplete).toHaveBeenCalled();

    // Result should contain findings from saved reviews (consolidated)
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.reviewerErrors).toEqual([]);
    expect(result.round).toBe(1);
    expect(result.sessionId).toBe("20260315-150000");
  });

  describe("findings-store integration", () => {
    it("calls appendFindings after finding comparison", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      const finding = makeFinding({ id: "f-001" });
      vi.mocked(createReviewers).mockReturnValue([
        {
          name: "mock-reviewer",
          review: vi.fn().mockResolvedValue({ findings: [finding], rawOutput: "raw" }),
        },
      ]);

      const config = loadConfig({ thresholds: { stopAt: "p1" } });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
      const result = await orchestrator.run(mockScope);

      expect(appendFindings).toHaveBeenCalledTimes(1);
      const call = vi.mocked(appendFindings).mock.calls[0][0];
      expect(call.findings).toEqual(result.findings);
      expect(call.sessionId).toBe(result.sessionId);
      expect(call.round).toBe(1);
      expect(call.project).toBe(process.cwd());
    });

    it("calls backfillResolved when resolvedFindings is non-empty", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      // Round 1: produce a finding; Round 2: no findings → finding becomes resolved
      const finding1 = makeFinding({ id: "f-001", title: "Bug A" });
      const reviewFn = vi.fn()
        .mockResolvedValueOnce({ findings: [finding1], rawOutput: "raw" })
        .mockResolvedValueOnce({ findings: [], rawOutput: "raw" });
      vi.mocked(createReviewers).mockReturnValue([
        { name: "mock-reviewer", review: reviewFn },
      ]);

      const config = loadConfig({
        thresholds: { stopAt: "p1" },
        findingComparison: { method: "heuristic" },
      });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
      await orchestrator.run(mockScope);

      vi.mocked(appendFindings).mockClear();
      vi.mocked(backfillResolved).mockClear();

      const result2 = await orchestrator.run(mockScope);

      expect(result2.round).toBe(2);
      expect(result2.resolvedFindings.length).toBeGreaterThan(0);
      expect(backfillResolved).toHaveBeenCalledTimes(1);
      const call = vi.mocked(backfillResolved).mock.calls[0][0];
      expect(call.resolvedFindings).toEqual(result2.resolvedFindings);
      expect(call.sessionId).toBe(result2.sessionId);
      expect(call.resolvedInRound).toBe(2);
    });

    it("does not call backfillResolved when resolvedFindings is empty", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      vi.mocked(createReviewers).mockReturnValue([
        {
          name: "mock-reviewer",
          review: vi.fn().mockResolvedValue({ findings: [makeFinding()], rawOutput: "raw" }),
        },
      ]);

      const config = loadConfig({ thresholds: { stopAt: "p1" } });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
      const result = await orchestrator.run(mockScope);

      // Round 1: no previous findings, so resolvedFindings is empty
      expect(result.resolvedFindings).toEqual([]);
      expect(backfillResolved).not.toHaveBeenCalled();
    });

    it("storage failure does not crash the review", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      vi.mocked(createReviewers).mockReturnValue([
        {
          name: "mock-reviewer",
          review: vi.fn().mockResolvedValue({ findings: [makeFinding()], rawOutput: "raw" }),
        },
      ]);

      vi.mocked(appendFindings).mockImplementation(() => {
        throw new Error("EACCES: permission denied");
      });

      const config = loadConfig({ thresholds: { stopAt: "p1" } });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
      const result = await orchestrator.run(mockScope);

      // Review should still complete successfully
      expect(result.findings).toHaveLength(1);
      expect(result.round).toBe(1);
    });

    it("does not mark findings as persisted when appendFindings throws (so a retry will retry the write)", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      vi.mocked(createReviewers).mockReturnValue([
        {
          name: "mock-reviewer",
          review: vi.fn().mockResolvedValue({ findings: [makeFinding()], rawOutput: "raw" }),
        },
      ]);

      vi.mocked(appendFindings).mockImplementation(() => {
        throw new Error("EACCES: permission denied");
      });

      const config = loadConfig({ thresholds: { stopAt: "p1" } });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
      await orchestrator.run(mockScope);

      // Read session.json directly to inspect persistence flag
      const sessionRaw = readFileSync(join(TEST_STATE_DIR, "session.json"), "utf-8");
      const session = JSON.parse(sessionRaw);
      const round = session.rounds[session.rounds.length - 1];
      expect(round.findingsPersisted).not.toBe(true);
    });

    it("backfill failure does not crash the review", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      // Round 1: produce a finding; Round 2: no findings → resolvedFindings non-empty
      const reviewFn = vi.fn()
        .mockResolvedValueOnce({ findings: [makeFinding()], rawOutput: "raw" })
        .mockResolvedValueOnce({ findings: [], rawOutput: "raw" });
      vi.mocked(createReviewers).mockReturnValue([
        { name: "mock-reviewer", review: reviewFn },
      ]);

      const config = loadConfig({
        thresholds: { stopAt: "p1" },
        findingComparison: { method: "heuristic" },
      });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
      await orchestrator.run(mockScope);

      vi.mocked(backfillResolved).mockImplementation(() => {
        throw new Error("EACCES: permission denied");
      });

      const result2 = await orchestrator.run(mockScope);

      // Review should still complete successfully
      expect(result2.round).toBe(2);
      expect(result2.resolvedFindings.length).toBeGreaterThan(0);
    });

    it("calls appendFindings in crash recovery path (reviewing)", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      const savedFinding = makeFinding({ id: "saved-001", reviewer: "reviewer-a" });

      vi.mocked(createReviewers).mockReturnValue([
        {
          name: "reviewer-a",
          review: vi.fn().mockRejectedValue(new Error("should not be called")),
        },
        {
          name: "reviewer-b",
          review: vi.fn().mockResolvedValue({
            findings: [makeFinding({ id: "new-001", reviewer: "reviewer-b" })],
            rawOutput: "raw",
          }),
        },
      ]);

      // Pre-seed crashed session state (phase: reviewing, reviewer-a already done)
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

      vi.mocked(appendFindings).mockClear();

      const config = loadConfig({ thresholds: { stopAt: "p1" } });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
      const result = await orchestrator.run(mockScope);

      // appendFindings should have been called even in recovery path
      expect(appendFindings).toHaveBeenCalledTimes(1);
      const call = vi.mocked(appendFindings).mock.calls[0][0];
      expect(call.findings).toEqual(result.findings);
      expect(call.sessionId).toBe("20260315-143022");
      expect(call.round).toBe(1);
    });
  });

  describe("stderr visibility", () => {
    it("logs elapsed summary after consolidation with single reviewer", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      vi.mocked(createReviewers).mockReturnValue([
        {
          name: "claude",
          review: vi.fn().mockResolvedValue({ findings: [], rawOutput: "", elapsedMs: 45200 }),
        },
      ]);

      const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const config = loadConfig({ thresholds: { stopAt: "p1" } });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
      await orchestrator.run(mockScope);

      const stderrMessages = stderrSpy.mock.calls.map(c => c[0]);
      const summaryLine = stderrMessages.find((m: string) =>
        m.includes("review complete (")
      );
      expect(summaryLine).toBeDefined();
      expect(summaryLine).toMatch(/review complete \(claude \d+\.\d+s, consolidation \d+\.\d+s\)/);

      stderrSpy.mockRestore();
    });

    it("logs elapsed summary with multiple reviewers", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      vi.mocked(createReviewers).mockReturnValue([
        {
          name: "claude",
          review: vi.fn().mockResolvedValue({ findings: [makeFinding({ reviewer: "claude" })], rawOutput: "", elapsedMs: 45200 }),
        },
        {
          name: "codex",
          review: vi.fn().mockResolvedValue({ findings: [makeFinding({ id: "f-002", reviewer: "codex" })], rawOutput: "", elapsedMs: 62100 }),
        },
      ]);

      const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const config = loadConfig({ thresholds: { stopAt: "p1" } });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
      await orchestrator.run(mockScope);

      const stderrMessages = stderrSpy.mock.calls.map(c => c[0]);
      const summaryLine = stderrMessages.find((m: string) =>
        m.includes("review complete (")
      );
      expect(summaryLine).toBeDefined();
      expect(summaryLine).toMatch(/review complete \(claude \d+\.\d+s, codex \d+\.\d+s, consolidation \d+\.\d+s\)/);

      stderrSpy.mockRestore();
    });

    it("includes failed reviewer timing in elapsed summary", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      vi.mocked(createReviewers).mockReturnValue([
        {
          name: "claude",
          review: vi.fn().mockResolvedValue({ findings: [makeFinding()], rawOutput: "", elapsedMs: 45200 }),
        },
        {
          name: "codex",
          review: vi.fn().mockRejectedValue(new Error("connection timeout")),
        },
      ]);

      const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const config = loadConfig({ thresholds: { stopAt: "p1" } });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
      await orchestrator.run(mockScope);

      const stderrMessages = stderrSpy.mock.calls.map(c => c[0]);
      const summaryLine = stderrMessages.find((m: string) =>
        m.includes("review complete (")
      );
      expect(summaryLine).toBeDefined();
      // Both reviewers should appear in the summary, even the failed one
      expect(summaryLine).toMatch(/claude \d+\.\d+s/);
      expect(summaryLine).toMatch(/codex \d+\.\d+s/);
      expect(summaryLine).toMatch(/consolidation \d+\.\d+s/);

      // Failed reviewer timing should be per-reviewer (near-instant mock rejection),
      // NOT a misleading global wall-clock fallback. Extract codex timing and verify
      // it's small (the mock rejects immediately, so elapsed should be < 5s).
      const codexMatch = summaryLine!.match(/codex (\d+\.\d+)s/);
      expect(codexMatch).toBeDefined();
      const codexElapsed = parseFloat(codexMatch![1]);
      expect(codexElapsed).toBeLessThan(5);

      stderrSpy.mockRestore();
    });

    it("uses elapsedMs from ReviewerResult when available", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      vi.mocked(createReviewers).mockReturnValue([
        {
          name: "claude",
          review: vi.fn().mockResolvedValue({ findings: [], rawOutput: "", elapsedMs: 45200 }),
        },
      ]);

      const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const config = loadConfig({ thresholds: { stopAt: "p1" } });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
      await orchestrator.run(mockScope);

      const stderrMessages = stderrSpy.mock.calls.map(c => c[0]);
      const summaryLine = stderrMessages.find((m: string) =>
        m.includes("review complete (")
      );
      expect(summaryLine).toBeDefined();
      // elapsedMs of 45200 should produce 45.2s
      expect(summaryLine).toContain("claude 45.2s");

      stderrSpy.mockRestore();
    });

    it("does not emit duplicate onReviewComplete message from callback", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      vi.mocked(createReviewers).mockReturnValue([
        {
          name: "mock-reviewer",
          review: vi.fn().mockResolvedValue({ findings: [makeFinding()], rawOutput: "" }),
        },
      ]);

      const onReviewComplete = vi.fn();
      const callbacks: OrchestratorCallbacks = {
        onReviewComplete,
      };

      const config = loadConfig({ thresholds: { stopAt: "p1" } });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR, callbacks);
      await orchestrator.run(mockScope);

      // The callback is still called (for internal orchestrator use)
      expect(onReviewComplete).toHaveBeenCalledWith("mock-reviewer", expect.any(Array));
    });
  });

  describe("progress.json", () => {
    function readProgress(stateDir: string) {
      const progressPath = join(stateDir, "progress.json");
      if (!existsSync(progressPath)) return null;
      return JSON.parse(readFileSync(progressPath, "utf-8"));
    }

    it("is created when reviewers start", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      let progressDuringReview: unknown = null;
      vi.mocked(createReviewers).mockReturnValue([
        {
          name: "mock-reviewer",
          review: vi.fn().mockImplementation(async () => {
            // Capture progress.json while reviewer is "running"
            progressDuringReview = readProgress(TEST_STATE_DIR);
            return { findings: [], rawOutput: "" };
          }),
        },
      ]);

      const config = loadConfig({ thresholds: { stopAt: "p1" } });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
      await orchestrator.run(mockScope);

      expect(progressDuringReview).not.toBeNull();
      const progress = progressDuringReview as { round: number; startedAt: string; reviewers: Record<string, unknown> };
      expect(progress.round).toBe(1);
      expect(progress.startedAt).toBeTruthy();
      expect(progress.reviewers["mock-reviewer"]).toEqual({
        status: "running",
        findingsCount: null,
        elapsedMs: null,
      });
    });

    it("is updated as each reviewer completes", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      let progressAfterFirst: unknown = null;

      // Use a deferred to control when second reviewer resolves
      let resolveSecond: (val: { findings: Finding[]; rawOutput: string }) => void;
      const secondReviewerPromise = new Promise<{ findings: Finding[]; rawOutput: string }>((resolve) => {
        resolveSecond = resolve;
      });

      vi.mocked(createReviewers).mockReturnValue([
        {
          name: "fast-reviewer",
          review: vi.fn().mockImplementation(async () => {
            return { findings: [makeFinding({ id: "f-001", reviewer: "fast-reviewer" })], rawOutput: "", elapsedMs: 1000 };
          }),
        },
        {
          name: "slow-reviewer",
          review: vi.fn().mockImplementation(async () => {
            // After fast-reviewer completes, capture progress before we resolve
            // Wait a tick so fast-reviewer's progress update is written
            await new Promise((r) => setTimeout(r, 10));
            progressAfterFirst = readProgress(TEST_STATE_DIR);
            resolveSecond!({ findings: [], rawOutput: "" });
            return secondReviewerPromise;
          }),
        },
      ]);

      const config = loadConfig({ thresholds: { stopAt: "p1" } });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
      await orchestrator.run(mockScope);

      // After fast-reviewer completes but before slow-reviewer, progress should show mixed states
      expect(progressAfterFirst).not.toBeNull();
      const progress = progressAfterFirst as { reviewers: Record<string, { status: string; findingsCount: number | null; elapsedMs: number | null }> };
      expect(progress.reviewers["fast-reviewer"].status).toBe("done");
      expect(progress.reviewers["fast-reviewer"].findingsCount).toBe(1);
      expect(progress.reviewers["fast-reviewer"].elapsedMs).toBe(1000);
      expect(progress.reviewers["slow-reviewer"].status).toBe("running");
      expect(progress.reviewers["slow-reviewer"].findingsCount).toBeNull();
    });

    it("is deleted after round completes", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      vi.mocked(createReviewers).mockReturnValue([
        {
          name: "mock-reviewer",
          review: vi.fn().mockResolvedValue({ findings: [], rawOutput: "" }),
        },
      ]);

      const config = loadConfig({ thresholds: { stopAt: "p1" } });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
      await orchestrator.run(mockScope);

      expect(existsSync(join(TEST_STATE_DIR, "progress.json"))).toBe(false);
    });

    it("shows error status for failed reviewer", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      let progressAfterError: unknown = null;

      vi.mocked(createReviewers).mockReturnValue([
        {
          name: "good-reviewer",
          review: vi.fn().mockImplementation(async () => {
            // Wait for bad-reviewer to fail first
            await new Promise((r) => setTimeout(r, 20));
            progressAfterError = readProgress(TEST_STATE_DIR);
            return { findings: [makeFinding()], rawOutput: "" };
          }),
        },
        {
          name: "bad-reviewer",
          review: vi.fn().mockRejectedValue(new Error("connection timeout")),
        },
      ]);

      const config = loadConfig({ thresholds: { stopAt: "p1" } });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
      await orchestrator.run(mockScope);

      expect(progressAfterError).not.toBeNull();
      const progress = progressAfterError as { reviewers: Record<string, { status: string; findingsCount: number | null; elapsedMs: number | null }> };
      expect(progress.reviewers["bad-reviewer"].status).toBe("error");
      expect(progress.reviewers["bad-reviewer"].findingsCount).toBeNull();
      expect(progress.reviewers["bad-reviewer"].elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it("is deleted even if storage fails", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      vi.mocked(createReviewers).mockReturnValue([
        {
          name: "mock-reviewer",
          review: vi.fn().mockResolvedValue({ findings: [makeFinding()], rawOutput: "raw" }),
        },
      ]);

      vi.mocked(appendFindings).mockImplementation(() => {
        throw new Error("EACCES: permission denied");
      });

      const config = loadConfig({ thresholds: { stopAt: "p1" } });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
      const result = await orchestrator.run(mockScope);

      expect(result.findings).toHaveLength(1);
      expect(existsSync(join(TEST_STATE_DIR, "progress.json"))).toBe(false);
    });

    it("schema correctness", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      let capturedProgress: unknown = null;

      vi.mocked(createReviewers).mockReturnValue([
        {
          name: "claude",
          review: vi.fn().mockImplementation(async () => {
            capturedProgress = readProgress(TEST_STATE_DIR);
            return { findings: [makeFinding({ reviewer: "claude" })], rawOutput: "", elapsedMs: 5000 };
          }),
        },
      ]);

      const config = loadConfig({ thresholds: { stopAt: "p1" } });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
      await orchestrator.run(mockScope);

      // Validate the initial progress schema
      const progress = capturedProgress as Record<string, unknown>;
      expect(progress).not.toBeNull();

      // round: number
      expect(typeof progress.round).toBe("number");
      expect(progress.round).toBe(1);

      // startedAt: ISO 8601 string
      expect(typeof progress.startedAt).toBe("string");
      expect(new Date(progress.startedAt as string).toISOString()).toBeTruthy();

      // reviewers: Record<string, ReviewerProgress>
      const reviewers = progress.reviewers as Record<string, Record<string, unknown>>;
      expect(typeof reviewers).toBe("object");
      expect(Object.keys(reviewers)).toEqual(["claude"]);

      const entry = reviewers["claude"];
      expect(["running", "done", "error"]).toContain(entry.status);
      // During review, it should be running
      expect(entry.status).toBe("running");
      expect(entry.findingsCount).toBeNull();
      expect(entry.elapsedMs).toBeNull();
    });

    it("handles single reviewer", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      let progressDuringReview: unknown = null;

      vi.mocked(createReviewers).mockReturnValue([
        {
          name: "solo-reviewer",
          review: vi.fn().mockImplementation(async () => {
            progressDuringReview = readProgress(TEST_STATE_DIR);
            return { findings: [makeFinding({ reviewer: "solo-reviewer" }), makeFinding({ id: "f-002", reviewer: "solo-reviewer" })], rawOutput: "", elapsedMs: 3000 };
          }),
        },
      ]);

      const config = loadConfig({ thresholds: { stopAt: "p1" } });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
      await orchestrator.run(mockScope);

      // During review: single entry, running
      const progress = progressDuringReview as { reviewers: Record<string, { status: string; findingsCount: number | null }> };
      expect(Object.keys(progress.reviewers)).toHaveLength(1);
      expect(progress.reviewers["solo-reviewer"].status).toBe("running");

      // After run: progress.json should be deleted
      expect(existsSync(join(TEST_STATE_DIR, "progress.json"))).toBe(false);
    });

    it("in crash recovery shows remaining reviewers only", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      const savedFinding = makeFinding({ id: "saved-001", reviewer: "reviewer-a" });
      let progressDuringRecovery: unknown = null;

      vi.mocked(createReviewers).mockReturnValue([
        {
          name: "reviewer-a",
          review: vi.fn().mockRejectedValue(new Error("should not be called")),
        },
        {
          name: "reviewer-b",
          review: vi.fn().mockImplementation(async () => {
            progressDuringRecovery = readProgress(TEST_STATE_DIR);
            return { findings: [makeFinding({ id: "new-001", reviewer: "reviewer-b" })], rawOutput: "raw" };
          }),
        },
      ]);

      // Pre-seed crashed session state (phase: reviewing, reviewer-a already done)
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
      await orchestrator.run(mockScope);

      // Progress during recovery should show reviewer-a as done and reviewer-b as running
      const progress = progressDuringRecovery as { reviewers: Record<string, { status: string; findingsCount: number | null }> };
      expect(progress).not.toBeNull();
      expect(progress.reviewers["reviewer-a"]).toBeDefined();
      expect(progress.reviewers["reviewer-a"].status).toBe("done");
      expect(progress.reviewers["reviewer-a"].findingsCount).toBe(1);
      expect(progress.reviewers["reviewer-b"]).toBeDefined();
      expect(progress.reviewers["reviewer-b"].status).toBe("running");
      expect(progress.reviewers["reviewer-b"].findingsCount).toBeNull();

      // After run completes, progress.json should be deleted
      expect(existsSync(join(TEST_STATE_DIR, "progress.json"))).toBe(false);
    });
  });

  describe("all-reviewers-fail (VAL-CROSS-004)", () => {
    function readProgress(stateDir: string) {
      const progressPath = join(stateDir, "progress.json");
      if (!existsSync(progressPath)) return null;
      return JSON.parse(readFileSync(progressPath, "utf-8"));
    }

    it("throws 'All reviewers failed' error, does not call appendFindings, and cleans up progress.json", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      // Mock ALL reviewers to reject
      vi.mocked(createReviewers).mockReturnValue([
        {
          name: "reviewer-a",
          review: vi.fn().mockRejectedValue(new Error("connection timeout")),
        },
        {
          name: "reviewer-b",
          review: vi.fn().mockRejectedValue(new Error("process exited with code 1")),
        },
      ]);

      // Clear any previous appendFindings/backfillResolved calls
      vi.mocked(appendFindings).mockClear();
      vi.mocked(backfillResolved).mockClear();

      const config = loadConfig({ thresholds: { stopAt: "p1" } });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR);

      // 1. The orchestrator throws "All reviewers failed" error
      await expect(orchestrator.run(mockScope)).rejects.toThrow(
        "All reviewers failed"
      );

      // 2. appendFindings is NOT called (we never reach finding comparison)
      expect(appendFindings).not.toHaveBeenCalled();

      // 3. backfillResolved is NOT called either
      expect(backfillResolved).not.toHaveBeenCalled();

      // 4. progress.json is cleaned up (deleted) in the error path
      expect(existsSync(join(TEST_STATE_DIR, "progress.json"))).toBe(false);
    });

    it("shows all reviewers as error in progress.json before cleanup", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      let capturedProgress: unknown = null;

      // Use a deferred so we can capture progress.json state between
      // reviewer failures and the error-path cleanup
      vi.mocked(createReviewers).mockReturnValue([
        {
          name: "reviewer-a",
          review: vi.fn().mockRejectedValue(new Error("timeout")),
        },
        {
          name: "reviewer-b",
          review: vi.fn().mockImplementation(async () => {
            // Wait a tick so reviewer-a's error status is written to progress.json
            await new Promise((r) => setTimeout(r, 10));
            capturedProgress = readProgress(TEST_STATE_DIR);
            throw new Error("also failed");
          }),
        },
      ]);

      const config = loadConfig({ thresholds: { stopAt: "p1" } });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR);

      await expect(orchestrator.run(mockScope)).rejects.toThrow(
        "All reviewers failed"
      );

      // During review (before cleanup), reviewer-a should have been marked as error
      expect(capturedProgress).not.toBeNull();
      const progress = capturedProgress as {
        reviewers: Record<string, { status: string; findingsCount: number | null; elapsedMs: number | null }>;
      };
      expect(progress.reviewers["reviewer-a"].status).toBe("error");
      expect(progress.reviewers["reviewer-a"].findingsCount).toBeNull();
      expect(progress.reviewers["reviewer-a"].elapsedMs).toBeGreaterThanOrEqual(0);

      // After the error propagates, progress.json is cleaned up
      expect(existsSync(join(TEST_STATE_DIR, "progress.json"))).toBe(false);
    });

    it("propagates the error from the orchestrator", async () => {
      const { createReviewers } = await import("../src/reviewers/index");

      // Single reviewer that fails
      vi.mocked(createReviewers).mockReturnValue([
        {
          name: "sole-reviewer",
          review: vi.fn().mockRejectedValue(new Error("API key expired")),
        },
      ]);

      const config = loadConfig({ thresholds: { stopAt: "p1" } });
      const orchestrator = new Orchestrator(config, TEST_STATE_DIR);

      await expect(orchestrator.run(mockScope)).rejects.toThrow(
        "All reviewers failed — cannot determine review status"
      );

      // Verify cleanup
      expect(appendFindings).not.toHaveBeenCalled();
      expect(existsSync(join(TEST_STATE_DIR, "progress.json"))).toBe(false);
    });
  });
});
