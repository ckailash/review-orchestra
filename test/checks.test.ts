import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks ---

const mockExecFileSync = vi.fn();
vi.mock("child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockRealpathSync = vi.fn();
vi.mock("fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  realpathSync: (...args: unknown[]) => mockRealpathSync(...args),
}));

beforeEach(() => {
  mockExecFileSync.mockReset();
  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
  mockRealpathSync.mockReset();
});

// We need to import after mocks are set up
import {
  binaryExists,
  VALID_BINARY_PATTERN,
  checkNodeVersion,
  checkPackageRoot,
  checkGit,
  checkCliOnPath,
  checkBinary,
  checkBinaryHealth,
  checkClaudeHome,
  checkSkillSymlink,
  checkSchemaFile,
  checkGitignore,
} from "../src/checks";


// --- Helpers ---

function mockWhich(available: string[]) {
  mockExecFileSync.mockImplementation(
    (cmd: string, args: string[], _opts?: unknown) => {
      if (cmd === "which") {
        const binary = args[0];
        if (available.includes(binary)) {
          return Buffer.from(`/usr/local/bin/${binary}\n`);
        }
        throw new Error(`not found: ${binary}`);
      }
      throw new Error(`unexpected command: ${cmd}`);
    }
  );
}

// --- VALID_BINARY_PATTERN ---

