import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { StateManager } from "../src/state";
import type { Finding, Round } from "../src/types";

const TEST_DIR = "/tmp/review-orchestra-test-state";

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("StateManager", () => {
  it("initializes with default state", () => {
    const sm = new StateManager(TEST_DIR);
    const state = sm.getState();
    expect(state.status).toBe("idle");
    expect(state.currentRound).toBe(0);
    expect(state.rounds).toEqual([]);
    expect(state.scope).toBeNull();
  });

  it("starts a session and sets status to running", () => {
    const sm = new StateManager(TEST_DIR);
    const scope = {
      type: "branch" as const,
      diff: "some diff",
      files: ["src/auth.ts"],
      baseBranch: "main",
      description: "branch feat/auth vs main",
    };
    sm.start(scope);
    const state = sm.getState();
    expect(state.status).toBe("running");
    expect(state.scope).toEqual(scope);
    expect(state.startedAt).toBeTruthy();
  });

  it("creates a new round and increments round number", () => {
    const sm = new StateManager(TEST_DIR);
    sm.start({
      type: "branch",
      diff: "",
      files: [],
      baseBranch: "main",
      description: "",
    });
    const round = sm.newRound();
    expect(round.number).toBe(1);
    expect(round.phase).toBe("reviewing");
    expect(sm.getState().currentRound).toBe(1);

    const round2 = sm.newRound();
    expect(round2.number).toBe(2);
    expect(sm.getState().currentRound).toBe(2);
  });

  it("updates the current round phase", () => {
    const sm = new StateManager(TEST_DIR);
    sm.start({
      type: "branch",
      diff: "",
      files: [],
      baseBranch: "main",
      description: "",
    });
    sm.newRound();
    sm.updatePhase("consolidating");
    expect(sm.getCurrentRound()?.phase).toBe("consolidating");
  });

  it("saves and loads reviews for a round", () => {
    const sm = new StateManager(TEST_DIR);
    sm.start({
      type: "branch",
      diff: "",
      files: [],
      baseBranch: "main",
      description: "",
    });
    sm.newRound();

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
    const sm = new StateManager(TEST_DIR);
    sm.start({
      type: "branch",
      diff: "",
      files: [],
      baseBranch: "main",
      description: "",
    });
    sm.newRound();

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

  it("persists state to disk and reloads", () => {
    const sm = new StateManager(TEST_DIR);
    sm.start({
      type: "branch",
      diff: "diff",
      files: ["a.ts"],
      baseBranch: "main",
      description: "test",
    });
    sm.newRound();
    sm.updatePhase("fixing");

    // Create a new StateManager pointing at the same dir — should load persisted state
    const sm2 = new StateManager(TEST_DIR);
    const state = sm2.getState();
    expect(state.status).toBe("running");
    expect(state.currentRound).toBe(1);
    expect(state.rounds[0].phase).toBe("fixing");
  });

  it("completes a session", () => {
    const sm = new StateManager(TEST_DIR);
    sm.start({
      type: "branch",
      diff: "",
      files: [],
      baseBranch: "main",
      description: "",
    });
    sm.newRound();
    sm.complete();
    const state = sm.getState();
    expect(state.status).toBe("completed");
    expect(state.completedAt).toBeTruthy();
  });
});
