import { execFileSync } from "child_process";
import { normalize } from "path";
import type { DiffScope } from "./types";

const MAX_DIFF_BYTES = 512 * 1024; // 512KB

function git(...args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    maxBuffer: MAX_DIFF_BYTES * 2,
  }).trim();
}

// git diff --no-index exits with code 1 when files differ (normal for new files).
// execFileSync throws on non-zero exit, so we capture the output from the error object.
function diffNewFile(file: string): string {
  try {
    return execFileSync("git", ["diff", "--no-index", "/dev/null", file], {
      encoding: "utf-8",
      maxBuffer: MAX_DIFF_BYTES * 2,
    }).trim();
  } catch (err) {
    // Exit code 1 = files differ (expected). The diff output is in stdout.
    if (err && typeof err === "object" && "stdout" in err) {
      return String((err as { stdout: string }).stdout).trim();
    }
    return "";
  }
}

function parseFileList(output: string): string[] {
  return output
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => !f.startsWith("/") && !f.includes(".."));
}

function validatePaths(paths: string[]): string[] {
  const normalized = paths.map((p) => normalize(p));
  const invalid = normalized.filter((p) => p.startsWith("/") || p.includes(".."));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid path filters (absolute or traversal paths are not allowed): ${invalid.join(", ")}`
    );
  }
  return normalized;
}

function filterByPaths(files: string[], paths: string[]): string[] {
  if (paths.length === 0) return files;
  return files.filter((file) =>
    paths.some((p) => file === p || file.startsWith(p.endsWith("/") ? p : p + "/"))
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

// Validate that a commit ref resolves to a real object
function validateRef(ref: string): void {
  try {
    git("rev-parse", "--verify", ref);
  } catch {
    throw new Error(`Invalid git ref: ${ref}`);
  }
}

// Normalize a ref into a from..to range
function normalizeRefRange(ref: string): { from: string; to: string; separator: string; description: string } {
  // Already a range: abc..def or abc...def
  const rangeMatch = ref.match(/^(.+?)(\.{2,3})(.+)$/);
  if (rangeMatch) {
    return {
      from: rangeMatch[1],
      to: rangeMatch[3],
      separator: rangeMatch[2],
      description: `${rangeMatch[1]}${rangeMatch[2]}${rangeMatch[3]}`,
    };
  }
  // Single ref: treat as ref..HEAD
  return {
    from: ref,
    to: "HEAD",
    separator: "..",
    description: `${ref}..HEAD`,
  };
}

function detectDefaultBranch(): string | null {
  // Try symbolic ref from remote HEAD first
  try {
    const ref = git("symbolic-ref", "refs/remotes/origin/HEAD");
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    // No remote HEAD configured
  }
  // Fall back: try main, then master
  for (const candidate of ["main", "master"]) {
    try {
      git("rev-parse", "--verify", candidate);
      return candidate;
    } catch {
      // Branch doesn't exist
    }
  }
  return null;
}

export async function detectScope(
  filterPaths: string[] = [],
  commitRef?: string
): Promise<DiffScope> {
  const safePaths = validatePaths(filterPaths);

  // Explicit commit ref — highest priority
  if (commitRef) {
    const { from, to, separator, description } = normalizeRefRange(commitRef);
    validateRef(from);
    if (to !== "HEAD") validateRef(to);

    const range = `${from}${separator}${to}`;
    const refFiles = parseFileList(git("diff", range, "--name-only"));
    const files = filterByPaths(refFiles, safePaths);
    if (files.length === 0) {
      if (safePaths.length > 0) {
        throw new Error(`No changes match the specified paths: ${safePaths.join(", ")}`);
      }
      throw new Error(`No changes between ${description}`);
    }
    // When paths are specified, scope the diff so the size check applies
    // only to the filtered subset
    const diff = safePaths.length > 0
      ? git("diff", range, "--", ...safePaths)
      : git("diff", range);
    checkDiffSize(diff);
    return {
      type: "commit",
      diff,
      files,
      baseBranch: from,
      description: `Changes in ${description}`,
    };
  }

  // Check for uncommitted changes (staged + unstaged + untracked)
  const unstaged = git("diff", "--name-only");
  const staged = git("diff", "--cached", "--name-only");
  const untracked = git("ls-files", "--others", "--exclude-standard");
  const uncommittedFiles = parseFileList(`${unstaged}\n${staged}\n${untracked}`);

  if (uncommittedFiles.length > 0) {
    const files = filterByPaths([...new Set(uncommittedFiles)], safePaths);
    if (files.length === 0 && safePaths.length > 0) {
      throw new Error(`No changes match the specified paths: ${safePaths.join(", ")}`);
    }

    // git diff HEAD covers staged + unstaged modifications to tracked files.
    // On a fresh repo with no commits, HEAD doesn't exist — fall back to --cached.
    // When paths are specified, scope the diff so the size check applies
    // only to the filtered subset.
    const pathSuffix = safePaths.length > 0 ? ["--", ...safePaths] : [];
    let trackedDiff: string;
    try {
      trackedDiff = git("diff", "HEAD", ...pathSuffix);
    } catch {
      trackedDiff = git("diff", "--cached", ...pathSuffix);
    }

    // For untracked (new) files, generate diffs against /dev/null
    const untrackedList = filterByPaths(parseFileList(untracked), safePaths);
    const untrackedDiffs = untrackedList
      .map((file) => diffNewFile(file))
      .filter(Boolean);

    const diff = [trackedDiff, ...untrackedDiffs].filter(Boolean).join("\n");
    checkDiffSize(diff);
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    return {
      type: "uncommitted",
      diff,
      files,
      baseBranch: branch,
      description: `Uncommitted changes on ${branch}`,
    };
  }

  // Check for branch commits ahead of the default branch
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main" && branch !== "master") {
    const baseBranch = detectDefaultBranch();
    if (baseBranch) {
      const commitsAhead = git("log", `${baseBranch}..HEAD`, "--oneline");
      if (commitsAhead.length > 0) {
        const branchFiles = parseFileList(
          git("diff", `${baseBranch}...HEAD`, "--name-only")
        );
        const files = filterByPaths(branchFiles, safePaths);
        if (files.length === 0 && safePaths.length > 0) {
          throw new Error(`No changes match the specified paths: ${safePaths.join(", ")}`);
        }
        // When paths are specified, scope the diff so the size check applies
        // only to the filtered subset
        const diff = safePaths.length > 0
          ? git("diff", `${baseBranch}...HEAD`, "--", ...safePaths)
          : git("diff", `${baseBranch}...HEAD`);
        checkDiffSize(diff);
        return {
          type: "branch",
          diff,
          files,
          baseBranch,
          description: `Branch ${branch} vs ${baseBranch}`,
        };
      }
    }
  }

  throw new Error("No changes detected — nothing to review");
}
