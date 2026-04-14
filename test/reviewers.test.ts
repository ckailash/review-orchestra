import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DiffScope, ReviewerConfig } from "../src/types";

// Mock process (spawnWithStreaming) before importing reviewer modules
vi.mock("../src/process", () => ({
  spawnWithStreaming: vi.fn(),
}));

// Mock fs for CodexReviewer
vi.mock("fs", async () => {
  const actual = await vi.importActual("fs");
  return {
    ...actual,
    readFileSync: vi.fn((path: string, ...args: unknown[]) => {
      // Delegate to actual for non-test paths (e.g., prompts, config)
      if (typeof path === "string" && !path.includes("codex-output-")) {
        return (actual as typeof import("fs")).readFileSync(path, ...args as [BufferEncoding]);
      }
      return "{}";
    }),
    existsSync: vi.fn((path: string) => {
      if (typeof path === "string" && path.includes("codex-output-")) {
        return false;
      }
      return (actual as typeof import("fs")).existsSync(path);
    }),
    unlinkSync: vi.fn(),
    renameSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { spawnWithStreaming } from "../src/process";
import { readFileSync, existsSync, unlinkSync, renameSync } from "fs";
import { parseCommand } from "../src/reviewers/command";
import { ClaudeReviewer } from "../src/reviewers/claude";
import { CodexReviewer } from "../src/reviewers/codex";
import { createReviewers } from "../src/reviewers/index";
import { loadConfig } from "../src/config";

const mockScope: DiffScope = {
  type: "branch",
  diff: "diff --git a/src/foo.ts b/src/foo.ts\n+const x = 1;",
  files: ["src/foo.ts"],
  baseBranch: "main",
  description: "branch feat/foo vs main",
};

const validFindingsJson = JSON.stringify({
  findings: [
    {
      id: "f-001",
      file: "src/foo.ts",
      line: 1,
      confidence: "verified",
      impact: "critical",
      severity: "p0",
      category: "security",
      title: "Test finding",
      description: "A test finding",
      suggestion: "Fix it",
      reviewer: "test",
      pre_existing: false,
    },
  ],
});

beforeEach(() => {
  vi.restoreAllMocks();
  // Suppress log output
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── parseCommand ─────────────────────────────────────────────────────────────

describe("parseCommand", () => {
  it("parses a simple command", () => {
    const result = parseCommand("claude -p");
    expect(result).toEqual({ bin: "claude", args: ["-p"] });
  });

  it("strips quotes from quoted args", () => {
    const result = parseCommand('claude --allowedTools "Read,Grep"');
    expect(result).toEqual({ bin: "claude", args: ["--allowedTools", "Read,Grep"] });
  });

  it("handles empty string", () => {
    const result = parseCommand("");
    expect(result).toEqual({ bin: "", args: [] });
  });
});

// ─── ClaudeReviewer ───────────────────────────────────────────────────────────

describe("ClaudeReviewer", () => {
  const claudeConfig: ReviewerConfig = {
    enabled: true,
    command: 'claude -p --output-format json',
    outputFormat: "json",
  };

  it("strips CLAUDECODE env var", async () => {
    process.env.CLAUDECODE = "1";

    vi.mocked(spawnWithStreaming).mockResolvedValue(validFindingsJson);

    const reviewer = new ClaudeReviewer(claudeConfig, "/tmp/test-state");
    await reviewer.review("review this", mockScope, { roundNumber: 1 });

    const spawnCall = vi.mocked(spawnWithStreaming).mock.calls[0][0];
    expect(spawnCall.env).toBeDefined();
    expect(spawnCall.env!.CLAUDECODE).toBeUndefined();

    delete process.env.CLAUDECODE;
  });

  it("adds --model flag when configured", async () => {
    vi.mocked(spawnWithStreaming).mockResolvedValue(validFindingsJson);

    const reviewer = new ClaudeReviewer({
      ...claudeConfig,
      model: "claude-sonnet-4-20250514",
    }, "/tmp/test-state");
    await reviewer.review("review this", mockScope, { roundNumber: 1 });

    const spawnCall = vi.mocked(spawnWithStreaming).mock.calls[0][0];
    expect(spawnCall.args).toContain("--model");
    expect(spawnCall.args).toContain("claude-sonnet-4-20250514");
  });

  it("calculates scaled inactivity timeout", async () => {
    vi.mocked(spawnWithStreaming).mockResolvedValue(validFindingsJson);

    const reviewer = new ClaudeReviewer(claudeConfig, "/tmp/test-state");
    const bigScope: DiffScope = {
      ...mockScope,
      files: Array.from({ length: 100 }, (_, i) => `src/file${i}.ts`),
    };
    await reviewer.review("review this", bigScope, { roundNumber: 1 });

    const spawnCall = vi.mocked(spawnWithStreaming).mock.calls[0][0];
    const expected = Math.max(10 * 60 * 1000, 100 * 30 * 1000); // 3000000
    expect(spawnCall.inactivityTimeout).toBe(expected);
  });
});

// ─── CodexReviewer ────────────────────────────────────────────────────────────

describe("CodexReviewer", () => {
  const codexConfig: ReviewerConfig = {
    enabled: true,
    command: "codex --output-file {outputFile}",
    outputFormat: "json",
  };

  it("reads output from file when it exists", async () => {
    vi.mocked(spawnWithStreaming).mockResolvedValue("stdout content");
    vi.mocked(existsSync).mockImplementation((path: string) => {
      if (typeof path === "string" && path.includes("codex-output-")) return true;
      const actual = vi.importActual("fs") as typeof import("fs");
      return actual.existsSync(path);
    });
    vi.mocked(readFileSync).mockImplementation((path: string, ...args: unknown[]) => {
      if (typeof path === "string" && path.includes("codex-output-")) {
        return validFindingsJson;
      }
      const actual = vi.importActual("fs") as typeof import("fs");
      return actual.readFileSync(path, ...args as [BufferEncoding]);
    });

    const reviewer = new CodexReviewer(codexConfig, "/tmp/test-state");
    const result = await reviewer.review("review this", mockScope, { roundNumber: 1 });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe("Test finding");
    // rawOutput should come from the file, not stdout
    expect(result.rawOutput).toBe(validFindingsJson);
  });

  it("falls back to stdout when no output file", async () => {
    vi.mocked(spawnWithStreaming).mockResolvedValue(validFindingsJson);
    vi.mocked(existsSync).mockImplementation((path: string) => {
      if (typeof path === "string" && path.includes("codex-output-")) return false;
      const actual = vi.importActual("fs") as typeof import("fs");
      return actual.existsSync(path);
    });

    const reviewer = new CodexReviewer(codexConfig, "/tmp/test-state");
    const result = await reviewer.review("review this", mockScope, { roundNumber: 1 });

    expect(result.findings).toHaveLength(1);
    expect(result.rawOutput).toBe(validFindingsJson);
  });

  it("preserves the output file as <name>.failed when codex fails (don't destroy debug evidence)", async () => {
    vi.mocked(spawnWithStreaming).mockRejectedValue(new Error("spawn failed"));
    vi.mocked(existsSync).mockImplementation((path: string) => {
      if (typeof path === "string" && path.includes("codex-output-")) return true;
      const actual = vi.importActual("fs") as typeof import("fs");
      return actual.existsSync(path);
    });

    const reviewer = new CodexReviewer(codexConfig, "/tmp/test-state");
    await expect(reviewer.review("review this", mockScope, { roundNumber: 1 })).rejects.toThrow(
      "Codex reviewer failed"
    );

    // On failure: renamed to .failed for debugging, NOT unlinked.
    expect(unlinkSync).not.toHaveBeenCalled();
    expect(renameSync).toHaveBeenCalled();
    const [from, to] = vi.mocked(renameSync).mock.calls[0] as [string, string];
    expect(from).toContain("codex-output-");
    expect(to).toBe(from + ".failed");
  });

  it("removes the output file on success (no longer needed once parsed)", async () => {
    vi.mocked(spawnWithStreaming).mockResolvedValue("stdout content");
    vi.mocked(existsSync).mockImplementation((path: string) => {
      if (typeof path === "string" && path.includes("codex-output-")) return true;
      const actual = vi.importActual("fs") as typeof import("fs");
      return actual.existsSync(path);
    });
    vi.mocked(readFileSync).mockImplementation((path: string, ...args: unknown[]) => {
      if (typeof path === "string" && path.includes("codex-output-")) {
        return validFindingsJson;
      }
      const actual = vi.importActual("fs") as typeof import("fs");
      return actual.readFileSync(path, ...args as [BufferEncoding]);
    });

    const reviewer = new CodexReviewer(codexConfig, "/tmp/test-state");
    await reviewer.review("review this", mockScope, { roundNumber: 1 });

    expect(unlinkSync).toHaveBeenCalled();
    const unlinkPath = vi.mocked(unlinkSync).mock.calls[0][0] as string;
    expect(unlinkPath).toContain("codex-output-");
  });
});

// ─── createReviewers ──────────────────────────────────────────────────────────

describe("createReviewers", () => {
  it("only creates enabled reviewers", () => {
    const config = loadConfig({
      reviewers: {
        claude: { enabled: true },
        codex: { enabled: false },
      },
    });

    const reviewers = createReviewers(config, "/tmp/test-state");

    expect(reviewers).toHaveLength(1);
    expect(reviewers[0].name).toBe("claude");
  });

  it("creates GenericReviewer for unknown names", () => {
    const config = loadConfig({
      reviewers: {
        claude: { enabled: false },
        codex: { enabled: false },
        gemini: { enabled: true, command: "gemini review" },
      },
    });

    const reviewers = createReviewers(config, "/tmp/test-state");

    expect(reviewers).toHaveLength(1);
    expect(reviewers[0].name).toBe("gemini");
  });
});

// ─── GenericReviewer ──────────────────────────────────────────────────────────

describe("GenericReviewer", () => {
  it("sends prompt via stdin when no {prompt} placeholder", async () => {
    vi.mocked(spawnWithStreaming).mockResolvedValue(validFindingsJson);

    const config = loadConfig({
      reviewers: {
        claude: { enabled: false },
        codex: { enabled: false },
        custom: { enabled: true, command: "my-reviewer --json" },
      },
    });

    const reviewers = createReviewers(config, "/tmp/test-state");
    expect(reviewers).toHaveLength(1);

    await reviewers[0].review("review prompt", mockScope, { roundNumber: 1 });

    const spawnCall = vi.mocked(spawnWithStreaming).mock.calls[0][0];
    expect(spawnCall.input).toBeDefined();
    expect(spawnCall.input).toContain("review prompt");
  });

  it("strips nested-session env vars (CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_SSE_PORT)", async () => {
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    process.env.CLAUDE_CODE_SSE_PORT = "12345";

    vi.mocked(spawnWithStreaming).mockResolvedValue(validFindingsJson);

    const config = loadConfig({
      reviewers: {
        claude: { enabled: false },
        codex: { enabled: false },
        custom: { enabled: true, command: "my-reviewer --json" },
      },
    });

    const reviewers = createReviewers(config, "/tmp/test-state");
    await reviewers[0].review("review prompt", mockScope, { roundNumber: 1 });

    const spawnCall = vi.mocked(spawnWithStreaming).mock.calls[0][0];
    expect(spawnCall.env).toBeDefined();
    expect(spawnCall.env!.CLAUDECODE).toBeUndefined();
    expect(spawnCall.env!.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(spawnCall.env!.CLAUDE_CODE_SSE_PORT).toBeUndefined();

    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_CODE_SSE_PORT;
  });

  it("substitutes {prompt} in args when placeholder exists", async () => {
    vi.mocked(spawnWithStreaming).mockResolvedValue(validFindingsJson);

    const config = loadConfig({
      reviewers: {
        claude: { enabled: false },
        codex: { enabled: false },
        custom: { enabled: true, command: "my-reviewer --prompt {prompt} --json" },
      },
    });

    const reviewers = createReviewers(config, "/tmp/test-state");
    expect(reviewers).toHaveLength(1);

    await reviewers[0].review("review prompt", mockScope, { roundNumber: 1 });

    const spawnCall = vi.mocked(spawnWithStreaming).mock.calls[0][0];
    // When {prompt} is in args, input should be undefined
    expect(spawnCall.input).toBeUndefined();
    // One of the args should contain the expanded prompt text
    const hasPromptArg = spawnCall.args.some((a: string) => a.includes("review prompt"));
    expect(hasPromptArg).toBe(true);
    // {prompt} placeholder should be replaced, not present in args
    const hasPlaceholder = spawnCall.args.some((a: string) => a.includes("{prompt}"));
    expect(hasPlaceholder).toBe(false);
  });
});
