import { describe, it, expect, vi, beforeEach } from "vitest";
import { runPreflight } from "../src/preflight";
import { loadConfig } from "../src/config";

const mockExecFile = vi.fn();
vi.mock("child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFile(...args),
}));

beforeEach(() => {
  mockExecFile.mockReset();
});

function mockBinaries(available: string[]) {
  mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
    const binary = args[0];
    if (available.includes(binary)) {
      return `/usr/local/bin/${binary}`;
    }
    throw new Error(`not found: ${binary}`);
  });
}

describe("runPreflight", () => {
  it("passes when all required binaries exist", () => {
    mockBinaries(["claude", "codex", "git"]);
    const config = loadConfig();
    const result = runPreflight(config);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.disabledReviewers).toEqual([]);
  });

  it("warns and disables when claude is missing but codex is available", () => {
    mockBinaries(["codex", "git"]);
    const config = loadConfig();
    const result = runPreflight(config);
    expect(result.ok).toBe(true); // still ok — codex remains
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("claude");
    expect(result.disabledReviewers).toEqual(["claude"]);
  });

  it("warns and disables when codex is missing but claude is available", () => {
    mockBinaries(["claude", "git"]);
    const config = loadConfig();
    const result = runPreflight(config);
    expect(result.ok).toBe(true); // still ok — claude remains
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("codex");
    expect(result.disabledReviewers).toEqual(["codex"]);
  });

  it("fails when ALL reviewers are missing", () => {
    mockBinaries(["git"]);
    const config = loadConfig();
    const result = runPreflight(config);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("No reviewers available");
    expect(result.disabledReviewers).toEqual(["claude", "codex"]);
  });

  it("skips disabled reviewers", () => {
    mockBinaries(["claude", "git"]);
    const config = loadConfig({
      reviewers: { codex: { enabled: false } },
    });
    const result = runPreflight(config);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("fails when git is missing", () => {
    mockBinaries(["claude", "codex"]);
    const config = loadConfig();
    const result = runPreflight(config);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("git"))).toBe(true);
  });

  it("includes install hint for known binaries", () => {
    mockBinaries(["git"]);
    const config = loadConfig();
    const result = runPreflight(config);
    const claudeWarn = result.warnings.find((w) => w.includes("claude"));
    expect(claudeWarn).toContain("docs.anthropic.com");
    const codexWarn = result.warnings.find((w) => w.includes("codex"));
    expect(codexWarn).toContain("npm install");
  });

  it("warns for custom reviewer with unknown binary", () => {
    mockBinaries(["claude", "codex", "git"]);
    const config = loadConfig({
      reviewers: {
        gemini: {
          enabled: true,
          command: "gemini-cli review",
          outputFormat: "json",
        },
      },
    });
    const result = runPreflight(config);
    // claude + codex are fine, gemini is missing — warn but ok
    expect(result.ok).toBe(true);
    expect(result.disabledReviewers).toEqual(["gemini"]);
    expect(result.warnings[0]).toContain("gemini-cli");
  });

  it("fails when no reviewers are enabled at all", () => {
    mockBinaries(["git"]);
    const config = loadConfig({
      reviewers: {
        claude: { enabled: false },
        codex: { enabled: false },
      },
    });
    const result = runPreflight(config);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("No reviewers are enabled");
  });

  it("rejects binary names with shell metacharacters", () => {
    mockExecFile.mockImplementation(() => {
      throw new Error("not found");
    });

    const config = loadConfig({
      reviewers: {
        claude: { enabled: false },
        codex: { enabled: false },
        evil: {
          enabled: true,
          command: "; rm -rf / # review",
          outputFormat: "json",
        },
      },
    });

    const result = runPreflight(config);
    // ";" fails the VALID_BINARY_PATTERN check, gets disabled
    expect(result.disabledReviewers).toContain("evil");
  });
});
