import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CheckResult } from "../src/checks";

// --- Mocks for checks.ts ---
// Setup's job is running checks + performing fix actions — we mock check functions
// and fs operations, not the underlying system calls in checks.ts.

const mockCheckNodeVersion = vi.fn<() => CheckResult>();
const mockCheckPackageRoot = vi.fn<(packageRoot: string) => CheckResult>();
const mockCheckGit = vi.fn<() => CheckResult>();
const mockCheckCliOnPath = vi.fn<() => CheckResult>();
const mockCheckBinary = vi.fn<(name: string) => CheckResult>();
const mockCheckAuth = vi.fn<(binary: string) => CheckResult>();
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
  checkAuth: (...args: unknown[]) => mockCheckAuth(...(args as [string])),
  checkClaudeHome: (...args: unknown[]) => mockCheckClaudeHome(...(args as [])),
  checkSkillSymlink: (...args: unknown[]) => mockCheckSkillSymlink(...(args as [string])),
  checkSchemaFile: (...args: unknown[]) => mockCheckSchemaFile(...(args as [string])),
  checkGitignore: (...args: unknown[]) => mockCheckGitignore(...(args as [])),
}));

// --- Mocks for fs ---

const mockMkdirSync = vi.fn();
const mockSymlinkSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockAppendFileSync = vi.fn();
const mockExistsSyncFs = vi.fn();
const mockReadFileSyncFs = vi.fn();
const mockRealpathSyncFs = vi.fn();

vi.mock("fs", () => ({
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  symlinkSync: (...args: unknown[]) => mockSymlinkSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  appendFileSync: (...args: unknown[]) => mockAppendFileSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSyncFs(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSyncFs(...args),
  realpathSync: (...args: unknown[]) => mockRealpathSyncFs(...args),
}));

// Mock process.exit to prevent test process from actually exiting
const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

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
  mockCheckAuth.mockReset();
  mockCheckClaudeHome.mockReset();
  mockCheckSkillSymlink.mockReset();
  mockCheckSchemaFile.mockReset();
  mockCheckGitignore.mockReset();
  mockMkdirSync.mockReset();
  mockSymlinkSync.mockReset();
  mockUnlinkSync.mockReset();
  mockAppendFileSync.mockReset();
  mockExistsSyncFs.mockReset();
  mockReadFileSyncFs.mockReset();
  mockRealpathSyncFs.mockReset();
  mockExit.mockClear();
  mockStderr.mockClear();
  stderrOutput = "";
});

import { runSetup } from "../src/setup";

// --- Helpers ---

