import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CheckResult } from "../src/checks";

// --- Mocks for checks.ts ---
// Doctor's job is formatting and exit code logic — we mock check functions,
// not the underlying system calls.

const mockCheckNodeVersion = vi.fn<() => CheckResult>();
const mockCheckPackageRoot = vi.fn<(packageRoot: string) => CheckResult>();
const mockCheckGit = vi.fn<() => CheckResult>();
const mockCheckCliOnPath = vi.fn<() => CheckResult>();
const mockCheckBinary = vi.fn<(name: string) => CheckResult>();
const mockCheckBinaryHealth = vi.fn<(binary: string) => CheckResult>();
const mockCheckClaudeHome = vi.fn<() => CheckResult>();
const mockCheckSkillSymlink = vi.fn<(packageRoot: string) => CheckResult>();
const mockCheckSchemaFile = vi.fn<(packageRoot: string) => CheckResult>();
const mockCheckGitignore = vi.fn<() => CheckResult>();

vi.mock("../src/checks", () => ({
  checkNodeVersion: (...args: unknown[]) => mockCheckNodeVersion(...(args as [])),
  checkPackageRoot: (...args: unknown[]) => mockCheckPackageRoot(...(args as [string])),
  checkGit: (...args: unknown[]) => mockCheckGit(...(args as [])),
  checkCliOnPath: (...args: unknown[]) => mockCheckCliOnPath(...(args as [])),
  checkBinary: (...args: unknown[]) => mockCheckBinary(...(args as [string])),
  checkBinaryHealth: (...args: unknown[]) => mockCheckBinaryHealth(...(args as [string])),
  checkClaudeHome: (...args: unknown[]) => mockCheckClaudeHome(...(args as [])),
  checkSkillSymlink: (...args: unknown[]) => mockCheckSkillSymlink(...(args as [string])),
  checkSchemaFile: (...args: unknown[]) => mockCheckSchemaFile(...(args as [string])),
  checkGitignore: (...args: unknown[]) => mockCheckGitignore(...(args as [])),
}));

// Mock process.exit — created in beforeEach, restored in afterEach
let mockExit: ReturnType<typeof vi.spyOn>;

// Capture stderr output
let stderrOutput: string;
const mockStderr = vi
  .spyOn(process.stderr, "write")
  .mockImplementation((chunk: string | Uint8Array) => {
    stderrOutput += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  });

beforeEach(() => {
  mockCheckNodeVersion.mockReset();
  mockCheckPackageRoot.mockReset();
  mockCheckGit.mockReset();
  mockCheckCliOnPath.mockReset();
  mockCheckBinary.mockReset();
  mockCheckBinaryHealth.mockReset();
  mockCheckClaudeHome.mockReset();
  mockCheckSkillSymlink.mockReset();
  mockCheckSchemaFile.mockReset();
  mockCheckGitignore.mockReset();
  mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  mockStderr.mockClear();
  stderrOutput = "";
});

afterEach(() => {
  mockExit.mockRestore();
});

import { runDoctor } from "../src/doctor";

// --- Helpers ---

/** Set all checks to pass by default */
function allChecksPass(): void {
  mockCheckNodeVersion.mockReturnValue({
    name: "node-version",
    status: "pass",
    message: "Node v22.3.0",
  });
  mockCheckPackageRoot.mockReturnValue({
    name: "package-root",
    status: "pass",
    message: "package.json found at /some/root",
  });
  mockCheckGit.mockReturnValue({
    name: "git",
    status: "pass",
    message: "git found on PATH",
  });
  mockCheckCliOnPath.mockReturnValue({
    name: "cli-on-path",
    status: "pass",
    message: "review-orchestra found on PATH",
  });
  mockCheckBinary.mockImplementation((name: string) => ({
    name: `${name}-binary`,
    status: "pass",
    message: `${name} found on PATH`,
  }));
  mockCheckBinaryHealth.mockImplementation((binary: string) => ({
    name: `${binary}-health`,
    status: "pass",
    message: `${binary} --version succeeded`,
  }));
  mockCheckClaudeHome.mockReturnValue({
    name: "claude-home",
    status: "pass",
    message: "~/.claude/ exists",
  });
  mockCheckSkillSymlink.mockReturnValue({
    name: "skill-symlink",
    status: "pass",
    message: "Skill symlink resolves correctly",
  });
  mockCheckSchemaFile.mockReturnValue({
    name: "schema-file",
    status: "pass",
    message: "findings.schema.json found",
  });
  mockCheckGitignore.mockReturnValue({
    name: "gitignore",
    status: "pass",
    message: ".review-orchestra/ is in .gitignore",
  });
}