describe("VALID_BINARY_PATTERN", () => {
  it("accepts simple binary names", () => {
    expect(VALID_BINARY_PATTERN.test("claude")).toBe(true);
    expect(VALID_BINARY_PATTERN.test("git")).toBe(true);
    expect(VALID_BINARY_PATTERN.test("review-orchestra")).toBe(true);
  });

  it("accepts paths with slashes", () => {
    expect(VALID_BINARY_PATTERN.test("/usr/local/bin/claude")).toBe(true);
  });

  it("accepts names with dots and underscores", () => {
    expect(VALID_BINARY_PATTERN.test("my_binary.sh")).toBe(true);
  });

  it("rejects shell metacharacters", () => {
    expect(VALID_BINARY_PATTERN.test("; rm -rf /")).toBe(false);
    expect(VALID_BINARY_PATTERN.test("$(evil)")).toBe(false);
    expect(VALID_BINARY_PATTERN.test("binary | pipe")).toBe(false);
    expect(VALID_BINARY_PATTERN.test("cmd && other")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(VALID_BINARY_PATTERN.test("")).toBe(false);
  });
});

// --- binaryExists ---

describe("binaryExists", () => {
  it("returns true when binary is found on PATH", () => {
    mockWhich(["claude"]);
    expect(binaryExists("claude")).toBe(true);
  });

  it("returns false when binary is not found on PATH", () => {
    mockWhich([]);
    expect(binaryExists("claude")).toBe(false);
  });

  it("returns false for binary names with shell metacharacters", () => {
    mockWhich([]);
    expect(binaryExists("; rm -rf /")).toBe(false);
    // execFileSync should not be called for invalid binary names
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("returns false for empty string", () => {
    expect(binaryExists("")).toBe(false);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});

// --- checkNodeVersion ---

describe("checkNodeVersion", () => {
  const originalVersion = process.version;

  afterEach(() => {
    Object.defineProperty(process, "version", { value: originalVersion });
  });

  function setNodeVersion(version: string) {
    Object.defineProperty(process, "version", {
      value: version,
      writable: true,
      configurable: true,
    });
  }

  it("returns pass for Node >= 20", () => {
    setNodeVersion("v22.3.0");
    const result = checkNodeVersion();
    expect(result.name).toBe("node-version");
    expect(result.status).toBe("pass");
    expect(result.message).toContain("v22.3.0");
  });

  it("returns pass for Node exactly 22", () => {
    setNodeVersion("v22.0.0");
    const result = checkNodeVersion();
    expect(result.status).toBe("pass");
  });

  it("returns fail for Node < 22", () => {
    setNodeVersion("v20.17.0");
    const result = checkNodeVersion();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("20");
    expect(result.remediation).toBeDefined();
  });

  it("returns fail for very old Node", () => {
    setNodeVersion("v14.0.0");
    const result = checkNodeVersion();
    expect(result.status).toBe("fail");
  });

  it("returns pass for Node 24+", () => {
    setNodeVersion("v24.1.0");
    const result = checkNodeVersion();
    expect(result.status).toBe("pass");
  });
});

// --- checkPackageRoot ---

describe("checkPackageRoot", () => {
  it("returns pass when package.json exists at root", () => {
    mockExistsSync.mockImplementation((p: string) =>
      p === "/some/root/package.json"
    );
    const result = checkPackageRoot("/some/root");
    expect(result.name).toBe("package-root");
    expect(result.status).toBe("pass");
  });

  it("returns fail when package.json is missing", () => {
    mockExistsSync.mockReturnValue(false);
    const result = checkPackageRoot("/some/root");
    expect(result.status).toBe("fail");
    expect(result.remediation).toBeDefined();
  });
});

// --- checkGit ---

describe("checkGit", () => {
  it("returns pass when git is on PATH", () => {
    mockWhich(["git"]);
    const result = checkGit();
    expect(result.name).toBe("git");
    expect(result.status).toBe("pass");
  });

  it("returns fail when git is not on PATH", () => {
    mockWhich([]);
    const result = checkGit();
    expect(result.status).toBe("fail");
    expect(result.remediation).toBeDefined();
  });
});

// --- checkCliOnPath ---

describe("checkCliOnPath", () => {
  it("returns pass when review-orchestra is on PATH", () => {
    mockWhich(["review-orchestra"]);
    const result = checkCliOnPath();
    expect(result.name).toBe("cli-on-path");
    expect(result.status).toBe("pass");
  });

  it("returns fail when review-orchestra is not on PATH", () => {
    mockWhich([]);
    const result = checkCliOnPath();
    expect(result.status).toBe("fail");
    expect(result.remediation).toBeDefined();
    expect(result.remediation).toContain("npm");
  });
});

// --- checkBinary ---

describe("checkBinary", () => {
  it("returns pass when claude binary exists", () => {
    mockWhich(["claude"]);
    const result = checkBinary("claude");
    expect(result.name).toBe("claude-binary");
    expect(result.status).toBe("pass");
  });

  it("returns fail when claude binary is missing", () => {
    mockWhich([]);
    const result = checkBinary("claude");
    expect(result.status).toBe("fail");
    expect(result.remediation).toBeDefined();
  });

  it("returns pass when codex binary exists", () => {
    mockWhich(["codex"]);
    const result = checkBinary("codex");
    expect(result.name).toBe("codex-binary");
    expect(result.status).toBe("pass");
  });

  it("returns warn (not fail) when codex binary is missing", () => {
    mockWhich([]);
    const result = checkBinary("codex");
    expect(result.status).toBe("warn");
    expect(result.remediation).toBeDefined();
  });

  it("returns fail for unknown binary when missing", () => {
    mockWhich([]);
    const result = checkBinary("unknown-tool");
    expect(result.status).toBe("fail");
  });
});

// --- checkAuth ---

describe("checkBinaryHealth", () => {
  it("returns pass when binary --version exits 0", () => {
    mockExecFileSync.mockReturnValue(Buffer.from("claude 1.0.0\n"));
    const result = checkBinaryHealth("claude");
    expect(result.name).toBe("claude-health");
    expect(result.status).toBe("pass");
    // Verify called with 5-second timeout
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "claude",
      ["--version"],
      expect.objectContaining({ timeout: 5000 })
    );
  });

  it("returns fail for claude when --version fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("command failed");
    });
    const result = checkBinaryHealth("claude");
    expect(result.status).toBe("fail");
    expect(result.remediation).toBeDefined();
  });

  it("returns warn for codex when --version fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("command failed");
    });
    const result = checkBinaryHealth("codex");
    expect(result.status).toBe("warn");
    expect(result.remediation).toBeDefined();
  });

  it("returns fail for claude on timeout", () => {
    const err = new Error("timed out") as NodeJS.ErrnoException;
    err.code = "ETIMEDOUT";
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });
    const result = checkBinaryHealth("claude");
    expect(result.status).toBe("fail");
  });

  it("returns warn for codex on timeout", () => {
    const err = new Error("timed out") as NodeJS.ErrnoException;
    err.code = "ETIMEDOUT";
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });
    const result = checkBinaryHealth("codex");
    expect(result.status).toBe("warn");
  });

  it("uses 5-second timeout", () => {
    mockExecFileSync.mockReturnValue(Buffer.from("v1.0.0\n"));
    checkBinaryHealth("claude");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "claude",
      ["--version"],
      expect.objectContaining({ timeout: 5000 })
    );
  });
});

// --- checkClaudeHome ---

describe("checkClaudeHome", () => {
  it("returns pass when ~/.claude/ exists", () => {
    mockExistsSync.mockReturnValue(true);
    const result = checkClaudeHome();
    expect(result.name).toBe("claude-home");
    expect(result.status).toBe("pass");
  });

  it("returns fail when ~/.claude/ is missing", () => {
    mockExistsSync.mockReturnValue(false);
    const result = checkClaudeHome();
    expect(result.status).toBe("fail");
    expect(result.remediation).toBeDefined();
    expect(result.remediation).toContain("Claude Code");
  });
});

// --- checkSkillSymlink ---

