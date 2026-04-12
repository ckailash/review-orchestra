import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Compute a SHA-256 hash over the current worktree state.
 *
 * The hash covers three components concatenated in order:
 * 1. HEAD commit (git rev-parse HEAD)
 * 2. Staged + unstaged changes (git diff HEAD)
 * 3. Untracked files: paths + contents, sorted, null-byte separated
 *
 * Properties:
 * - Null-safe: handles filenames with spaces and special characters
 * - Deterministic: same state always produces the same hash
 * - Path-sensitive: renaming an untracked file changes the hash
 * - Complete: any change to HEAD, staged, unstaged, or untracked state changes the hash
 */
export function computeWorktreeHash(cwd: string = process.cwd()): string {
  const hash = createHash("sha256");

  // 1. HEAD commit
  let head = "";
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf-8",
    }).trim();
  } catch {
    // Fresh repo with no commits — HEAD doesn't exist yet
  }
  hash.update(head);

  // 2. Staged + unstaged changes vs HEAD
  let diff = "";
  try {
    diff = execFileSync("git", ["diff", "HEAD"], {
      cwd,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    // Fresh repo — no HEAD to diff against; try staged changes only
    try {
      diff = execFileSync("git", ["diff", "--cached"], {
        cwd,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      // No diff available
    }
  }
  hash.update(diff);

  // 3. Untracked files — list with null-byte separation for safety
  let untrackedRaw = "";
  try {
    untrackedRaw = execFileSync(
      "git",
      ["ls-files", "-z", "--others", "--exclude-standard"],
      { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
    );
  } catch {
    // git ls-files failed — skip untracked files
  }

  if (untrackedRaw.length > 0) {
    // Split on null bytes, filter empty trailing entry
    const untrackedFiles = untrackedRaw.split("\0").filter(Boolean);
    // Sort for determinism
    untrackedFiles.sort();

    for (const filePath of untrackedFiles) {
      const fullPath = join(cwd, filePath);
      // Feed path\0content\0 into the hash
      hash.update(filePath);
      hash.update("\0");
      try {
        const content = readFileSync(fullPath);
        hash.update(content);
      } catch {
        // File may have been deleted between listing and reading; skip
      }
      hash.update("\0");
    }
  }

  return hash.digest("hex");
}

/**
 * Check if the current worktree is stale relative to the last review round.
 *
 * @param lastWorktreeHash - The worktree hash from the last review round, or null if no session/rounds exist.
 * @param cwd - Working directory for computing current hash (defaults to process.cwd()).
 *
 * Returns:
 * - 0 if fresh (current hash matches last round's hash)
 * - 1 if stale (current hash differs from last round's hash)
 * - 2 if no session exists or no rounds recorded (lastWorktreeHash is null)
 */
export function checkStale(lastWorktreeHash: string | null, cwd: string = process.cwd()): number {
  if (lastWorktreeHash === null) {
    return 2;
  }

  const currentHash = computeWorktreeHash(cwd);

  if (currentHash === lastWorktreeHash) {
    return 0; // fresh
  }

  return 1; // stale
}