// --- Tests ---

describe("runDoctor", () => {
  // --- Exit code tests ---

  describe("exit codes", () => {
    it("exits 0 when all checks pass", async () => {
      allChecksPass();
      await runDoctor("/some/root");
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it("exits 1 when any check fails", async () => {
      allChecksPass();
      mockCheckGit.mockReturnValue({
        name: "git",
        status: "fail",
        message: "git not found on PATH",
        remediation: "Install git",
      });
      await runDoctor("/some/root");
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("exits 0 when there are only warnings (no failures)", async () => {
      allChecksPass();
      mockCheckBinary.mockImplementation((name: string) => ({
        name: `${name}-binary`,
        status: name === "codex" ? "warn" : "pass",
        message: name === "codex" ? "codex not found" : `${name} found`,
        remediation: name === "codex" ? "Install codex" : undefined,
      }));
      await runDoctor("/some/root");
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it("exits 1 when there are both failures and warnings", async () => {
      allChecksPass();
      mockCheckGit.mockReturnValue({
        name: "git",
        status: "fail",
        message: "git not found",
        remediation: "Install git",
      });
      mockCheckBinary.mockImplementation((name: string) => ({
        name: `${name}-binary`,
        status: name === "codex" ? "warn" : "pass",
        message: name === "codex" ? "codex not found" : `${name} found`,
        remediation: name === "codex" ? "Install codex" : undefined,
      }));
      await runDoctor("/some/root");
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  // --- Output format tests ---

  describe("output format", () => {
    it("outputs to stderr with [doctor] prefix for each check", async () => {
      allChecksPass();
      await runDoctor("/some/root");
      // Each line should have [doctor] prefix
      const lines = stderrOutput.split("\n").filter((l) => l.trim());
      const doctorLines = lines.filter((l) => l.includes("[doctor]"));
      // Should have lines for all 12 checks
      expect(doctorLines.length).toBeGreaterThanOrEqual(12);
    });

    it("shows PASS for passing checks", async () => {
      allChecksPass();
      await runDoctor("/some/root");
      expect(stderrOutput).toContain("PASS");
    });

    it("shows FAIL for failing checks", async () => {
      allChecksPass();
      mockCheckGit.mockReturnValue({
        name: "git",
        status: "fail",
        message: "git not found on PATH",
        remediation: "Install git: https://git-scm.com/",
      });
      await runDoctor("/some/root");
      expect(stderrOutput).toContain("FAIL");
    });

    it("shows WARN for warning checks", async () => {
      allChecksPass();
      mockCheckBinary.mockImplementation((name: string) => ({
        name: `${name}-binary`,
        status: name === "codex" ? "warn" : "pass",
        message: name === "codex" ? "codex not found" : `${name} found`,
        remediation: name === "codex" ? "npm install -g @openai/codex" : undefined,
      }));
      await runDoctor("/some/root");
      expect(stderrOutput).toContain("WARN");
    });

    it("shows remediation hint for failures", async () => {
      allChecksPass();
      mockCheckGit.mockReturnValue({
        name: "git",
        status: "fail",
        message: "git not found on PATH",
        remediation: "Install git: https://git-scm.com/",
      });
      await runDoctor("/some/root");
      expect(stderrOutput).toContain("Fix:");
      expect(stderrOutput).toContain("Install git");
    });

    it("shows remediation hint for warnings", async () => {
      allChecksPass();
      mockCheckBinary.mockImplementation((name: string) => ({
        name: `${name}-binary`,
        status: name === "codex" ? "warn" : "pass",
        message: name === "codex" ? "codex not found" : `${name} found`,
        remediation: name === "codex" ? "npm install -g @openai/codex" : undefined,
      }));
      await runDoctor("/some/root");
      expect(stderrOutput).toContain("Fix:");
      expect(stderrOutput).toContain("npm install");
    });

    it("does not show remediation for passing checks", async () => {
      allChecksPass();
      await runDoctor("/some/root");
      expect(stderrOutput).not.toContain("Fix:");
    });
  });

  // --- Summary line tests ---

  describe("summary line", () => {
    it("shows all-pass message when everything passes", async () => {
      allChecksPass();
      await runDoctor("/some/root");
      expect(stderrOutput).toContain("All checks passed");
    });

    it("counts failures in summary line", async () => {
      allChecksPass();
      mockCheckGit.mockReturnValue({
        name: "git",
        status: "fail",
        message: "git not found",
        remediation: "Install git",
      });
      mockCheckClaudeHome.mockReturnValue({
        name: "claude-home",
        status: "fail",
        message: "~/.claude/ not found",
        remediation: "Install Claude Code",
      });
      await runDoctor("/some/root");
      expect(stderrOutput).toMatch(/2 failure/i);
    });

    it("counts warnings in summary line", async () => {
      allChecksPass();
      mockCheckBinary.mockImplementation((name: string) => ({
        name: `${name}-binary`,
        status: name === "codex" ? "warn" : "pass",
        message: name === "codex" ? "codex not found" : `${name} found`,
        remediation: name === "codex" ? "Install codex" : undefined,
      }));
      await runDoctor("/some/root");
      expect(stderrOutput).toMatch(/1 warning/i);
    });

    it("counts both failures and warnings in summary", async () => {
      allChecksPass();
      mockCheckGit.mockReturnValue({
        name: "git",
        status: "fail",
        message: "git not found",
        remediation: "Install git",
      });
      mockCheckBinary.mockImplementation((name: string) => ({
        name: `${name}-binary`,
        status: name === "codex" ? "warn" : "pass",
        message: name === "codex" ? "codex not found" : `${name} found`,
        remediation: name === "codex" ? "Install codex" : undefined,
      }));
      await runDoctor("/some/root");
      expect(stderrOutput).toMatch(/1 failure/i);
      expect(stderrOutput).toMatch(/1 warning/i);
    });

    it("suggests running setup when there are failures", async () => {
      allChecksPass();
      mockCheckGit.mockReturnValue({
        name: "git",
        status: "fail",
        message: "git not found",
        remediation: "Install git",
      });
      await runDoctor("/some/root");
      expect(stderrOutput).toContain("review-orchestra setup");
    });

    it("uses correct plural form for 1 failure", async () => {
      allChecksPass();
      mockCheckGit.mockReturnValue({
        name: "git",
        status: "fail",
        message: "git not found",
        remediation: "Install git",
      });
      await runDoctor("/some/root");
      expect(stderrOutput).toMatch(/1 failure[^s]/);
    });

    it("uses correct plural form for multiple failures", async () => {
      allChecksPass();
      mockCheckGit.mockReturnValue({
        name: "git",
        status: "fail",
        message: "git not found",
        remediation: "Install git",
      });
      mockCheckCliOnPath.mockReturnValue({
        name: "cli-on-path",
        status: "fail",
        message: "not found",
        remediation: "npm install -g review-orchestra",
      });
      await runDoctor("/some/root");
      expect(stderrOutput).toMatch(/2 failures/);
    });
  });

  // --- Dependency skipping tests ---

  describe("check dependencies", () => {
    it("skips skill-symlink when claude-home fails", async () => {
      allChecksPass();
      mockCheckClaudeHome.mockReturnValue({
        name: "claude-home",
        status: "fail",
        message: "~/.claude/ not found",
        remediation: "Install Claude Code",
      });
      await runDoctor("/some/root");
      // skill-symlink should NOT have been called
      expect(mockCheckSkillSymlink).not.toHaveBeenCalled();
      // Output should indicate it was skipped
      expect(stderrOutput).toMatch(/skill.?symlink/i);
      expect(stderrOutput).toMatch(/skip/i);
    });

    it("skips skill-symlink when package-root fails", async () => {
      allChecksPass();
      mockCheckPackageRoot.mockReturnValue({
        name: "package-root",
        status: "fail",
        message: "package.json not found",
        remediation: "Ensure review-orchestra was installed via npm",
      });
      await runDoctor("/some/root");
      expect(mockCheckSkillSymlink).not.toHaveBeenCalled();
    });

    it("skips schema-file when package-root fails", async () => {
      allChecksPass();
      mockCheckPackageRoot.mockReturnValue({
        name: "package-root",
        status: "fail",
        message: "package.json not found",
        remediation: "Ensure review-orchestra was installed via npm",
      });
      await runDoctor("/some/root");
      expect(mockCheckSchemaFile).not.toHaveBeenCalled();
    });

    it("runs skill-symlink and schema-file when both package-root and claude-home pass", async () => {
      allChecksPass();
      await runDoctor("/some/root");
      expect(mockCheckSkillSymlink).toHaveBeenCalled();
      expect(mockCheckSchemaFile).toHaveBeenCalled();
    });

    it("still runs other checks when package-root fails", async () => {
      allChecksPass();
      mockCheckPackageRoot.mockReturnValue({
        name: "package-root",
        status: "fail",
        message: "package.json not found",
        remediation: "Ensure review-orchestra was installed via npm",
      });
      await runDoctor("/some/root");
      // These should still run
      expect(mockCheckNodeVersion).toHaveBeenCalled();
      expect(mockCheckGit).toHaveBeenCalled();
      expect(mockCheckCliOnPath).toHaveBeenCalled();
      expect(mockCheckBinary).toHaveBeenCalled();
      expect(mockCheckBinaryHealth).toHaveBeenCalled();
      expect(mockCheckClaudeHome).toHaveBeenCalled();
      expect(mockCheckGitignore).toHaveBeenCalled();
    });

    it("shows SKIP in output for skipped checks", async () => {
      allChecksPass();
      mockCheckClaudeHome.mockReturnValue({
        name: "claude-home",
        status: "fail",
        message: "~/.claude/ not found",
        remediation: "Install Claude Code",
      });
      await runDoctor("/some/root");
      expect(stderrOutput).toContain("SKIP");
    });

    it("does not count skipped checks as failures", async () => {
      allChecksPass();
      // Only claude-home fails — skill-symlink is skipped, not failed
      mockCheckClaudeHome.mockReturnValue({
        name: "claude-home",
        status: "fail",
        message: "~/.claude/ not found",
        remediation: "Install Claude Code",
      });
      await runDoctor("/some/root");
      // Should count exactly 1 failure (claude-home), not 2
      expect(stderrOutput).toMatch(/1 failure[^s]/);
    });
  });

  // --- Catalogue order tests ---

  describe("catalogue order", () => {
    it("runs all 12 checks in catalogue order", async () => {
      allChecksPass();
      await runDoctor("/some/root");

      // Verify all checks were called
      expect(mockCheckNodeVersion).toHaveBeenCalled();
      expect(mockCheckPackageRoot).toHaveBeenCalled();
      expect(mockCheckGit).toHaveBeenCalled();
      expect(mockCheckCliOnPath).toHaveBeenCalled();
      expect(mockCheckBinary).toHaveBeenCalledWith("claude");
      expect(mockCheckBinary).toHaveBeenCalledWith("codex");
      expect(mockCheckBinaryHealth).toHaveBeenCalledWith("claude");
      expect(mockCheckBinaryHealth).toHaveBeenCalledWith("codex");
      expect(mockCheckClaudeHome).toHaveBeenCalled();
      expect(mockCheckSkillSymlink).toHaveBeenCalledWith("/some/root");
      expect(mockCheckSchemaFile).toHaveBeenCalledWith("/some/root");
      expect(mockCheckGitignore).toHaveBeenCalled();
    });

    it("outputs checks in correct order", async () => {
      allChecksPass();
      await runDoctor("/some/root");

      const lines = stderrOutput.split("\n").filter((l) => l.includes("[doctor]"));
      const checkNames = lines.map((l) => {
        // Extract the check name between [doctor] and the colon
        const match = l.match(/\[doctor\]\s+(.+?):\s/);
        return match ? match[1] : l;
      });

      // Verify order matches catalogue
      const expectedOrder = [
        "Node version",
        "Package root",
        "git",
        "review-orchestra on PATH",
        "claude binary",
        "codex binary",
        "claude health",
        "codex health",
        "~/.claude/",
        "Skill symlink",
        "Schema file",
        ".gitignore",
      ];

      expect(checkNames).toEqual(expectedOrder);
    });
  });

  // --- Edge cases ---

  describe("edge cases", () => {
    it("handles multiple failures across different checks", async () => {
      allChecksPass();
      mockCheckNodeVersion.mockReturnValue({
        name: "node-version",
        status: "fail",
        message: "Node v18.17.0 — requires >= 20",
        remediation: "Install Node.js 20 or later",
      });
      mockCheckGit.mockReturnValue({
        name: "git",
        status: "fail",
        message: "git not found",
        remediation: "Install git",
      });
      mockCheckCliOnPath.mockReturnValue({
        name: "cli-on-path",
        status: "fail",
        message: "not found",
        remediation: "npm install -g review-orchestra",
      });
      await runDoctor("/some/root");
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(stderrOutput).toMatch(/3 failures/);
    });

    it("handles all checks failing", async () => {
      // Set every check to fail
      mockCheckNodeVersion.mockReturnValue({
        name: "node-version",
        status: "fail",
        message: "fail",
        remediation: "fix",
      });
      mockCheckPackageRoot.mockReturnValue({
        name: "package-root",
        status: "fail",
        message: "fail",
        remediation: "fix",
      });
      mockCheckGit.mockReturnValue({
        name: "git",
        status: "fail",
        message: "fail",
        remediation: "fix",
      });
      mockCheckCliOnPath.mockReturnValue({
        name: "cli-on-path",
        status: "fail",
        message: "fail",
        remediation: "fix",
      });
      mockCheckBinary.mockReturnValue({
        name: "binary",
        status: "fail",
        message: "fail",
        remediation: "fix",
      });
      mockCheckBinaryHealth.mockReturnValue({
        name: "health",
        status: "fail",
        message: "fail",
        remediation: "fix",
      });
      mockCheckClaudeHome.mockReturnValue({
        name: "claude-home",
        status: "fail",
        message: "fail",
        remediation: "fix",
      });
      mockCheckGitignore.mockReturnValue({
        name: "gitignore",
        status: "fail",
        message: "fail",
        remediation: "fix",
      });
      await runDoctor("/some/root");
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("includes check message in output", async () => {
      allChecksPass();
      mockCheckNodeVersion.mockReturnValue({
        name: "node-version",
        status: "pass",
        message: "Node v22.3.0",
      });
      await runDoctor("/some/root");
      expect(stderrOutput).toContain("v22.3.0");
    });
  });
});
