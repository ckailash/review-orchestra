import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mock functions (module-scoped, reset in beforeEach) ---

const mockDetectScope = vi.fn();
const mockLoadConfig = vi.fn();
const mockOrchestratorRun = vi.fn();
const mockCheckStale = vi.fn();
const mockRunSetupCmd = vi.fn();
const mockRunDoctorCmd = vi.fn();
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockRmSync = vi.fn();

// --- Module mocks (hoisted by vitest) ---

vi.mock("../src/scope", () => ({
  detectScope: (...args: unknown[]) => mockDetectScope(...args),
}));

vi.mock("../src/config", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

vi.mock("../src/orchestrator", () => ({
  Orchestrator: vi.fn().mockImplementation(() => ({
    run: (...args: unknown[]) => mockOrchestratorRun(...args),
  })),
}));

vi.mock("../src/state", () => ({
  SessionManager: vi.fn(),
}));

vi.mock("../src/worktree-hash", () => ({
  checkStale: (...args: unknown[]) => mockCheckStale(...args),
}));

vi.mock("../src/setup.js", () => ({
  runSetup: (...args: unknown[]) => mockRunSetupCmd(...args),
}));

vi.mock("../src/doctor.js", () => ({
  runDoctor: (...args: unknown[]) => mockRunDoctorCmd(...args),
}));

vi.mock("fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  rmSync: (...args: unknown[]) => mockRmSync(...args),
}));

// --- Spies ---

let mockExit: ReturnType<typeof vi.spyOn>;
let mockConsoleError: ReturnType<typeof vi.spyOn>;
let mockConsoleLog: ReturnType<typeof vi.spyOn>;

const originalArgv = process.argv;

beforeEach(() => {
  vi.resetModules();
  mockDetectScope.mockReset();
  mockLoadConfig.mockReset();
  mockOrchestratorRun.mockReset();
  mockCheckStale.mockReset();
  mockRunSetupCmd.mockReset();
  mockRunDoctorCmd.mockReset();
  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
  mockRmSync.mockReset();

  mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  process.argv = originalArgv;
  mockExit.mockRestore();
  mockConsoleError.mockRestore();
  mockConsoleLog.mockRestore();
});

/**
 * Import cli.ts (triggers main() at module level) and wait for async completion.
 * vi.resetModules() in beforeEach ensures each import gets a fresh module evaluation.
 */