describe("checkSkillSymlink", () => {
  it("returns pass when symlink exists and resolves to correct target", () => {
    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockImplementation((p: string) => {
      if (p.includes("skills/review-orchestra")) {
        return "/resolved/package/skill";
      }
      if (p.includes("/skill")) {
        return "/resolved/package/skill";
      }
      return p;
    });
    const result = checkSkillSymlink("/some/package");
    expect(result.name).toBe("skill-symlink");
    expect(result.status).toBe("pass");
  });

  it("returns fail when symlink is missing", () => {
    mockExistsSync.mockReturnValue(false);
    // realpathSync will throw for missing path
    mockRealpathSync.mockImplementation((p: string) => {
      if (p.includes("skills/review-orchestra")) {
        throw new Error("ENOENT: no such file or directory");
      }
      return p;
    });
    const result = checkSkillSymlink("/some/package");
    expect(result.status).toBe("fail");
    expect(result.remediation).toBeDefined();
  });

  it("returns fail for stale symlink (realpath mismatch)", () => {
    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockImplementation((p: string) => {
      if (p.includes("skills/review-orchestra")) {
        return "/old/stale/skill";
      }
      if (p.includes("/skill")) {
        return "/current/package/skill";
      }
      return p;
    });
    const result = checkSkillSymlink("/some/package");
    expect(result.status).toBe("fail");
    expect(result.message).toContain("stale");
  });

  it("passes for relative symlinks that resolve correctly via realpathSync", () => {
    // Both resolve to the same real path despite different input paths
    mockRealpathSync.mockReturnValue("/canonical/path/to/skill");
    // SKILL.md exists in resolved directory
    mockExistsSync.mockReturnValue(true);
    const result = checkSkillSymlink("/some/package");
    expect(result.status).toBe("pass");
  });

  it("uses realpathSync for comparison, not raw link text", () => {
    mockRealpathSync.mockImplementation((p: string) => {
      // Simulate different raw paths resolving to same canonical path
      if (p.includes("skills/review-orchestra")) {
        return "/canonical/skill";
      }
      if (p.includes("/skill")) {
        return "/canonical/skill";
      }
      return p;
    });
    // SKILL.md exists in resolved directory
    mockExistsSync.mockReturnValue(true);
    const result = checkSkillSymlink("/some/package");
    expect(result.status).toBe("pass");
    // realpathSync must have been called
    expect(mockRealpathSync).toHaveBeenCalled();
  });

  it("returns fail when realpath matches but SKILL.md is missing in target directory", () => {
    mockRealpathSync.mockReturnValue("/resolved/package/skill");
    // SKILL.md does NOT exist
    mockExistsSync.mockReturnValue(false);
    const result = checkSkillSymlink("/some/package");
    expect(result.status).toBe("fail");
    expect(result.message).toContain("SKILL.md");
    expect(result.message).toContain("missing");
    expect(result.remediation).toBeDefined();
    expect(result.remediation).toContain("SKILL.md");
  });
});

// --- checkSchemaFile ---

describe("checkSchemaFile", () => {
  it("returns pass when schema file exists", () => {
    mockExistsSync.mockReturnValue(true);
    const result = checkSchemaFile("/some/root");
    expect(result.name).toBe("schema-file");
    expect(result.status).toBe("pass");
  });

  it("returns warn when schema file is missing", () => {
    mockExistsSync.mockReturnValue(false);
    const result = checkSchemaFile("/some/root");
    expect(result.status).toBe("warn");
    expect(result.remediation).toBeDefined();
  });
});

// --- checkGitignore ---

describe("checkGitignore", () => {
  it("returns pass when .review-orchestra/ is in .gitignore", () => {
    // .git directory exists
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith(".git")) return true;
      if (p.endsWith(".gitignore")) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue(".review-orchestra/\nnode_modules/\n");
    const result = checkGitignore();
    expect(result.name).toBe("gitignore");
    expect(result.status).toBe("pass");
  });

  it("returns warn when .review-orchestra/ is not in .gitignore", () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith(".git")) return true;
      if (p.endsWith(".gitignore")) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue("node_modules/\ndist/\n");
    const result = checkGitignore();
    expect(result.status).toBe("warn");
    expect(result.remediation).toBeDefined();
  });

  it("skips gracefully when no .git directory exists", () => {
    mockExistsSync.mockReturnValue(false);
    const result = checkGitignore();
    expect(result.status).toBe("pass");
    expect(result.message).toContain("skip");
  });

  it("returns warn when .gitignore file does not exist but .git does", () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith(".git")) return true;
      return false;
    });
    const result = checkGitignore();
    expect(result.status).toBe("warn");
    expect(result.remediation).toBeDefined();
  });

  it("handles .gitignore with comments and blank lines", () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith(".git")) return true;
      if (p.endsWith(".gitignore")) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue(
      "# Build output\ndist/\n\n# Review state\n.review-orchestra/\n"
    );
    const result = checkGitignore();
    expect(result.status).toBe("pass");
  });

  it("handles .gitignore with .review-orchestra without trailing slash", () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith(".git")) return true;
      if (p.endsWith(".gitignore")) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue("node_modules/\n.review-orchestra\n");
    const result = checkGitignore();
    // Should accept both with and without trailing slash
    expect(result.status).toBe("pass");
  });

  it("handles .gitignore with existing entries (no false positive)", () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith(".git")) return true;
      if (p.endsWith(".gitignore")) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue(
      "node_modules/\n.env\n.review-orchestra-old/\n"
    );
    const result = checkGitignore();
    // .review-orchestra-old/ should NOT count as matching
    expect(result.status).toBe("warn");
  });
});


