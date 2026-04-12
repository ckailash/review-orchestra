import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { SessionManager } from "../src/state";
import type { DiffScope, Finding, Round, SessionState } from "../src/types";

const TEST_DIR = "/tmp/review-orchestra-test-state";

const makeScope = (overrides: Partial<DiffScope> = {}): DiffScope => ({
  type: "branch",
  diff: "some diff",
  files: ["src/auth.ts"],
  baseBranch: "main",
  description: "branch feat/auth vs main",
  ...overrides,
});

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("SessionManager", () => {
  // --- Session Creation ---
  describe("session creation", () => {
    it("creates a new session with timestamp-based sessionId (YYYYMMDD-HHMMSS)", () => {
      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      const state = sm.getState();
      expect(state.sessionId).toMatch(/^\d{8}-\d{6}$/);
      expect(state.status).toBe("active");
      expect(state.currentRound).toBe(0);
      expect(state.rounds).toEqual([]);
      expect(state.scope).toEqual(makeScope());
      expect(state.startedAt).toBeTruthy();
    });

    it("generates sessionId from current timestamp", () => {
      const fakeNow = new Date("2026-03-15T14:30:22.000Z");
      vi.setSystemTime(fakeNow);

      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      const state = sm.getState();
      // UTC: 2026-03-15 14:30:22
      expect(state.sessionId).toBe("20260315-143022");

      vi.useRealTimers();
    });

    it("creates a new session when no session.json exists", () => {
      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      expect(sm.getState().status).toBe("active");
      expect(existsSync(join(TEST_DIR, "session.json"))).toBe(true);
    });

    it("creates a new session when session.json exists with non-active status", () => {
      // Write a completed session
      const completedState: SessionState = {
        sessionId: "20260315-100000",
        status: "completed",
        currentRound: 1,
        rounds: [],
        scope: makeScope(),
        worktreeHash: "abc",
        startedAt: "2026-03-15T10:00:00Z",
        completedAt: "2026-03-15T10:05:00Z",
      };
      writeFileSync(
        join(TEST_DIR, "session.json"),
        JSON.stringify(completedState, null, 2),
      );

      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      const state = sm.getState();
      expect(state.status).toBe("active");
      // Should have a new sessionId, not the old one
      expect(state.sessionId).not.toBe("20260315-100000");
    });
  });

  // --- Session Continuation ---
  describe("session continuation", () => {
    it("continues an active session by incrementing round", () => {
      // Create initial session with one complete round
      const activeState: SessionState = {
        sessionId: "20260315-143022",
        status: "active",
        currentRound: 1,
        rounds: [
          {
            number: 1,
            phase: "complete",
            reviews: {},
            consolidated: [],
            worktreeHash: "hash1",
            startedAt: "2026-03-15T14:30:22Z",
            completedAt: "2026-03-15T14:31:00Z",
          },
        ],
        scope: makeScope(),
        worktreeHash: "hash1",
        startedAt: "2026-03-15T14:30:22Z",
        completedAt: null,
      };
      writeFileSync(
        join(TEST_DIR, "session.json"),
        JSON.stringify(activeState, null, 2),
      );

      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      const state = sm.getState();
      expect(state.sessionId).toBe("20260315-143022");
      expect(state.status).toBe("active");
      // currentRound should still be 1 until newRound() is called
      expect(state.currentRound).toBe(1);
    });

    it("preserves sessionId when continuing a session", () => {
      const activeState: SessionState = {
        sessionId: "20260315-143022",
        status: "active",
        currentRound: 1,
        rounds: [
          {
            number: 1,
            phase: "complete",
            reviews: {},
            consolidated: [],
            worktreeHash: "hash1",
            startedAt: "2026-03-15T14:30:22Z",
            completedAt: "2026-03-15T14:31:00Z",
          },
        ],
        scope: makeScope(),
        worktreeHash: "hash1",
        startedAt: "2026-03-15T14:30:22Z",
        completedAt: null,
      };
      writeFileSync(
        join(TEST_DIR, "session.json"),
        JSON.stringify(activeState, null, 2),
      );

      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      expect(sm.getState().sessionId).toBe("20260315-143022");
    });

    it("preserves previous rounds when continuing", () => {
      const round1: Round = {
        number: 1,
        phase: "complete",
        reviews: {},
        consolidated: [],
        worktreeHash: "hash1",
        startedAt: "2026-03-15T14:30:22Z",
        completedAt: "2026-03-15T14:31:00Z",
      };
      const activeState: SessionState = {
        sessionId: "20260315-143022",
        status: "active",
        currentRound: 1,
        rounds: [round1],
        scope: makeScope(),
        worktreeHash: "hash1",
        startedAt: "2026-03-15T14:30:22Z",
        completedAt: null,
      };
      writeFileSync(
        join(TEST_DIR, "session.json"),
        JSON.stringify(activeState, null, 2),
      );

      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      expect(sm.getState().rounds).toHaveLength(1);
      expect(sm.getState().rounds[0].number).toBe(1);
    });
  });

  // --- Session Continuation Across Invocations ---
  describe("session continuation across invocations", () => {
    it("session stays active after round completes with releaseLock (simulates orchestrator.run)", () => {
      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      sm.newRound("hash1");
      sm.updatePhase("reviewing");
      sm.updatePhase("consolidating");
      sm.updatePhase("complete");
      sm.releaseLock();

      // Session should still be active
      const state = sm.getState();
      expect(state.status).toBe("active");
      expect(state.currentRound).toBe(1);
    });

    it("next invocation continues the existing session after releaseLock", () => {
      // First invocation: create session and complete round
      const sm1 = new SessionManager(TEST_DIR);
      sm1.startOrContinue(makeScope());
      sm1.newRound("hash1");
      sm1.updatePhase("complete");
      sm1.releaseLock();

      // Second invocation: should continue same session
      const sm2 = new SessionManager(TEST_DIR);
      const recovery = sm2.startOrContinue(makeScope());
      expect(recovery.isRecovery).toBe(false);
      expect(sm2.getState().sessionId).toBe(sm1.getState().sessionId);
      expect(sm2.getState().status).toBe("active");

      // Can create round 2
      const round2 = sm2.newRound("hash2");
      expect(round2.number).toBe(2);
    });

    it("finding comparison works across invocations (persisting/resolved detected)", () => {
      // First invocation: create session, round 1 with findings
      const sm1 = new SessionManager(TEST_DIR);
      sm1.startOrContinue(makeScope());
      sm1.newRound("hash1");
      sm1.saveConsolidated([
        {
          id: "r1-f-001",
          file: "src/auth.ts",
          line: 42,
          confidence: "verified",
          impact: "critical",
          severity: "p0",
          category: "security",
          title: "SQL injection",
          description: "Bad",
          suggestion: "Fix",
          reviewer: "claude",
          pre_existing: false,
          status: "new",
        },
      ]);
      sm1.updatePhase("complete");
      sm1.releaseLock();

      // Second invocation: continue session, round 2
      const sm2 = new SessionManager(TEST_DIR);
      sm2.startOrContinue(makeScope());
      const round2 = sm2.newRound("hash2");
      expect(round2.number).toBe(2);

      // Previous round's findings should be accessible
      const prevRound = sm2.getPreviousRound();
      expect(prevRound).toBeDefined();
      expect(prevRound!.consolidated).toHaveLength(1);
      expect(prevRound!.consolidated[0].id).toBe("r1-f-001");
    });
  });

  // --- Session Auto-Expiry ---
  describe("session auto-expiry", () => {
    it("expires session when scope baseBranch changes", () => {
      const activeState: SessionState = {
        sessionId: "20260315-143022",
        status: "active",
        currentRound: 1,
        rounds: [
          {
            number: 1,
            phase: "complete",
            reviews: {},
            consolidated: [],
            worktreeHash: "hash1",
            startedAt: "2026-03-15T14:30:22Z",
            completedAt: "2026-03-15T14:31:00Z",
          },
        ],
        scope: makeScope({ baseBranch: "main" }),
        worktreeHash: "hash1",
        startedAt: "2026-03-15T14:30:22Z",
        completedAt: null,
      };
      writeFileSync(
        join(TEST_DIR, "session.json"),
        JSON.stringify(activeState, null, 2),
      );

      const sm = new SessionManager(TEST_DIR);
      // Scope base has changed from "main" to "develop"
      expect(() =>
        sm.startOrContinue(makeScope({ baseBranch: "develop" })),
      ).toThrow(/expired|reset/i);

      // Session should be marked expired
      const persisted = JSON.parse(
        readFileSync(join(TEST_DIR, "session.json"), "utf-8"),
      );
      expect(persisted.status).toBe("expired");
    });

    it("expires session when baseCommitSha changes (base branch HEAD updated)", () => {
      const activeState: SessionState = {
        sessionId: "20260315-143022",
        status: "active",
        currentRound: 1,
        rounds: [
          {
            number: 1,
            phase: "complete",
            reviews: {},
            consolidated: [],
            worktreeHash: "hash1",
            startedAt: "2026-03-15T14:30:22Z",
            completedAt: "2026-03-15T14:31:00Z",
          },
        ],
        scope: makeScope({ baseBranch: "main", baseCommitSha: "abc123" }),
        worktreeHash: "hash1",
        startedAt: "2026-03-15T14:30:22Z",
        completedAt: null,
      };
      writeFileSync(
        join(TEST_DIR, "session.json"),
        JSON.stringify(activeState, null, 2),
      );

      const sm = new SessionManager(TEST_DIR);
      // Same baseBranch name but different commit SHA — base branch got new commits
      expect(() =>
        sm.startOrContinue(makeScope({ baseBranch: "main", baseCommitSha: "def456" })),
      ).toThrow(/expired|reset/i);

      const persisted = JSON.parse(
        readFileSync(join(TEST_DIR, "session.json"), "utf-8"),
      );
      expect(persisted.status).toBe("expired");
    });

    it("does not expire when baseCommitSha is not present in either scope", () => {
      const activeState: SessionState = {
        sessionId: "20260315-143022",
        status: "active",
        currentRound: 1,
        rounds: [
          {
            number: 1,
            phase: "complete",
            reviews: {},
            consolidated: [],
            worktreeHash: "hash1",
            startedAt: "2026-03-15T14:30:22Z",
            completedAt: "2026-03-15T14:31:00Z",
          },
        ],
        scope: makeScope({ baseBranch: "main" }),
        worktreeHash: "hash1",
        startedAt: "2026-03-15T14:30:22Z",
        completedAt: null,
      };
      writeFileSync(
        join(TEST_DIR, "session.json"),
        JSON.stringify(activeState, null, 2),
      );

      const sm = new SessionManager(TEST_DIR);
      // No baseCommitSha on either side — should not expire
      expect(() =>
        sm.startOrContinue(makeScope({ baseBranch: "main" })),
      ).not.toThrow();
    });

    it("expires session when scope description changes (e.g., different commit ranges)", () => {
      const activeState: SessionState = {
        sessionId: "20260315-143022",
        status: "active",
        currentRound: 1,
        rounds: [
          {
            number: 1,
            phase: "complete",
            reviews: {},
            consolidated: [],
            worktreeHash: "hash1",
            startedAt: "2026-03-15T14:30:22Z",
            completedAt: "2026-03-15T14:31:00Z",
          },
        ],
        scope: makeScope({
          type: "commit",
          baseBranch: "main",
          baseCommitSha: "abc123",
          description: "Changes in abc1234..def5678",
        }),
        worktreeHash: "hash1",
        startedAt: "2026-03-15T14:30:22Z",
        completedAt: null,
      };
      writeFileSync(
        join(TEST_DIR, "session.json"),
        JSON.stringify(activeState, null, 2),
      );

      const sm = new SessionManager(TEST_DIR);
      // Same type, baseBranch, baseCommitSha — but different description
      expect(() =>
        sm.startOrContinue(
          makeScope({
            type: "commit",
            baseBranch: "main",
            baseCommitSha: "abc123",
            description: "Changes in abc1234..fed8765",
          }),
        ),
      ).toThrow(/expired|reset/i);

      const persisted = JSON.parse(
        readFileSync(join(TEST_DIR, "session.json"), "utf-8"),
      );
      expect(persisted.status).toBe("expired");
    });

    it("releases lock when session expires due to scope base change", () => {
      const activeState: SessionState = {
        sessionId: "20260315-143022",
        status: "active",
        currentRound: 1,
        rounds: [
          {
            number: 1,
            phase: "complete",
            reviews: {},
            consolidated: [],
            worktreeHash: "hash1",
            startedAt: "2026-03-15T14:30:22Z",
            completedAt: "2026-03-15T14:31:00Z",
          },
        ],
        scope: makeScope({ baseBranch: "main" }),
        worktreeHash: "hash1",
        startedAt: "2026-03-15T14:30:22Z",
        completedAt: null,
      };
      writeFileSync(
        join(TEST_DIR, "session.json"),
        JSON.stringify(activeState, null, 2),
      );

      const sm = new SessionManager(TEST_DIR);
      // Scope base has changed from "main" to "develop" — should throw
      expect(() =>
        sm.startOrContinue(makeScope({ baseBranch: "develop" })),
      ).toThrow(/expired|reset/i);

      // Lock file (state.lock) should NOT exist after the throw
      expect(existsSync(join(TEST_DIR, "state.lock"))).toBe(false);
    });

    it("expires session when scope type changes", () => {
      const activeState: SessionState = {
        sessionId: "20260315-143022",
        status: "active",
        currentRound: 1,
        rounds: [
          {
            number: 1,
            phase: "complete",
            reviews: {},
            consolidated: [],
            worktreeHash: "hash1",
            startedAt: "2026-03-15T14:30:22Z",
            completedAt: "2026-03-15T14:31:00Z",
          },
        ],
        scope: makeScope({ type: "branch", baseBranch: "main" }),
        worktreeHash: "hash1",
        startedAt: "2026-03-15T14:30:22Z",
        completedAt: null,
      };
      writeFileSync(
        join(TEST_DIR, "session.json"),
        JSON.stringify(activeState, null, 2),
      );

      const sm = new SessionManager(TEST_DIR);
      expect(() =>
        sm.startOrContinue(makeScope({ type: "commit", baseBranch: "main" })),
      ).toThrow(/expired|reset/i);
    });
  });

  // --- Crash Recovery ---
  describe("crash recovery", () => {
    it("detects incomplete round with reviewing phase", () => {
      const activeState: SessionState = {
        sessionId: "20260315-143022",
        status: "active",
        currentRound: 1,
        rounds: [
          {
            number: 1,
            phase: "reviewing",
            reviews: {
              claude: {
                findings: [],
                metadata: {
                  reviewer: "claude",
                  round: 1,
                  timestamp: "2026-03-15T14:30:22Z",
                  files_reviewed: 1,
                  diff_scope: "test",
                },
              },
            },
            consolidated: [],
            worktreeHash: "hash1",
            startedAt: "2026-03-15T14:30:22Z",
            completedAt: null,
          },
        ],
        scope: makeScope(),
        worktreeHash: "hash1",
        startedAt: "2026-03-15T14:30:22Z",
        completedAt: null,
      };
      writeFileSync(
        join(TEST_DIR, "session.json"),
        JSON.stringify(activeState, null, 2),
      );

      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      const state = sm.getState();
      // Should continue with the same session and same round
      expect(state.sessionId).toBe("20260315-143022");
      expect(state.currentRound).toBe(1);
      // The incomplete round should still be there
      expect(state.rounds).toHaveLength(1);
      expect(state.rounds[0].phase).toBe("reviewing");
    });

    it("returns completed reviewers from incomplete round for skipping", () => {
      const activeState: SessionState = {
        sessionId: "20260315-143022",
        status: "active",
        currentRound: 1,
        rounds: [
          {
            number: 1,
            phase: "reviewing",
            reviews: {
              claude: {
                findings: [],
                metadata: {
                  reviewer: "claude",
                  round: 1,
                  timestamp: "2026-03-15T14:30:22Z",
                  files_reviewed: 1,
                  diff_scope: "test",
                },
              },
            },
            consolidated: [],
            worktreeHash: "hash1",
            startedAt: "2026-03-15T14:30:22Z",
            completedAt: null,
          },
        ],
        scope: makeScope(),
        worktreeHash: "hash1",
        startedAt: "2026-03-15T14:30:22Z",
        completedAt: null,
      };
      writeFileSync(
        join(TEST_DIR, "session.json"),
        JSON.stringify(activeState, null, 2),
      );

      const sm = new SessionManager(TEST_DIR);
      const recovery = sm.startOrContinue(makeScope());
      expect(recovery.isRecovery).toBe(true);
      expect(recovery.completedReviewers).toContain("claude");
      expect(recovery.phase).toBe("reviewing");
    });

    it("detects incomplete round with consolidating phase", () => {
      const activeState: SessionState = {
        sessionId: "20260315-143022",
        status: "active",
        currentRound: 1,
        rounds: [
          {
            number: 1,
            phase: "consolidating",
            reviews: {
              claude: {
                findings: [],
                metadata: {
                  reviewer: "claude",
                  round: 1,
                  timestamp: "2026-03-15T14:30:22Z",
                  files_reviewed: 1,
                  diff_scope: "test",
                },
              },
            },
            consolidated: [],
            worktreeHash: "hash1",
            startedAt: "2026-03-15T14:30:22Z",
            completedAt: null,
          },
        ],
        scope: makeScope(),
        worktreeHash: "hash1",
        startedAt: "2026-03-15T14:30:22Z",
        completedAt: null,
      };
      writeFileSync(
        join(TEST_DIR, "session.json"),
        JSON.stringify(activeState, null, 2),
      );

      const sm = new SessionManager(TEST_DIR);
      const recovery = sm.startOrContinue(makeScope());
      expect(recovery.isRecovery).toBe(true);
      expect(recovery.phase).toBe("consolidating");
    });
  });

  // --- Worktree Hash Per Round ---
  describe("worktree hash per round", () => {
    it("stores worktreeHash on new round", () => {
      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      const round = sm.newRound("abc123");
      expect(round.worktreeHash).toBe("abc123");
      expect(sm.getState().worktreeHash).toBe("abc123");
    });

    it("updates top-level worktreeHash when new round starts", () => {
      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      sm.newRound("hash1");
      sm.updatePhase("complete");
      sm.newRound("hash2");
      expect(sm.getState().worktreeHash).toBe("hash2");
    });
  });

  // --- Round Management ---
  describe("round management", () => {
    it("creates a new round and increments round number", () => {
      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      const round = sm.newRound("hash1");
      expect(round.number).toBe(1);
      expect(round.phase).toBe("reviewing");
      expect(sm.getState().currentRound).toBe(1);

      sm.updatePhase("complete");
      const round2 = sm.newRound("hash2");
      expect(round2.number).toBe(2);
      expect(sm.getState().currentRound).toBe(2);
    });

    it("updates the current round phase", () => {
      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      sm.newRound("hash1");
      sm.updatePhase("consolidating");
      expect(sm.getCurrentRound()?.phase).toBe("consolidating");
    });

    it("saves and loads reviews for a round", () => {
      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      sm.newRound("hash1");

      const findings: Finding[] = [
        {
          id: "f-001",
          file: "src/auth.ts",
          line: 42,
          confidence: "verified",
          impact: "critical",
          severity: "p0",
          category: "security",
          title: "SQL injection",
          description: "Bad",
          suggestion: "Fix",
          reviewer: "claude",
          pre_existing: false,
        },
      ];

      sm.saveReview("claude", {
        findings,
        metadata: {
          reviewer: "claude",
          round: 1,
          timestamp: "2026-03-13T10:00:00Z",
          files_reviewed: 5,
          diff_scope: "branch:feat/auth vs main",
        },
      });

      const round = sm.getCurrentRound();
      expect(round?.reviews.claude.findings).toHaveLength(1);
      expect(round?.reviews.claude.findings[0].id).toBe("f-001");
    });

    it("saves consolidated findings for a round", () => {
      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      sm.newRound("hash1");

      const consolidated: Finding[] = [
        {
          id: "f-001",
          file: "src/auth.ts",
          line: 42,
          confidence: "verified",
          impact: "critical",
          severity: "p0",
          category: "security",
          title: "SQL injection",
          description: "Bad",
          suggestion: "Fix",
          reviewer: "claude",
          pre_existing: false,
        },
      ];

      sm.saveConsolidated(consolidated);
      expect(sm.getCurrentRound()?.consolidated).toHaveLength(1);
    });
  });

  // --- Persistence ---
  describe("persistence", () => {
    it("persists state to session.json and reloads", () => {
      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      sm.newRound("hash1");
      sm.updatePhase("consolidating");

      // Create a new SessionManager pointing at the same dir — should load persisted state
      const sm2 = new SessionManager(TEST_DIR);
      const state = sm2.getState();
      expect(state.status).toBe("active");
      expect(state.currentRound).toBe(1);
      expect(state.rounds[0].phase).toBe("consolidating");
    });

    it("uses session.json as the state file", () => {
      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      expect(existsSync(join(TEST_DIR, "session.json"))).toBe(true);
    });

    it("uses atomic writes (tmp + rename pattern)", () => {
      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      // The tmp file should not be left behind after persist
      expect(existsSync(join(TEST_DIR, "session.json.tmp"))).toBe(false);
      expect(existsSync(join(TEST_DIR, "session.json"))).toBe(true);
    });

    it("handles corrupted state: discards tmp when session.json is missing", () => {
      // Write a tmp file but no session.json
      writeFileSync(
        join(TEST_DIR, "session.json.tmp"),
        '{"partial": true}',
      );

      const sm = new SessionManager(TEST_DIR);
      // Should discard tmp and start fresh
      const state = sm.getState();
      expect(state.sessionId).toBe("");
      expect(state.currentRound).toBe(0);
    });
  });

  // --- Completion ---
  describe("completion", () => {
    it("completes a session", () => {
      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      sm.newRound("hash1");
      sm.complete();
      const state = sm.getState();
      expect(state.status).toBe("completed");
      expect(state.completedAt).toBeTruthy();
    });

    it("fails a session (keeps active status for retry)", () => {
      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      sm.newRound("hash1");
      sm.fail();
      const state = sm.getState();
      expect(state.status).toBe("active");
    });
  });

  // --- Concurrent Run Prevention ---
  describe("concurrent run prevention", () => {
    it("acquires lock on session start", () => {
      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      expect(existsSync(join(TEST_DIR, "state.lock"))).toBe(true);
    });

    it("releases lock on completion", () => {
      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      sm.newRound("hash1");
      sm.complete();
      expect(existsSync(join(TEST_DIR, "state.lock"))).toBe(false);
    });

    it("releases lock without changing session status via releaseLock()", () => {
      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      sm.newRound("hash1");
      sm.updatePhase("complete");
      sm.releaseLock();
      expect(existsSync(join(TEST_DIR, "state.lock"))).toBe(false);
      expect(sm.getState().status).toBe("active");
    });

    it("releases lock on failure without changing session status", () => {
      const sm = new SessionManager(TEST_DIR);
      sm.startOrContinue(makeScope());
      sm.newRound("hash1");
      sm.fail();
      expect(existsSync(join(TEST_DIR, "state.lock"))).toBe(false);
      expect(sm.getState().status).toBe("active");
    });

    it("throws when lock held by a live process", () => {
      // Write the lock file with the current process PID (definitely alive)
      writeFileSync(join(TEST_DIR, "state.lock"), String(process.pid));
      const sm = new SessionManager(TEST_DIR);
      expect(() => sm.startOrContinue(makeScope())).toThrow(
        "Another review-orchestra instance is running",
      );
    });

    it("overwrites stale lock from dead PID", () => {
      // Write a lock file with a PID that doesn't exist
      writeFileSync(join(TEST_DIR, "state.lock"), "999999999");
      const sm = new SessionManager(TEST_DIR);
      // Should succeed — stale lock is overwritten
      expect(() => sm.startOrContinue(makeScope())).not.toThrow();
    });
  });
});
