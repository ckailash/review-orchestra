import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { computeWorktreeHash, checkStale } from "../src/worktree-hash";

const TEST_DIR = "/tmp/review-orchestra-test-worktree-hash";

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: TEST_DIR,
    encoding: "utf-8",
  }).trim();
}

function writeFile(relativePath: string, content: string): void {
  const fullPath = join(TEST_DIR, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content);
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  git("init");
  git("config", "user.email", "test@test.com");
  git("config", "user.name", "Test");
  // Need at least one commit for HEAD to exist
  writeFile("initial.txt", "hello");
  git("add", ".");
  git("commit", "-m", "initial");
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("computeWorktreeHash", () => {
  it("produces a valid SHA-256 hex string", () => {
    const hash = computeWorktreeHash(TEST_DIR);
    // SHA-256 produces 64 hex characters
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same state produces same hash", () => {
    const hash1 = computeWorktreeHash(TEST_DIR);
    const hash2 = computeWorktreeHash(TEST_DIR);
    expect(hash1).toBe(hash2);
  });

  it("changes when HEAD changes (new commit)", () => {
    const hash1 = computeWorktreeHash(TEST_DIR);
    writeFile("new.txt", "new content");
    git("add", ".");
    git("commit", "-m", "second commit");
    const hash2 = computeWorktreeHash(TEST_DIR);
    expect(hash1).not.toBe(hash2);
  });

  it("changes when staged changes are added", () => {
    const hash1 = computeWorktreeHash(TEST_DIR);
    writeFile("initial.txt", "modified content");
    git("add", "initial.txt");
    const hash2 = computeWorktreeHash(TEST_DIR);
    expect(hash1).not.toBe(hash2);
  });

  it("changes when unstaged changes are made", () => {
    const hash1 = computeWorktreeHash(TEST_DIR);
    writeFile("initial.txt", "modified content");
    const hash2 = computeWorktreeHash(TEST_DIR);
    expect(hash1).not.toBe(hash2);
  });

  it("changes when an untracked file is added", () => {
    const hash1 = computeWorktreeHash(TEST_DIR);
    writeFile("untracked.txt", "some content");
    const hash2 = computeWorktreeHash(TEST_DIR);
    expect(hash1).not.toBe(hash2);
  });

  it("is path-sensitive — renaming an untracked file changes the hash", () => {
    writeFile("file-a.txt", "same content");
    const hash1 = computeWorktreeHash(TEST_DIR);
    // Rename the file (same content, different path)
    renameSync(join(TEST_DIR, "file-a.txt"), join(TEST_DIR, "file-b.txt"));
    const hash2 = computeWorktreeHash(TEST_DIR);
    expect(hash1).not.toBe(hash2);
  });

  it("changes when untracked file content changes", () => {
    writeFile("untracked.txt", "content v1");
    const hash1 = computeWorktreeHash(TEST_DIR);
    writeFile("untracked.txt", "content v2");
    const hash2 = computeWorktreeHash(TEST_DIR);
    expect(hash1).not.toBe(hash2);
  });

  it("handles filenames with spaces", () => {
    writeFile("file with spaces.txt", "content");
    // Should not throw
    const hash = computeWorktreeHash(TEST_DIR);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles empty untracked files", () => {
    writeFile("empty.txt", "");
    const hash = computeWorktreeHash(TEST_DIR);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("checkStale", () => {
  it("returns 2 when no session exists", () => {
    const stateDir = join(TEST_DIR, ".review-orchestra");
    mkdirSync(stateDir, { recursive: true });
    // No session.json file
    const result = checkStale(stateDir, TEST_DIR);
    expect(result).toBe(2);
  });

  it("returns 2 when session exists but has no rounds", () => {
    const stateDir = join(TEST_DIR, ".review-orchestra");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "session.json"),
      JSON.stringify({
        sessionId: "20260315-143022",
        status: "active",
        currentRound: 0,
        rounds: [],
        scope: null,
        worktreeHash: "",
        startedAt: "2026-03-15T14:30:22Z",
        completedAt: null,
      }),
    );
    const result = checkStale(stateDir, TEST_DIR);
    expect(result).toBe(2);
  });

  it("returns 0 when current hash matches stored hash (fresh)", () => {
    const stateDir = join(TEST_DIR, ".review-orchestra");
    mkdirSync(stateDir, { recursive: true });

    // .review-orchestra/ should be gitignored in real usage
    writeFileSync(join(TEST_DIR, ".gitignore"), ".review-orchestra/\n");
    git("add", ".gitignore");
    git("commit", "-m", "add gitignore");

    const currentHash = computeWorktreeHash(TEST_DIR);
    writeFileSync(
      join(stateDir, "session.json"),
      JSON.stringify({
        sessionId: "20260315-143022",
        status: "active",
        currentRound: 1,
        rounds: [
          {
            number: 1,
            phase: "complete",
            reviews: {},
            consolidated: [],
            worktreeHash: currentHash,
            startedAt: "2026-03-15T14:30:22Z",
            completedAt: "2026-03-15T14:31:00Z",
          },
        ],
        scope: null,
        worktreeHash: currentHash,
        startedAt: "2026-03-15T14:30:22Z",
        completedAt: null,
      }),
    );
    const result = checkStale(stateDir, TEST_DIR);
    expect(result).toBe(0);
  });

  it("returns 1 when current hash differs from stored hash (stale)", () => {
    const stateDir = join(TEST_DIR, ".review-orchestra");
    mkdirSync(stateDir, { recursive: true });

    writeFileSync(
      join(stateDir, "session.json"),
      JSON.stringify({
        sessionId: "20260315-143022",
        status: "active",
        currentRound: 1,
        rounds: [
          {
            number: 1,
            phase: "complete",
            reviews: {},
            consolidated: [],
            worktreeHash: "old-hash-that-no-longer-matches",
            startedAt: "2026-03-15T14:30:22Z",
            completedAt: "2026-03-15T14:31:00Z",
          },
        ],
        scope: null,
        worktreeHash: "old-hash-that-no-longer-matches",
        startedAt: "2026-03-15T14:30:22Z",
        completedAt: null,
      }),
    );
    const result = checkStale(stateDir, TEST_DIR);
    expect(result).toBe(1);
  });

  it("compares against the last round's worktreeHash", () => {
    const stateDir = join(TEST_DIR, ".review-orchestra");
    mkdirSync(stateDir, { recursive: true });

    // .review-orchestra/ should be gitignored in real usage
    writeFileSync(join(TEST_DIR, ".gitignore"), ".review-orchestra/\n");
    git("add", ".gitignore");
    git("commit", "-m", "add gitignore");

    const currentHash = computeWorktreeHash(TEST_DIR);
    writeFileSync(
      join(stateDir, "session.json"),
      JSON.stringify({
        sessionId: "20260315-143022",
        status: "active",
        currentRound: 2,
        rounds: [
          {
            number: 1,
            phase: "complete",
            reviews: {},
            consolidated: [],
            worktreeHash: "round1-hash",
            startedAt: "2026-03-15T14:30:22Z",
            completedAt: "2026-03-15T14:31:00Z",
          },
          {
            number: 2,
            phase: "complete",
            reviews: {},
            consolidated: [],
            worktreeHash: currentHash,
            startedAt: "2026-03-15T14:35:00Z",
            completedAt: "2026-03-15T14:36:00Z",
          },
        ],
        scope: null,
        worktreeHash: currentHash,
        startedAt: "2026-03-15T14:30:22Z",
        completedAt: null,
      }),
    );
    // Should be fresh since current hash matches last round's hash
    const result = checkStale(stateDir, TEST_DIR);
    expect(result).toBe(0);
  });
});
