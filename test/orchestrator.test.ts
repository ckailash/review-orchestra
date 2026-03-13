import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "fs";
import { Orchestrator, type OrchestratorCallbacks } from "../src/orchestrator";
import { loadConfig } from "../src/config";
import type { DiffScope, Finding } from "../src/types";

// Mock external dependencies — we don't want to run actual headless CLI processes
vi.mock("../src/reviewers/index", () => ({
  createReviewers: vi.fn(),
}));

vi.mock("../src/fixer", () => ({
  runFixer: vi.fn(),
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
    const { runFixer } = await import("../src/fixer");

    vi.mocked(createReviewers).mockReturnValue([
      {
        name: "mock-reviewer",
        review: vi.fn().mockResolvedValue([]),
      },
    ]);

    const config = loadConfig({ thresholds: { maxRounds: 3, stopAt: "p1" } });
    const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
    const summary = await orchestrator.run(mockScope);

    expect(summary.totalRounds).toBe(1);
    expect(summary.remainingFindings).toEqual([]);
    expect(summary.suggestedAction).toBe("Ready to create PR or push");
    expect(runFixer).not.toHaveBeenCalled();
  });

  it("runs fixer when P0 findings exist and loops", async () => {
    const { createReviewers } = await import("../src/reviewers/index");
    const { runFixer } = await import("../src/fixer");

    let callCount = 0;
    vi.mocked(createReviewers).mockReturnValue([
      {
        name: "mock-reviewer",
        review: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return [makeFinding({ id: "f-001" })];
          }
          return []; // Fixed in second round
        }),
      },
    ]);

    vi.mocked(runFixer).mockResolvedValue({
      fixed: ["f-001"],
      skipped: [],
      escalated: [],
    });

    const config = loadConfig({ thresholds: { maxRounds: 5, stopAt: "p1" } });
    const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
    const summary = await orchestrator.run(mockScope);

    expect(summary.totalRounds).toBe(2);
    expect(runFixer).toHaveBeenCalledTimes(1);
    expect(summary.fixedFindings).toBe(1);
  });

  it("respects maxRounds limit", async () => {
    const { createReviewers } = await import("../src/reviewers/index");
    const { runFixer } = await import("../src/fixer");

    // Always returns a P0 finding — loop should stop at maxRounds
    vi.mocked(createReviewers).mockReturnValue([
      {
        name: "mock-reviewer",
        review: vi.fn().mockResolvedValue([makeFinding()]),
      },
    ]);

    vi.mocked(runFixer).mockResolvedValue({
      fixed: [],
      skipped: ["f-001"],
      escalated: [],
    });

    const config = loadConfig({ thresholds: { maxRounds: 2, stopAt: "p1" } });
    const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
    const summary = await orchestrator.run(mockScope);

    expect(summary.totalRounds).toBe(2);
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

    const config = loadConfig({ thresholds: { maxRounds: 1, stopAt: "p1" } });
    const orchestrator = new Orchestrator(config, TEST_STATE_DIR, callbacks);
    await orchestrator.run(mockScope);

    expect(callbacks.onRoundStart).toHaveBeenCalledWith(1);
    expect(callbacks.onReviewComplete).toHaveBeenCalledWith("mock-reviewer", []);
    expect(callbacks.onConsolidated).toHaveBeenCalled();
    expect(callbacks.onComplete).toHaveBeenCalled();
  });

  it("does not fix pre-existing findings", async () => {
    const { createReviewers } = await import("../src/reviewers/index");
    const { runFixer } = await import("../src/fixer");

    // Finding at line 100 is outside the hunk (lines 1-5), so it'll be tagged pre-existing
    vi.mocked(createReviewers).mockReturnValue([
      {
        name: "mock-reviewer",
        review: vi.fn().mockResolvedValue([
          makeFinding({ id: "f-001", line: 100 }),
        ]),
      },
    ]);

    const config = loadConfig({ thresholds: { maxRounds: 3, stopAt: "p1" } });
    const orchestrator = new Orchestrator(config, TEST_STATE_DIR);
    const summary = await orchestrator.run(mockScope);

    // Pre-existing P0 should NOT trigger the fixer
    expect(summary.totalRounds).toBe(1);
    expect(summary.preExistingFindings).toHaveLength(1);
    expect(runFixer).not.toHaveBeenCalled();
  });

  it("calls onEscalation when fixer escalates findings", async () => {
    const { createReviewers } = await import("../src/reviewers/index");
    const { runFixer } = await import("../src/fixer");

    let callCount = 0;
    vi.mocked(createReviewers).mockReturnValue([
      {
        name: "mock-reviewer",
        review: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) return [makeFinding()];
          return [];
        }),
      },
    ]);

    vi.mocked(runFixer).mockResolvedValue({
      fixed: [],
      skipped: [],
      escalated: [
        {
          findingId: "f-001",
          reason: "Needs architectural decision",
          options: ["Option A", "Option B"],
        },
      ],
    });

    const onEscalation = vi.fn().mockResolvedValue(undefined);
    const config = loadConfig({ thresholds: { maxRounds: 3, stopAt: "p1" } });
    const orchestrator = new Orchestrator(config, TEST_STATE_DIR, {
      onEscalation,
    });
    await orchestrator.run(mockScope);

    expect(onEscalation).toHaveBeenCalledWith([
      expect.objectContaining({ findingId: "f-001" }),
    ]);
  });
});
