import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectScope } from "../src/scope";

// We'll mock the shell execution so tests are deterministic
// execSync with encoding returns string, so mock returns strings
const mockExec = vi.fn<(cmd: string) => string>();
vi.mock("child_process", () => ({
  execSync: (...args: unknown[]) => mockExec(...args),
}));

beforeEach(() => {
  mockExec.mockReset();
});

describe("detectScope", () => {
  describe("uncommitted changes", () => {
    it("detects staged + unstaged changes", async () => {
      // git diff --name-only (unstaged) → has files
      // git diff --cached --name-only (staged) → has files
      // Combined diff output
      mockExec.mockImplementation((cmd: string) => {
        if (cmd === "git diff --name-only") return "src/foo.ts\n";
        if (cmd === "git diff --cached --name-only") return "src/bar.ts\n";
        if (cmd === "git diff HEAD") {
          return "diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,4 @@\n+added line\n";
        }
        if (cmd === "git rev-parse --abbrev-ref HEAD") return "feat/auth\n";
        if (cmd.startsWith("git log")) return "";
        return "";
      });

      const scope = await detectScope();
      expect(scope.type).toBe("uncommitted");
      expect(scope.files).toContain("src/foo.ts");
      expect(scope.files).toContain("src/bar.ts");
      expect(scope.diff).toContain("added line");
    });
  });

  describe("branch changes", () => {
    it("detects committed changes on a branch vs main", async () => {
      mockExec.mockImplementation((cmd: string) => {
        // No uncommitted changes
        if (cmd === "git diff --name-only") return "";
        if (cmd === "git diff --cached --name-only") return "";
        // On a feature branch
        if (cmd === "git rev-parse --abbrev-ref HEAD") {
          return "feat/auth\n";
        }
        // Has commits ahead of main
        if (cmd === "git log main..HEAD --oneline") {
          return "abc1234 add auth\ndef5678 add middleware\n";
        }
        // Merge base
        if (cmd === "git merge-base main HEAD") {
          return "1234567\n";
        }
        // Branch diff files
        if (cmd === "git diff main...HEAD --name-only") {
          return "src/auth/middleware.ts\nsrc/auth/login.ts\n";
        }
        // Branch diff content
        if (cmd === "git diff main...HEAD") {
          return "diff --git a/src/auth/middleware.ts b/src/auth/middleware.ts\n+new auth code\n";
        }
        return "";
      });

      const scope = await detectScope();
      expect(scope.type).toBe("branch");
      expect(scope.files).toEqual([
        "src/auth/middleware.ts",
        "src/auth/login.ts",
      ]);
      expect(scope.baseBranch).toBe("main");
      expect(scope.diff).toContain("new auth code");
    });
  });

  describe("path filtering", () => {
    it("filters detected files to only specified paths", async () => {
      mockExec.mockImplementation((cmd: string) => {
        if (cmd === "git diff --name-only") return "";
        if (cmd === "git diff --cached --name-only") return "";
        if (cmd === "git rev-parse --abbrev-ref HEAD") {
          return "feat/auth\n";
        }
        if (cmd === "git log main..HEAD --oneline") {
          return "abc1234 add auth\n";
        }
        if (cmd === "git merge-base main HEAD") {
          return "1234567\n";
        }
        if (cmd === "git diff main...HEAD --name-only") {
          return "src/auth/middleware.ts\nsrc/auth/login.ts\nsrc/api/routes.ts\n";
        }
        if (cmd === "git diff main...HEAD") {
          return "full diff content";
        }
        return "";
      });

      const scope = await detectScope(["src/auth/"]);
      expect(scope.files).toEqual([
        "src/auth/middleware.ts",
        "src/auth/login.ts",
      ]);
      expect(scope.files).not.toContain("src/api/routes.ts");
    });
  });

  describe("main branch with uncommitted changes", () => {
    it("detects uncommitted changes even on main", async () => {
      mockExec.mockImplementation((cmd: string) => {
        if (cmd === "git diff --name-only") {
          return "src/index.ts\n";
        }
        if (cmd === "git diff --cached --name-only") return "";
        if (cmd === "git diff HEAD") {
          return "diff content on main";
        }
        if (cmd === "git rev-parse --abbrev-ref HEAD") {
          return "main\n";
        }
        return "";
      });

      const scope = await detectScope();
      expect(scope.type).toBe("uncommitted");
      expect(scope.files).toEqual(["src/index.ts"]);
    });
  });

  describe("no changes detected", () => {
    it("throws when there is nothing to review", async () => {
      mockExec.mockImplementation((cmd: string) => {
        if (cmd === "git diff --name-only") return "";
        if (cmd === "git diff --cached --name-only") return "";
        if (cmd === "git rev-parse --abbrev-ref HEAD") {
          return "main\n";
        }
        if (cmd === "git log main..HEAD --oneline") return "";
        return "";
      });

      await expect(detectScope()).rejects.toThrow("No changes detected");
    });
  });

  describe("path validation", () => {
    it("rejects paths with .. traversal", async () => {
      mockExec.mockImplementation((cmd: string) => {
        if (cmd === "git diff --name-only") return "";
        if (cmd === "git diff --cached --name-only") return "";
        if (cmd === "git rev-parse --abbrev-ref HEAD") return "feat/test\n";
        if (cmd === "git log main..HEAD --oneline") return "abc123 commit\n";
        if (cmd === "git diff main...HEAD --name-only")
          return "src/a.ts\n../../etc/passwd\n";
        if (cmd === "git diff main...HEAD") return "small diff";
        return "";
      });

      const scope = await detectScope(["../../etc/"]);
      expect(scope.files).not.toContain("../../etc/passwd");
    });

    it("rejects absolute paths in filters", async () => {
      mockExec.mockImplementation((cmd: string) => {
        if (cmd === "git diff --name-only") return "";
        if (cmd === "git diff --cached --name-only") return "";
        if (cmd === "git rev-parse --abbrev-ref HEAD") return "feat/test\n";
        if (cmd === "git log main..HEAD --oneline") return "abc123 commit\n";
        if (cmd === "git diff main...HEAD --name-only") return "src/a.ts\n";
        if (cmd === "git diff main...HEAD") return "small diff";
        return "";
      });

      const scope = await detectScope(["/etc/passwd"]);
      // Absolute path filter dropped, no valid filters remain, all files pass through
      expect(scope.files).toEqual(["src/a.ts"]);
    });
  });
});
