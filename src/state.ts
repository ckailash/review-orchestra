import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import type {
  DiffScope,
  Finding,
  OrchestratorState,
  ReviewOutput,
  Round,
  RoundPhase,
} from "./types";

function defaultState(): OrchestratorState {
  return {
    status: "idle",
    currentRound: 0,
    rounds: [],
    scope: null,
    startedAt: "",
    completedAt: null,
  };
}

function isValidState(obj: unknown): obj is OrchestratorState {
  if (typeof obj !== "object" || obj === null) return false;
  const s = obj as Record<string, unknown>;
  return (
    typeof s.status === "string" &&
    typeof s.currentRound === "number" &&
    Array.isArray(s.rounds)
  );
}

export class StateManager {
  private state: OrchestratorState;
  private stateFile: string;
  private lockFile: string;

  constructor(private stateDir: string) {
    this.stateFile = join(stateDir, "state.json");
    this.lockFile = join(stateDir, "state.lock");
    this.state = this.load();
  }

  private load(): OrchestratorState {
    if (!existsSync(this.stateFile)) return defaultState();

    try {
      const raw = readFileSync(this.stateFile, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (isValidState(parsed)) return parsed;
      return defaultState();
    } catch {
      return defaultState();
    }
  }

  getState(): OrchestratorState {
    return this.state;
  }

  start(scope: DiffScope): void {
    this.acquireLock();
    this.state.status = "running";
    this.state.scope = scope;
    this.state.startedAt = new Date().toISOString();
    this.persist();
  }

  newRound(): Round {
    const round: Round = {
      number: this.state.currentRound + 1,
      phase: "reviewing",
      reviews: {},
      consolidated: [],
      fixReport: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    this.state.currentRound = round.number;
    this.state.rounds.push(round);
    this.persist();
    return round;
  }

  getCurrentRound(): Round | undefined {
    return this.state.rounds[this.state.rounds.length - 1];
  }

  updatePhase(phase: RoundPhase): void {
    const round = this.getCurrentRound();
    if (round) {
      round.phase = phase;
      this.persist();
    }
  }

  saveReview(reviewer: string, output: ReviewOutput): void {
    const round = this.getCurrentRound();
    if (round) {
      round.reviews[reviewer] = output;
      this.persist();
    }
  }

  saveConsolidated(findings: Finding[]): void {
    const round = this.getCurrentRound();
    if (round) {
      round.consolidated = findings;
      this.persist();
    }
  }

  complete(): void {
    this.state.status = "completed";
    this.state.completedAt = new Date().toISOString();
    this.persist();
    this.releaseLock();
  }

  fail(): void {
    this.state.status = "failed";
    this.state.completedAt = new Date().toISOString();
    this.persist();
    this.releaseLock();
  }

  private persist(): void {
    mkdirSync(this.stateDir, { recursive: true });
    // Atomic write: write to tmp, then rename
    const tmpFile = join(this.stateDir, "state.json.tmp");
    writeFileSync(tmpFile, JSON.stringify(this.state, null, 2));
    renameSync(tmpFile, this.stateFile);
  }

  private acquireLock(): void {
    if (existsSync(this.lockFile)) {
      // Check if the lock is stale (PID no longer running)
      try {
        const lockPid = readFileSync(this.lockFile, "utf-8").trim();
        const pid = parseInt(lockPid, 10);
        if (!isNaN(pid)) {
          try {
            process.kill(pid, 0); // check if process exists
            throw new Error(
              `Another review-orchestra instance is running (PID ${pid}). ` +
                `Delete ${this.lockFile} if this is incorrect.`
            );
          } catch (e) {
            if (e instanceof Error && e.message.includes("Another review-orchestra")) {
              throw e;
            }
            // Process doesn't exist — stale lock, safe to remove
          }
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("Another review-orchestra")) {
          throw e;
        }
        // Can't read lock file — remove it
      }
      unlinkSync(this.lockFile);
    }
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(this.lockFile, String(process.pid));
  }

  private releaseLock(): void {
    try {
      if (existsSync(this.lockFile)) {
        unlinkSync(this.lockFile);
      }
    } catch {
      // Best effort
    }
  }
}
