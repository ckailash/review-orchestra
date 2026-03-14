import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectScope } from "../src/scope";

// scope.ts now uses execFileSync (argument arrays, no shell).
// Mock it to match on the joined args for readability.
const mockExecFile = vi.fn<(...args: unknown[]) => string>();
vi.mock("child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFile(...args),
}));

function argsToCmd(args: unknown[]): string {
  // execFileSync("git", [...gitArgs], opts) — join binary + gitArgs
  const binary = args[0] as string;
  const gitArgs = args[1] as string[];
  return `${binary} ${gitArgs.join(" ")}`;
}

beforeEach(() => {
  mockExecFile.mockReset();
});

describe("detectScope", () => {
  describe("uncommitted changes", () => {
    it("detects staged + unstaged changes", async () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cmd = argsToCmd(args);
        if (cmd === "git diff --name-only") return "src/foo.ts\n";
        if (cmd === "git diff --cached --name-only") return "src/bar.ts\n";
        if (cmd === "git ls-files --others --exclude-standard") return "";
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
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cmd = argsToCmd(args);
        // No uncommitted changes
        if (cmd === "git diff --name-only") return "";
        if (cmd === "git diff --cached --name-only") return "";
        if (cmd === "git ls-files --others --exclude-standard") return "";
        // On a feature branch
        if (cmd === "git rev-parse --abbrev-ref HEAD") {
          return "feat/auth\n";
        }
        // detectDefaultBranch: symbolic-ref fails, rev-parse --verify main succeeds
        if (cmd === "git symbolic-ref refs/remotes/origin/HEAD") {
          throw new Error("not set");
        }
        if (cmd === "git rev-parse --verify main") return "abc1234\n";
        // Has commits ahead of main
        if (cmd === "git log main..HEAD --oneline") {
          return "abc1234 add auth\ndef5678 add middleware\n";
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
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cmd = argsToCmd(args);
        if (cmd === "git diff --name-only") return "";
        if (cmd === "git diff --cached --name-only") return "";
        if (cmd === "git ls-files --others --exclude-standard") return "";
        if (cmd === "git rev-parse --abbrev-ref HEAD") {
          return "feat/auth\n";
        }
        if (cmd === "git symbolic-ref refs/remotes/origin/HEAD") {
          throw new Error("not set");
        }
        if (cmd === "git rev-parse --verify main") return "abc1234\n";
        if (cmd === "git log main..HEAD --oneline") {
          return "abc1234 add auth\n";
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
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cmd = argsToCmd(args);
        if (cmd === "git diff --name-only") {
          return "src/index.ts\n";
        }
        if (cmd === "git diff --cached --name-only") return "";
        if (cmd === "git ls-files --others --exclude-standard") return "";
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
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cmd = argsToCmd(args);
        if (cmd === "git diff --name-only") return "";
        if (cmd === "git diff --cached --name-only") return "";
        if (cmd === "git ls-files --others --exclude-standard") return "";
        if (cmd === "git rev-parse --abbrev-ref HEAD") {
          return "main\n";
        }
        if (cmd.startsWith("git log")) return "";
        return "";
      });

      await expect(detectScope()).rejects.toThrow("No changes detected");
    });
  });

  describe("path validation", () => {
    it("rejects paths with .. traversal", async () => {
      await expect(detectScope(["../../etc/"])).rejects.toThrow("Invalid path filters");
    });

    it("rejects absolute paths in filters", async () => {
      await expect(detectScope(["/etc/passwd"])).rejects.toThrow("Invalid path filters");
    });
  });
});
