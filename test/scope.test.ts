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
  mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
    throw new Error(`unmocked git command: git ${args?.join(" ") ?? ""}`);
  });
});

describe("detectScope", () => {
  describe("uncommitted changes", () => {
    it("detects staged + unstaged changes", () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cmd = argsToCmd(args);
        if (cmd === "git diff --name-only -z") return "src/foo.ts\n";
        if (cmd === "git diff --cached --name-only -z") return "src/bar.ts\n";
        if (cmd === "git ls-files -z --others --exclude-standard") return "";
        if (cmd === "git diff HEAD") {
          return "diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,4 @@\n+added line\n";
        }
        if (cmd === "git rev-parse --abbrev-ref HEAD") return "feat/auth\n";
        if (cmd.startsWith("git log")) return "";
        return "";
      });

      const scope = detectScope();
      expect(scope.type).toBe("uncommitted");
      expect(scope.files).toContain("src/foo.ts");
      expect(scope.files).toContain("src/bar.ts");
      expect(scope.diff).toContain("added line");
    });
  });

  describe("branch changes", () => {
    it("detects committed changes on a branch vs main", () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cmd = argsToCmd(args);
        // No uncommitted changes
        if (cmd === "git diff --name-only -z") return "";
        if (cmd === "git diff --cached --name-only -z") return "";
        if (cmd === "git ls-files -z --others --exclude-standard") return "";
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
        if (cmd === "git diff main...HEAD --name-only -z") {
          return "src/auth/middleware.ts\0src/auth/login.ts\0";
        }
        // Branch diff content
        if (cmd === "git diff main...HEAD") {
          return "diff --git a/src/auth/middleware.ts b/src/auth/middleware.ts\n+new auth code\n";
        }
        return "";
      });

      const scope = detectScope();
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
    it("filters detected files to only specified paths", () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cmd = argsToCmd(args);
        if (cmd === "git diff --name-only -z") return "";
        if (cmd === "git diff --cached --name-only -z") return "";
        if (cmd === "git ls-files -z --others --exclude-standard") return "";
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
        if (cmd === "git diff main...HEAD --name-only -z") {
          return "src/auth/middleware.ts\0src/auth/login.ts\0src/api/routes.ts\0";
        }
        if (cmd === "git diff main...HEAD") {
          return "full diff content";
        }
        return "";
      });

      const scope = detectScope(["src/auth/"]);
      expect(scope.files).toEqual([
        "src/auth/middleware.ts",
        "src/auth/login.ts",
      ]);
      expect(scope.files).not.toContain("src/api/routes.ts");
    });
  });

  describe("main branch with uncommitted changes", () => {
    it("detects uncommitted changes even on main", () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cmd = argsToCmd(args);
        if (cmd === "git diff --name-only -z") {
          return "src/index.ts\n";
        }
        if (cmd === "git diff --cached --name-only -z") return "";
        if (cmd === "git ls-files -z --others --exclude-standard") return "";
        if (cmd === "git diff HEAD") {
          return "diff content on main";
        }
        if (cmd === "git rev-parse --abbrev-ref HEAD") {
          return "main\n";
        }
        return "";
      });

      const scope = detectScope();
      expect(scope.type).toBe("uncommitted");
      expect(scope.files).toEqual(["src/index.ts"]);
    });
  });

  describe("baseCommitSha", () => {
    it("populates baseCommitSha for uncommitted scope", () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cmd = argsToCmd(args);
        if (cmd === "git diff --name-only -z") return "src/foo.ts\n";
        if (cmd === "git diff --cached --name-only -z") return "";
        if (cmd === "git ls-files -z --others --exclude-standard") return "";
        if (cmd === "git diff HEAD") {
          return "diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,4 @@\n+added line\n";
        }
        if (cmd === "git rev-parse --abbrev-ref HEAD") return "feat/auth\n";
        if (cmd === "git rev-parse feat/auth") return "abc123def456\n";
        if (cmd.startsWith("git log")) return "";
        return "";
      });

      const scope = detectScope();
      expect(scope.type).toBe("uncommitted");
      expect(scope.baseCommitSha).toBe("abc123def456");
    });
  });

  describe("no changes detected", () => {
    it("throws when there is nothing to review", () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cmd = argsToCmd(args);
        if (cmd === "git diff --name-only -z") return "";
        if (cmd === "git diff --cached --name-only -z") return "";
        if (cmd === "git ls-files -z --others --exclude-standard") return "";
        if (cmd === "git rev-parse --abbrev-ref HEAD") {
          return "main\n";
        }
        if (cmd.startsWith("git log")) return "";
        return "";
      });

      expect(() => detectScope()).toThrow("No changes detected");
    });
  });

  describe("diff size limit enforcement", () => {
    it("throws when diff exceeds MAX_DIFF_BYTES", () => {
      // MAX_DIFF_BYTES is 512 * 1024 = 524288
      const largeDiff = "x".repeat(512 * 1024 + 1);
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cmd = argsToCmd(args);
        if (cmd === "git diff --name-only -z") return "src/big.ts\n";
        if (cmd === "git diff --cached --name-only -z") return "";
        if (cmd === "git ls-files -z --others --exclude-standard") return "";
        if (cmd === "git diff HEAD") return largeDiff;
        if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
        if (cmd.startsWith("git log")) return "";
        return "";
      });

      expect(() => detectScope()).toThrow("Diff is too large");
    });
  });

  describe("untracked files in uncommitted scope", () => {
    it("includes untracked files in uncommitted scope", () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cmd = argsToCmd(args);
        if (cmd === "git diff --name-only -z") return "";
        if (cmd === "git diff --cached --name-only -z") return "";
        if (cmd === "git ls-files -z --others --exclude-standard") return "new-file.ts\n";
        // HEAD diff covers tracked files — empty since no tracked changes
        if (cmd === "git diff HEAD") return "";
        if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
        if (cmd === "git log --oneline -10 HEAD") return "abc commit msg\n";
        // diffNewFile uses --no-index which exits with code 1
        if (cmd === "git diff --no-index /dev/null new-file.ts") {
          const err = new Error("exit code 1") as Error & { stdout: string };
          err.stdout = "diff --git a/dev/null b/new-file.ts\n--- /dev/null\n+++ b/new-file.ts\n@@ -0,0 +1,3 @@\n+const x = 1;\n+export default x;\n";
          throw err;
        }
        return "";
      });

      const scope = detectScope();
      expect(scope.type).toBe("uncommitted");
      expect(scope.files).toContain("new-file.ts");
      expect(scope.diff).toContain("new-file.ts");
      expect(scope.diff).toContain("const x = 1");
    });
  });

  describe("path validation", () => {
    it("rejects paths with .. traversal", () => {
      expect(() => detectScope(["../../etc/"])).toThrow("Invalid path filters");
    });

    it("rejects absolute paths in filters", () => {
      expect(() => detectScope(["/etc/passwd"])).toThrow("Invalid path filters");
    });
  });

  describe("commitMessages", () => {
    it("populates commitMessages for branch scope", () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cmd = argsToCmd(args);
        if (cmd === "git diff --name-only -z") return "";
        if (cmd === "git diff --cached --name-only -z") return "";
        if (cmd === "git ls-files -z --others --exclude-standard") return "";
        if (cmd === "git rev-parse --abbrev-ref HEAD") return "feat/auth\n";
        if (cmd === "git symbolic-ref refs/remotes/origin/HEAD") {
          throw new Error("not set");
        }
        if (cmd === "git rev-parse --verify main") return "abc1234\n";
        if (cmd === "git log main..HEAD --oneline") {
          return "abc1234 add auth\ndef5678 add middleware\n";
        }
        if (cmd === "git diff main...HEAD --name-only -z") {
          return "src/auth/middleware.ts\0";
        }
        if (cmd === "git diff main...HEAD") {
          return "diff --git a/src/auth/middleware.ts b/src/auth/middleware.ts\n+new auth code\n";
        }
        return "";
      });

      const scope = detectScope();
      expect(scope.type).toBe("branch");
      expect(scope.commitMessages).toBe(
        "abc1234 add auth\ndef5678 add middleware"
      );
    });

    it("populates commitMessages for uncommitted scope", () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cmd = argsToCmd(args);
        if (cmd === "git diff --name-only -z") return "src/foo.ts\n";
        if (cmd === "git diff --cached --name-only -z") return "";
        if (cmd === "git ls-files -z --others --exclude-standard") return "";
        if (cmd === "git diff HEAD") {
          return "diff --git a/src/foo.ts b/src/foo.ts\n+added line\n";
        }
        if (cmd === "git rev-parse --abbrev-ref HEAD") return "feat/auth\n";
        if (cmd === "git log --oneline -10 HEAD") {
          return "aaa1111 recent commit\nbbb2222 older commit\n";
        }
        return "";
      });

      const scope = detectScope();
      expect(scope.type).toBe("uncommitted");
      expect(scope.commitMessages).toBe(
        "aaa1111 recent commit\nbbb2222 older commit"
      );
    });

    it("populates commitMessages for commit scope", () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cmd = argsToCmd(args);
        if (cmd === "git rev-parse --verify abc1234") return "abc1234\n";
        if (cmd === "git diff abc1234..HEAD --name-only -z") {
          return "src/foo.ts\0";
        }
        if (cmd === "git diff abc1234..HEAD") {
          return "diff --git a/src/foo.ts b/src/foo.ts\n+changed\n";
        }
        if (cmd === "git log --oneline abc1234..HEAD") {
          return "def5678 fix bug\nghi9012 add feature\n";
        }
        return "";
      });

      const scope = detectScope([], "abc1234");
      expect(scope.type).toBe("commit");
      expect(scope.commitMessages).toBe(
        "def5678 fix bug\nghi9012 add feature"
      );
    });

    it("sets commitMessages to undefined when git log fails on fresh repo", () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cmd = argsToCmd(args);
        if (cmd === "git diff --name-only -z") return "src/foo.ts\n";
        if (cmd === "git diff --cached --name-only -z") return "";
        if (cmd === "git ls-files -z --others --exclude-standard") return "";
        // HEAD doesn't exist on fresh repo — fall back to --cached
        if (cmd === "git diff HEAD") throw new Error("bad revision HEAD");
        if (cmd === "git diff --cached") {
          return "diff --git a/src/foo.ts b/src/foo.ts\n+new file\n";
        }
        if (cmd === "git rev-parse --abbrev-ref HEAD") return "main\n";
        // git log fails on fresh repo with no commits
        if (cmd === "git log --oneline -10 HEAD") {
          throw new Error("bad default revision HEAD");
        }
        return "";
      });

      const scope = detectScope();
      expect(scope.type).toBe("uncommitted");
      expect(scope.commitMessages).toBeUndefined();
      expect(scope.files).toContain("src/foo.ts");
      expect(scope.diff).toContain("new file");
    });
  });
});