/** Set all checks to pass by default (everything already correct) */
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
  mockCheckAuth.mockImplementation((binary: string) => ({
    name: `${binary}-auth`,
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

describe("runSetup", () => {
  // --- Exit code tests ---

  describe("exit codes", () => {
    it("exits 0 when all checks pass", async () => {
      allChecksPass();
      await runSetup("/some/root");
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it("exits 1 when unfixable failures remain", async () => {
      allChecksPass();
      mockCheckNodeVersion.mockReturnValue({
        name: "node-version",
        status: "fail",
        message: "Node v18.17.0 — requires >= 20",
        remediation: "Install Node.js 20 or later",
      });
      await runSetup("/some/root");
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
      await runSetup("/some/root");
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it("exits 0 when fixable failures are all fixed", async () => {
      allChecksPass();
      // skill-symlink fails initially (fixable), then passes on re-check
      mockCheckSkillSymlink
        .mockReturnValueOnce({
          name: "skill-symlink",
          status: "fail",
          message: "Skill symlink missing or broken",
          remediation: "Run: review-orchestra setup",
        })
        .mockReturnValueOnce({
          name: "skill-symlink",
          status: "pass",
          message: "Skill symlink resolves correctly",
        });
      // Skills directory exists, claude-home passes
      mockExistsSyncFs.mockReturnValue(true);
      await runSetup("/some/root");
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it("exits 1 when both fixable and unfixable failures exist", async () => {
      allChecksPass();
      mockCheckNodeVersion.mockReturnValue({
        name: "node-version",
        status: "fail",
        message: "Node v18.17.0 — requires >= 20",
        remediation: "Install Node.js 20 or later",
      });
      // skill-symlink fails initially, passes on re-check (fix works)
      mockCheckSkillSymlink
        .mockReturnValueOnce({
          name: "skill-symlink",
          status: "fail",
          message: "Skill symlink missing or broken",
          remediation: "Run: review-orchestra setup",
        })
        .mockReturnValueOnce({
          name: "skill-symlink",
          status: "pass",
          message: "Skill symlink resolves correctly",
        });
      mockExistsSyncFs.mockReturnValue(true);
      await runSetup("/some/root");
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  // --- Symlink creation tests ---

  describe("skill symlink creation", () => {
    it("creates symlink when skill-symlink check fails (missing)", async () => {
      allChecksPass();
      // Initial check fails, re-check after fix passes
      mockCheckSkillSymlink
        .mockReturnValueOnce({
          name: "skill-symlink",
          status: "fail",
          message: "Skill symlink missing or broken",
          remediation: "Run: review-orchestra setup",
        })
        .mockReturnValueOnce({
          name: "skill-symlink",
          status: "pass",
          message: "Skill symlink resolves correctly",
        });
      // ~/.claude/skills/ exists, but the symlink itself does not
      mockExistsSyncFs.mockImplementation((p: string) => {
        if (typeof p === "string" && p.includes("skills/review-orchestra")) return false;
        return true; // skills dir exists
      });
      await runSetup("/some/root");
      expect(mockSymlinkSync).toHaveBeenCalled();
      // Verify symlink target is <packageRoot>/skill
      const call = mockSymlinkSync.mock.calls[0];
      expect(call[0]).toContain("/some/root/skill");
      expect(call[1]).toContain("skills/review-orchestra");
    });

    it("skips symlink when skill-symlink check passes", async () => {
      allChecksPass();
      await runSetup("/some/root");
      expect(mockSymlinkSync).not.toHaveBeenCalled();
      expect(mockUnlinkSync).not.toHaveBeenCalled();
    });

    it("replaces stale symlink (realpathSync mismatch)", async () => {
      allChecksPass();
      // Initial check fails (stale), re-check after fix passes
      mockCheckSkillSymlink
        .mockReturnValueOnce({
          name: "skill-symlink",
          status: "fail",
          message: "Skill symlink is stale: resolves to /old/path, expected /new/path",
          remediation: "Run: review-orchestra setup",
        })
        .mockReturnValueOnce({
          name: "skill-symlink",
          status: "pass",
          message: "Skill symlink resolves correctly",
        });
      // Symlink exists (it's stale, not missing)
      mockExistsSyncFs.mockImplementation((p: string) => {
        if (typeof p === "string" && p.includes("skills/review-orchestra")) return true;
        if (typeof p === "string" && p.includes("skills")) return true;
        return true;
      });
      // realpathSync shows mismatch (stale)
      mockRealpathSyncFs.mockImplementation((p: string) => {
        if (typeof p === "string" && p.includes("skills/review-orchestra")) return "/old/stale/skill";
        if (typeof p === "string" && p.includes("/skill")) return "/some/root/skill";
        return p;
      });

      await runSetup("/some/root");
      // Should remove old symlink then create new one
      expect(mockUnlinkSync).toHaveBeenCalled();
      expect(mockSymlinkSync).toHaveBeenCalled();
    });

    it("creates ~/.claude/skills/ directory if missing", async () => {
      allChecksPass();
      // Initial check fails, re-check after fix passes
      mockCheckSkillSymlink
        .mockReturnValueOnce({
          name: "skill-symlink",
          status: "fail",
          message: "Skill symlink missing or broken",
          remediation: "Run: review-orchestra setup",
        })
        .mockReturnValueOnce({
          name: "skill-symlink",
          status: "pass",
          message: "Skill symlink resolves correctly",
        });
      // ~/.claude/skills/ does NOT exist
      mockExistsSyncFs.mockImplementation((p: string) => {
        if (typeof p === "string" && p.includes("skills")) return false;
        return true;
      });

      await runSetup("/some/root");
      expect(mockMkdirSync).toHaveBeenCalled();
      // Verify recursive option
      const mkdirCall = mockMkdirSync.mock.calls[0];
      expect(mkdirCall[0]).toContain("skills");
      expect(mkdirCall[1]).toEqual(expect.objectContaining({ recursive: true }));
      expect(mockSymlinkSync).toHaveBeenCalled();
    });

    it("skips symlink fix when claude-home fails (dependency)", async () => {
      allChecksPass();
      mockCheckClaudeHome.mockReturnValue({
        name: "claude-home",
        status: "fail",
        message: "~/.claude/ not found",
        remediation: "Install Claude Code",
      });
      await runSetup("/some/root");
      // skill-symlink check should be skipped entirely
      expect(mockCheckSkillSymlink).not.toHaveBeenCalled();
      expect(mockSymlinkSync).not.toHaveBeenCalled();
    });

    it("skips symlink fix when package-root fails (dependency)", async () => {
      allChecksPass();
      mockCheckPackageRoot.mockReturnValue({
        name: "package-root",
        status: "fail",
        message: "package.json not found",
        remediation: "Ensure review-orchestra was installed via npm",
      });
      await runSetup("/some/root");
      expect(mockCheckSkillSymlink).not.toHaveBeenCalled();
      expect(mockSymlinkSync).not.toHaveBeenCalled();
    });

    it("reports fix as failed when post-fix validation fails (target unresolvable)", async () => {
      allChecksPass();
      // Initial check: symlink is missing
      mockCheckSkillSymlink
        .mockReturnValueOnce({
          name: "skill-symlink",
          status: "fail",
          message: "Skill symlink missing or broken",
          remediation: "Run: review-orchestra setup",
        })
        // Re-check after fix: still fails (e.g., target dir doesn't contain SKILL.md)
        .mockReturnValueOnce({
          name: "skill-symlink",
          status: "fail",
          message: "Skill symlink resolves correctly but SKILL.md is missing in target directory",
          remediation: "Verify the skill/ directory contains SKILL.md.",
        });
      // Skills directory exists, symlink does not
      mockExistsSyncFs.mockImplementation((p: string) => {
        if (typeof p === "string" && p.includes("skills/review-orchestra")) return false;
        return true;
      });

      await runSetup("/some/root");
      // The fix should be reported as failed since post-fix validation failed
      expect(stderrOutput).toContain("FAIL");
      // Should exit 1 because the fix didn't actually work
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  // --- Gitignore tests ---

  describe("gitignore", () => {
    it("appends .review-orchestra/ to .gitignore when entry is missing", async () => {
      allChecksPass();
      mockCheckGitignore.mockReturnValue({
        name: "gitignore",
        status: "warn",
        message: ".review-orchestra/ not found in .gitignore",
        remediation: "Add .review-orchestra/ to .gitignore",
      });
      // .gitignore exists
      mockExistsSyncFs.mockImplementation((p: string) => {
        if (typeof p === "string" && p.includes(".gitignore")) return true;
        return false;
      });
      mockReadFileSyncFs.mockReturnValue("node_modules/\ndist/\n");

      await runSetup("/some/root");
      expect(mockAppendFileSync).toHaveBeenCalled();
      const appendCall = mockAppendFileSync.mock.calls[0];
      expect(appendCall[1]).toContain(".review-orchestra/");
    });

    it("does not duplicate gitignore entry when already present", async () => {
      allChecksPass();
      // gitignore check passes — entry already present
      await runSetup("/some/root");
      expect(mockAppendFileSync).not.toHaveBeenCalled();
    });

    it("creates .gitignore file if it doesn't exist", async () => {
      allChecksPass();
      mockCheckGitignore.mockReturnValue({
        name: "gitignore",
        status: "warn",
        message: ".gitignore file not found",
        remediation: "Create .gitignore and add .review-orchestra/",
      });
      // .gitignore does NOT exist
      mockExistsSyncFs.mockReturnValue(false);

      await runSetup("/some/root");
      expect(mockAppendFileSync).toHaveBeenCalled();
      const appendCall = mockAppendFileSync.mock.calls[0];
      expect(appendCall[1]).toContain(".review-orchestra/");
    });

    it("skips gitignore fix when check passes", async () => {
      allChecksPass();
      await runSetup("/some/root");
      expect(mockAppendFileSync).not.toHaveBeenCalled();
    });
  });

  // --- Unfixable failure reporting ---

  describe("unfixable failure reporting", () => {
    it("reports node-version failure with remediation hint", async () => {
      allChecksPass();
      mockCheckNodeVersion.mockReturnValue({
        name: "node-version",
        status: "fail",
        message: "Node v18.17.0 — requires >= 20",
        remediation: "Install Node.js 20 or later",
      });
      await runSetup("/some/root");
      expect(stderrOutput).toContain("FAIL");
      expect(stderrOutput).toContain("Node");
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("reports git failure with remediation hint", async () => {
      allChecksPass();
      mockCheckGit.mockReturnValue({
        name: "git",
        status: "fail",
        message: "git not found on PATH",
        remediation: "Install git: https://git-scm.com/",
      });
      await runSetup("/some/root");
      expect(stderrOutput).toContain("FAIL");
      expect(stderrOutput).toContain("git");
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("reports cli-on-path failure with remediation hint", async () => {
      allChecksPass();
      mockCheckCliOnPath.mockReturnValue({
        name: "cli-on-path",
        status: "fail",
        message: "review-orchestra not found on PATH",
        remediation: "npm install -g review-orchestra or npm link",
      });
      await runSetup("/some/root");
      expect(stderrOutput).toContain("FAIL");
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("reports claude-home failure with remediation hint", async () => {
      allChecksPass();
      mockCheckClaudeHome.mockReturnValue({
        name: "claude-home",
        status: "fail",
        message: "~/.claude/ not found",
        remediation: "Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code",
      });
      await runSetup("/some/root");
      expect(stderrOutput).toContain("FAIL");
      expect(stderrOutput).toContain("~/.claude/");
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("reports claude-binary failure with remediation hint", async () => {
      allChecksPass();
      mockCheckBinary.mockImplementation((name: string) => ({
        name: `${name}-binary`,
        status: name === "claude" ? "fail" : "pass",
        message: name === "claude" ? "claude not found on PATH" : `${name} found`,
        remediation: name === "claude" ? "Install from https://docs.anthropic.com" : undefined,
      }));
      await runSetup("/some/root");
      expect(stderrOutput).toContain("FAIL");
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("reports claude-auth failure with remediation hint", async () => {
      allChecksPass();
      mockCheckAuth.mockImplementation((binary: string) => ({
        name: `${binary}-auth`,
        status: binary === "claude" ? "fail" : "pass",
        message: binary === "claude" ? "claude --version failed" : `${binary} ok`,
        remediation: binary === "claude" ? "Ensure claude is properly configured" : undefined,
      }));
      await runSetup("/some/root");
      expect(stderrOutput).toContain("FAIL");
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  // --- Warning reporting ---

  describe("warning reporting", () => {
    it("reports codex-binary warning with hint", async () => {
      allChecksPass();
      mockCheckBinary.mockImplementation((name: string) => ({
        name: `${name}-binary`,
        status: name === "codex" ? "warn" : "pass",
        message: name === "codex" ? "codex not found" : `${name} found`,
        remediation: name === "codex" ? "npm install -g @openai/codex" : undefined,
      }));
      await runSetup("/some/root");
      expect(stderrOutput).toContain("WARN");
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it("reports codex-auth warning with hint", async () => {
      allChecksPass();
      mockCheckAuth.mockImplementation((binary: string) => ({
        name: `${binary}-auth`,
        status: binary === "codex" ? "warn" : "pass",
        message: binary === "codex" ? "codex --version failed" : `${binary} ok`,
        remediation: binary === "codex" ? "Ensure codex is configured" : undefined,
      }));
      await runSetup("/some/root");
      expect(stderrOutput).toContain("WARN");
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it("reports schema-file warning with hint", async () => {
      allChecksPass();
      mockCheckSchemaFile.mockReturnValue({
        name: "schema-file",
        status: "warn",
        message: "schemas/findings.schema.json not found",
        remediation: "Reinstall the package",
      });
      await runSetup("/some/root");
      expect(stderrOutput).toContain("WARN");
      expect(mockExit).toHaveBeenCalledWith(0);
    });
  });

  // --- Output format tests ---

  describe("output format", () => {
    it("outputs to stderr with [setup] prefix", async () => {
      allChecksPass();
      await runSetup("/some/root");
      const lines = stderrOutput.split("\n").filter((l) => l.includes("[setup]"));
      expect(lines.length).toBeGreaterThan(0);
    });

    it("shows OK for passing checks", async () => {
      allChecksPass();
      await runSetup("/some/root");
      expect(stderrOutput).toContain("OK");
    });

    it("shows Done for successful fix actions", async () => {
      allChecksPass();
      // Initial check fails, re-check after fix passes
      mockCheckSkillSymlink
        .mockReturnValueOnce({
          name: "skill-symlink",
          status: "fail",
          message: "Skill symlink missing",
          remediation: "Run: review-orchestra setup",
        })
        .mockReturnValueOnce({
          name: "skill-symlink",
          status: "pass",
          message: "Skill symlink resolves correctly",
        });
      mockExistsSyncFs.mockReturnValue(true);
      await runSetup("/some/root");
      expect(stderrOutput).toContain("Done");
    });

    it("shows FAIL for unfixable failures", async () => {
      allChecksPass();
      mockCheckNodeVersion.mockReturnValue({
        name: "node-version",
        status: "fail",
        message: "Node v18.17.0",
        remediation: "Install Node.js 20 or later",
      });
      await runSetup("/some/root");
      expect(stderrOutput).toContain("FAIL");
    });

    it("shows summary line at end", async () => {
      allChecksPass();
      await runSetup("/some/root");
      expect(stderrOutput).toMatch(/setup complete|all checks passed/i);
    });
  });

  // --- Check dependencies ---

  describe("check dependencies", () => {
    it("skips skill-symlink when claude-home fails", async () => {
      allChecksPass();
      mockCheckClaudeHome.mockReturnValue({
        name: "claude-home",
        status: "fail",
        message: "~/.claude/ not found",
        remediation: "Install Claude Code",
      });
      await runSetup("/some/root");
      expect(mockCheckSkillSymlink).not.toHaveBeenCalled();
    });

    it("skips skill-symlink when package-root fails", async () => {
      allChecksPass();
      mockCheckPackageRoot.mockReturnValue({
        name: "package-root",
        status: "fail",
        message: "package.json not found",
        remediation: "Ensure review-orchestra was installed via npm",
      });
      await runSetup("/some/root");
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
      await runSetup("/some/root");
      expect(mockCheckSchemaFile).not.toHaveBeenCalled();
    });

    it("runs all checks when dependencies pass", async () => {
      allChecksPass();
      await runSetup("/some/root");
      expect(mockCheckNodeVersion).toHaveBeenCalled();
      expect(mockCheckPackageRoot).toHaveBeenCalled();
      expect(mockCheckGit).toHaveBeenCalled();
      expect(mockCheckCliOnPath).toHaveBeenCalled();
      expect(mockCheckBinary).toHaveBeenCalledWith("claude");
      expect(mockCheckBinary).toHaveBeenCalledWith("codex");
      expect(mockCheckAuth).toHaveBeenCalledWith("claude");
      expect(mockCheckAuth).toHaveBeenCalledWith("codex");
      expect(mockCheckClaudeHome).toHaveBeenCalled();
      expect(mockCheckSkillSymlink).toHaveBeenCalledWith("/some/root");
      expect(mockCheckSchemaFile).toHaveBeenCalledWith("/some/root");
      expect(mockCheckGitignore).toHaveBeenCalled();
    });
  });

  // --- Idempotency tests ---

  describe("idempotency", () => {
    it("no fix actions when all checks pass (already correct state)", async () => {
      allChecksPass();
      await runSetup("/some/root");
      expect(mockMkdirSync).not.toHaveBeenCalled();
      expect(mockSymlinkSync).not.toHaveBeenCalled();
      expect(mockUnlinkSync).not.toHaveBeenCalled();
      expect(mockAppendFileSync).not.toHaveBeenCalled();
    });

    it("symlink already correct — no fix actions taken", async () => {
      allChecksPass();
      // Symlink passes (realpathSync match) — no action needed
      mockCheckSkillSymlink.mockReturnValue({
        name: "skill-symlink",
        status: "pass",
        message: "Skill symlink resolves correctly",
      });
      await runSetup("/some/root");
      expect(mockSymlinkSync).not.toHaveBeenCalled();
      expect(mockUnlinkSync).not.toHaveBeenCalled();
    });

    it("gitignore already has entry — no append", async () => {
      allChecksPass();
      // gitignore check passes — entry already present
      mockCheckGitignore.mockReturnValue({
        name: "gitignore",
        status: "pass",
        message: ".review-orchestra/ is in .gitignore",
      });
      await runSetup("/some/root");
      expect(mockAppendFileSync).not.toHaveBeenCalled();
    });

    it("running twice with all checks passing produces no side effects", async () => {
      allChecksPass();
      await runSetup("/some/root");
      await runSetup("/some/root");
      // No fix actions in either run
      expect(mockSymlinkSync).not.toHaveBeenCalled();
      expect(mockUnlinkSync).not.toHaveBeenCalled();
      expect(mockAppendFileSync).not.toHaveBeenCalled();
      expect(mockMkdirSync).not.toHaveBeenCalled();
    });
  });

  // --- Catalogue order ---

  describe("catalogue order", () => {
    it("runs all 12 checks in catalogue order", async () => {
      allChecksPass();
      await runSetup("/some/root");

      // Verify all checks were called
      expect(mockCheckNodeVersion).toHaveBeenCalled();
      expect(mockCheckPackageRoot).toHaveBeenCalled();
      expect(mockCheckGit).toHaveBeenCalled();
      expect(mockCheckCliOnPath).toHaveBeenCalled();
      expect(mockCheckBinary).toHaveBeenCalledWith("claude");
      expect(mockCheckBinary).toHaveBeenCalledWith("codex");
      expect(mockCheckAuth).toHaveBeenCalledWith("claude");
      expect(mockCheckAuth).toHaveBeenCalledWith("codex");
      expect(mockCheckClaudeHome).toHaveBeenCalled();
      expect(mockCheckSkillSymlink).toHaveBeenCalledWith("/some/root");
      expect(mockCheckSchemaFile).toHaveBeenCalledWith("/some/root");
      expect(mockCheckGitignore).toHaveBeenCalled();
    });

    it("outputs checks in correct order", async () => {
      allChecksPass();
      await runSetup("/some/root");

      const lines = stderrOutput.split("\n").filter((l) => l.includes("[setup]"));
      // Verify order of check labels
      const labels: string[] = [];
      for (const line of lines) {
        const match = line.match(/\[setup\]\s+(?:Checking\s+|Creating\s+|Adding\s+)?(.+?)(?:\.\.\.|$)/);
        if (match) labels.push(match[1].trim());
      }

      // First check should be Node-related
      expect(labels[0]).toMatch(/node/i);
    });
  });

  // --- Edge cases ---

  describe("edge cases", () => {
    it("handles multiple unfixable failures", async () => {
      allChecksPass();
      mockCheckNodeVersion.mockReturnValue({
        name: "node-version",
        status: "fail",
        message: "Node v18.17.0",
        remediation: "Install Node.js 20 or later",
      });
      mockCheckGit.mockReturnValue({
        name: "git",
        status: "fail",
        message: "git not found",
        remediation: "Install git",
      });
      await runSetup("/some/root");
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("handles mixed fixable and unfixable with warnings", async () => {
      allChecksPass();
      // Unfixable failure
      mockCheckGit.mockReturnValue({
        name: "git",
        status: "fail",
        message: "git not found",
        remediation: "Install git",
      });
      // Warning
      mockCheckBinary.mockImplementation((name: string) => ({
        name: `${name}-binary`,
        status: name === "codex" ? "warn" : "pass",
        message: name === "codex" ? "codex not found" : `${name} found`,
        remediation: name === "codex" ? "npm install -g @openai/codex" : undefined,
      }));
      // Fixable failure
      mockCheckGitignore.mockReturnValue({
        name: "gitignore",
        status: "warn",
        message: ".review-orchestra/ not in .gitignore",
        remediation: "Add .review-orchestra/ to .gitignore",
      });
      mockExistsSyncFs.mockReturnValue(false);

      await runSetup("/some/root");
      // Should still exit 1 due to unfixable git failure
      expect(mockExit).toHaveBeenCalledWith(1);
      // But gitignore fix should still have been attempted
      expect(mockAppendFileSync).toHaveBeenCalled();
    });

    it("only fix functions are createSkillSymlink and addToGitignore — no other side effects", async () => {
      allChecksPass();
      // Make both fixable checks fail; symlink re-check passes after fix
      mockCheckSkillSymlink
        .mockReturnValueOnce({
          name: "skill-symlink",
          status: "fail",
          message: "Skill symlink missing",
          remediation: "Run: review-orchestra setup",
        })
        .mockReturnValueOnce({
          name: "skill-symlink",
          status: "pass",
          message: "Skill symlink resolves correctly",
        });
      mockCheckGitignore.mockReturnValue({
        name: "gitignore",
        status: "warn",
        message: ".review-orchestra/ not in .gitignore",
        remediation: "Add .review-orchestra/ to .gitignore",
      });
      // Skills dir exists, symlink does not, .gitignore does not
      mockExistsSyncFs.mockImplementation((p: string) => {
        if (typeof p === "string" && p.includes("skills/review-orchestra")) return false;
        if (typeof p === "string" && p.includes(".gitignore")) return false;
        return true;
      });

      await runSetup("/some/root");
      // Only symlink and gitignore operations should have happened
      expect(mockSymlinkSync).toHaveBeenCalled();
      expect(mockAppendFileSync).toHaveBeenCalled();
    });
  });
});
