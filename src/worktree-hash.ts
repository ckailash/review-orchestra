import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { SessionState } from "./types";

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
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf-8",
  }).trim();
  hash.update(head);

  // 2. Staged + unstaged changes vs HEAD
  const diff = execFileSync("git", ["diff", "HEAD"], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024, // 10MB
  });
  hash.update(diff);

  // 3. Untracked files — list with null-byte separation for safety
  const untrackedRaw = execFileSync(
    "git",
    ["ls-files", "-z", "--others", "--exclude-standard"],
    { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
  );

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
 * Returns:
 * - 0 if fresh (current hash matches last round's hash)
 * - 1 if stale (current hash differs from last round's hash)
 * - 2 if no session exists or no rounds recorded
 */
export function checkStale(stateDir: string, cwd: string = process.cwd()): number {
  const sessionFile = join(stateDir, "session.json");

  if (!existsSync(sessionFile)) {
    return 2;
  }

  let state: SessionState;
  try {
    const raw = readFileSync(sessionFile, "utf-8");
    state = JSON.parse(raw) as SessionState;
  } catch {
    return 2;
  }

  if (!state.rounds || state.rounds.length === 0) {
    return 2;
  }

  const lastRound = state.rounds[state.rounds.length - 1];
  if (!lastRound || !lastRound.worktreeHash) {
    return 2;
  }

  const currentHash = computeWorktreeHash(cwd);

  if (currentHash === lastRound.worktreeHash) {
    return 0; // fresh
  }

  return 1; // stale
}
