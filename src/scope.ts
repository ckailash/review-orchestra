import { execSync } from "child_process";
import { normalize } from "path";
import type { DiffScope } from "./types";

const MAX_DIFF_BYTES = 512 * 1024; // 512KB

function exec(cmd: string): string {
  return execSync(cmd, {
    encoding: "utf-8",
    maxBuffer: MAX_DIFF_BYTES * 2,
  }).trim();
}

function parseFileList(output: string): string[] {
  return output
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => !f.startsWith("/") && !f.includes(".."));
}

function validatePaths(paths: string[]): string[] {
  return paths
    .map((p) => normalize(p))
    .filter((p) => !p.startsWith("/") && !p.includes(".."));
}

function filterByPaths(files: string[], paths: string[]): string[] {
  if (paths.length === 0) return files;
  return files.filter((file) =>
    paths.some((p) => file.startsWith(p) || file === p)
  );
}

function checkDiffSize(diff: string): void {
  const bytes = Buffer.byteLength(diff, "utf-8");
  if (bytes > MAX_DIFF_BYTES) {
    throw new Error(
      `Diff is too large (${(bytes / 1024).toFixed(0)}KB, max ${MAX_DIFF_BYTES / 1024}KB). ` +
        `Narrow the scope by specifying paths: /review-orchestra src/specific-dir/`
    );
  }
}

export async function detectScope(
  filterPaths: string[] = []
): Promise<DiffScope> {
  const safePaths = validatePaths(filterPaths);

  // Check for uncommitted changes (staged + unstaged)
  const unstaged = exec("git diff --name-only");
  const staged = exec("git diff --cached --name-only");
  const uncommittedFiles = parseFileList(`${unstaged}\n${staged}`);

  if (uncommittedFiles.length > 0) {
    const diff = exec("git diff HEAD");
    checkDiffSize(diff);
    const files = filterByPaths([...new Set(uncommittedFiles)], safePaths);
    const branch = exec("git rev-parse --abbrev-ref HEAD");
    return {
      type: "uncommitted",
      diff,
      files,
      baseBranch: branch,
      description: `Uncommitted changes on ${branch}`,
    };
  }

  // Check for branch commits ahead of main
  const branch = exec("git rev-parse --abbrev-ref HEAD");
  if (branch !== "main" && branch !== "master") {
    const baseBranch = "main";
    const commitsAhead = exec(`git log ${baseBranch}..HEAD --oneline`);
    if (commitsAhead.length > 0) {
      const branchFiles = parseFileList(
        exec(`git diff ${baseBranch}...HEAD --name-only`)
      );
      const diff = exec(`git diff ${baseBranch}...HEAD`);
      checkDiffSize(diff);
      const files = filterByPaths(branchFiles, safePaths);
      return {
        type: "branch",
        diff,
        files,
        baseBranch,
        description: `Branch ${branch} vs ${baseBranch}`,
      };
    }
  }

  throw new Error("No changes detected — nothing to review");
}