async function runCli(): Promise<void> {
  await import("../src/cli");
  // main() is async but called without await at module level — flush microtask queue
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("cli main()", () => {
  // Shared test fixtures
  const defaultScope = {
    type: "branch",
    diff: "diff --git a/a.ts b/a.ts\n",
    files: ["a.ts"],
    baseBranch: "main",
    description: "branch feat vs main",
  };

  const defaultConfig = {
    reviewers: { claude: { enabled: true } },
    thresholds: { stopAt: "p1" },
  };

  const defaultResult = {
    findings: [],
    resolvedFindings: [],
    round: 1,
    reviewerErrors: [],
    sessionId: "20260412-120000",
    worktreeHash: "abc123",
    scope: defaultScope,
    metadata: {
      files_reviewed: 1,
      round: 1,
      reviewer: "claude",
      timestamp: "2026-04-12",
      diff_scope: "test",
    },
  };

  /** Configure mocks for a successful review path */
  function setupReviewMocks(): void {
    mockLoadConfig.mockReturnValue(defaultConfig);
    mockDetectScope.mockReturnValue(defaultScope);
    mockOrchestratorRun.mockResolvedValue(defaultResult);
  }

  it("review subcommand is recognized and calls orchestrator.run", async () => {
    process.argv = ["node", "cli", "review"];
    setupReviewMocks();

    await runCli();

    expect(mockDetectScope).toHaveBeenCalled();
    expect(mockLoadConfig).toHaveBeenCalled();
    expect(mockOrchestratorRun).toHaveBeenCalledWith(defaultScope);
  });

  it("preserves an argv path token containing a literal double-quote", async () => {
    // Regression for r2-f-005 round-3 follow-up: a path token like
    // src/foo"bar would previously have its embedded quote escaped into
    // the join, then mis-tokenize into multiple tokens. The CLI should
    // pass the path through unchanged to detectScope.
    process.argv = ["node", "cli", "review", 'src/foo"bar/file.ts'];
    setupReviewMocks();

    await runCli();

    const detectArgs = mockDetectScope.mock.calls[0];
    expect(detectArgs[0]).toEqual(['src/foo"bar/file.ts']);
  });

  it("preserves an argv path token containing both whitespace AND a literal double-quote", async () => {
    // The escaping branch — wraps the token in quotes and escapes the
    // embedded quote — must round-trip via the parser without losing the
    // original characters or splitting the token.
    process.argv = ["node", "cli", "review", 'src/My Dir/file"bar.ts'];
    setupReviewMocks();

    await runCli();

    const detectArgs = mockDetectScope.mock.calls[0];
    expect(detectArgs[0]).toEqual(['src/My Dir/file"bar.ts']);
  });

  it("loads the config from disk only once per review (no double cascade read)", async () => {
    process.argv = ["node", "cli", "review", "only", "claude"];
    setupReviewMocks();

    await runCli();

    // Even when overrides are present, the config cascade should be read
    // exactly once — overrides are merged in-memory.
    expect(mockLoadConfig).toHaveBeenCalledTimes(1);
  });

  it("reset subcommand removes .review-orchestra/ when it exists", async () => {
    process.argv = ["node", "cli", "reset"];
    mockExistsSync.mockReturnValue(true);

    await runCli();

    expect(mockRmSync).toHaveBeenCalled();
    const call = mockRmSync.mock.calls[0];
    expect(call[0]).toContain(".review-orchestra");
    expect(call[1]).toEqual({ recursive: true, force: true });
  });

  it("reset subcommand reports nothing when directory is absent", async () => {
    process.argv = ["node", "cli", "reset"];
    mockExistsSync.mockReturnValue(false);

    await runCli();

    expect(mockRmSync).not.toHaveBeenCalled();
    const messages = mockConsoleError.mock.calls.map((c) => c[0]);
    expect(messages.some((m: string) => m.includes("Nothing to reset"))).toBe(true);
  });

  it("stale subcommand calls process.exit with correct code", async () => {
    process.argv = ["node", "cli", "stale"];
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ rounds: [{ worktreeHash: "abc123" }] }),
    );
    mockCheckStale.mockReturnValue(1);

    await runCli();

    expect(mockCheckStale).toHaveBeenCalledWith("abc123");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("stale subcommand handles missing session file", async () => {
    process.argv = ["node", "cli", "stale"];
    mockExistsSync.mockReturnValue(false);
    mockCheckStale.mockReturnValue(2);

    await runCli();

    expect(mockCheckStale).toHaveBeenCalledWith(null);
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it("setup subcommand delegates to runSetupCmd", async () => {
    process.argv = ["node", "cli", "setup"];
    mockRunSetupCmd.mockResolvedValue(undefined);

    await runCli();

    expect(mockRunSetupCmd).toHaveBeenCalled();
    // Verify PACKAGE_ROOT is passed (a string path)
    expect(typeof mockRunSetupCmd.mock.calls[0][0]).toBe("string");
  });

  it("doctor subcommand delegates to runDoctorCmd", async () => {
    process.argv = ["node", "cli", "doctor"];
    mockRunDoctorCmd.mockResolvedValue(undefined);

    await runCli();

    expect(mockRunDoctorCmd).toHaveBeenCalled();
    expect(typeof mockRunDoctorCmd.mock.calls[0][0]).toBe("string");
  });

  it("bare invocation (no subcommand) defaults to review", async () => {
    process.argv = ["node", "cli"];
    setupReviewMocks();

    await runCli();

    expect(mockDetectScope).toHaveBeenCalled();
    expect(mockOrchestratorRun).toHaveBeenCalledWith(defaultScope);
  });

  it("dry-run argument produces dry run JSON output", async () => {
    process.argv = ["node", "cli", "review", "--dry-run"];
    mockLoadConfig.mockReturnValue(defaultConfig);
    mockDetectScope.mockReturnValue(defaultScope);

    await runCli();

    // Orchestrator should NOT be called for dry run
    expect(mockOrchestratorRun).not.toHaveBeenCalled();

    // console.log should have been called with JSON containing dryRun: true
    expect(mockConsoleLog).toHaveBeenCalled();
    const output = mockConsoleLog.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.scope).toBeDefined();
    expect(parsed.config).toBeDefined();
  });

  it("unknown subcommand falls through to review with args", async () => {
    process.argv = ["node", "cli", "src/auth/"];
    setupReviewMocks();

    await runCli();

    // detectScope should have been called with the path parsed from args
    expect(mockDetectScope).toHaveBeenCalledWith(["src/auth/"], undefined);
    expect(mockOrchestratorRun).toHaveBeenCalled();
  });

  it("orchestrator run throwing calls process.exit(1) and stderr includes Fatal", async () => {
    process.argv = ["node", "cli", "review"];
    setupReviewMocks();
    mockOrchestratorRun.mockRejectedValue(new Error("boom"));
    await runCli();
    expect(mockExit).toHaveBeenCalledWith(1);
    // Check that stderr includes "Fatal"
    const messages = mockConsoleError.mock.calls.map((c) => c[0]);
    expect(messages.some((m: string) => m.includes("Fatal"))).toBe(true);
  });

  it("scope detection throwing calls process.exit(1) and stderr message", async () => {
    process.argv = ["node", "cli", "review"];
    mockLoadConfig.mockReturnValue(defaultConfig);
    mockDetectScope.mockImplementation(() => { throw new Error("not a git repo"); });
    // Make process.exit throw to halt execution past the catch block
    mockExit.mockImplementation((() => { throw new Error("exit"); }) as never);
    // Suppress the unhandled rejection from main() that results from the thrown exit
    const rejections: unknown[] = [];
    const handler = (reason: unknown) => { rejections.push(reason); };
    process.on("unhandledRejection", handler);
    await runCli();
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.removeListener("unhandledRejection", handler);
    expect(mockExit).toHaveBeenCalledWith(1);
    const messages = mockConsoleError.mock.calls.map((c) => c[0]);
    expect(messages.some((m: string) => m.includes("not a git repo"))).toBe(true);
  });

  it("stale session JSON parse failure calls checkStale with null", async () => {
    process.argv = ["node", "cli", "stale"];
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("not json");
    mockCheckStale.mockReturnValue(2);
    await runCli();
    expect(mockCheckStale).toHaveBeenCalledWith(null);
  });

  it("stale fresh path (checkStale returns 0) calls process.exit(0) and stderr includes Fresh", async () => {
    process.argv = ["node", "cli", "stale"];
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ rounds: [{ worktreeHash: "abc123" }] }));
    mockCheckStale.mockReturnValue(0);
    await runCli();
    expect(mockExit).toHaveBeenCalledWith(0);
    const messages = mockConsoleError.mock.calls.map((c) => c[0]);
    expect(messages.some((m: string) => m.includes("Fresh"))).toBe(true);
  });
});
