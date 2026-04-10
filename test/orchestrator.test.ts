import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "fs";
import { Orchestrator, type OrchestratorCallbacks } from "../src/orchestrator";
import { loadConfig } from "../src/config";
import type { DiffScope, Finding } from "../src/types";

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
        review: vi.fn().mockResolvedValue([]),
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
        review: vi.fn().mockResolvedValue([]),
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
        review: vi.fn().mockResolvedValue([
          makeFinding({ id: "f-001", line: 100 }),
        ]),
      },
    ]);

    const config = loadConfig({ thresholds: { stopAt: "p1" } });
    const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
    const result = await orchestrator.run(mockScope);

    // Pre-existing P0 should be in findings with pre_existing flag
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].pre_existing).toBe(true);
  });

  it("returns ReviewResult with consolidated findings", async () => {
    const { createReviewers } = await import("../src/reviewers/index");

    vi.mocked(createReviewers).mockReturnValue([
      {
        name: "mock-reviewer",
        review: vi.fn().mockResolvedValue([makeFinding()]),
      },
    ]);

    const config = loadConfig({ thresholds: { stopAt: "p1" } });
    const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
    const result = await orchestrator.run(mockScope);

    expect(result.round).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.resolvedFindings).toEqual([]);
    expect(result.reviewerErrors).toEqual([]);
    expect(result.scope).toEqual(mockScope);
    expect(result.metadata).toBeDefined();
    expect(result.metadata.files_reviewed).toBe(1);
  });

  it("captures reviewer errors in ReviewResult", async () => {
    const { createReviewers } = await import("../src/reviewers/index");

    vi.mocked(createReviewers).mockReturnValue([
      {
        name: "good-reviewer",
        review: vi.fn().mockResolvedValue([makeFinding()]),
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
});
