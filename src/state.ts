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
  SessionState,
  ReviewOutput,
  Round,
  RoundPhase,
} from "./types";

export interface RecoveryInfo {
  isRecovery: boolean;
  phase?: RoundPhase;
  completedReviewers?: string[];
}

function defaultState(): SessionState {
  return {
    sessionId: "",
    status: "active",
    currentRound: 0,
    rounds: [],
    scope: null,
    worktreeHash: "",
    startedAt: "",
    completedAt: null,
  };
}

function generateSessionId(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

function isValidState(obj: unknown): obj is SessionState {
  if (typeof obj !== "object" || obj === null) return false;
  const s = obj as Record<string, unknown>;
  return (
    typeof s.status === "string" &&
    typeof s.currentRound === "number" &&
    Array.isArray(s.rounds)
  );
}

/**
 * Sentinel error thrown when another live review-orchestra instance holds
 * the lock. Caught and rethrown by `acquireLock` rather than relying on
 * substring matches against the user-facing message.
 */
class ConcurrentInstanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrentInstanceError";
  }
}

function hasScopeBaseChanged(
  existingScope: DiffScope | null,
  newScope: DiffScope,
): boolean {
  if (!existingScope) return false;
  if (
    existingScope.baseBranch !== newScope.baseBranch ||
    existingScope.type !== newScope.type
  ) {
    return true;
  }
  // Detect base branch HEAD changes via baseCommitSha
  if (
    existingScope.baseCommitSha &&
    newScope.baseCommitSha &&
    existingScope.baseCommitSha !== newScope.baseCommitSha
  ) {
    return true;
  }
  // Detect scope description changes (e.g., different commit ranges with
  // same base).
  if (existingScope.description !== newScope.description) {
    return true;
  }
  // Detect changes to the user-supplied path filter. NOTE: we deliberately
  // do NOT compare scope.files here — fixing a file removes it from the
  // diff between rounds while the underlying scope is unchanged.
  // pathFilters is the user's intent, not the diff's content.
  const existingFilters = [...(existingScope.pathFilters ?? [])].sort().join("|");
  const newFilters = [...(newScope.pathFilters ?? [])].sort().join("|");
  if (existingFilters !== newFilters) {
    return true;
  }
  return false;
}

export class SessionManager {
  private state: SessionState;
  private sessionFile: string;
  private lockFile: string;

  constructor(private stateDir: string) {
    this.sessionFile = join(stateDir, "session.json");
    this.lockFile = join(stateDir, "state.lock");
    this.state = this.load();
  }

  private load(): SessionState {
    const tmpFile = join(this.stateDir, "session.json.tmp");

    // Handle corrupted state: if tmp exists but session.json doesn't, discard tmp
    if (existsSync(tmpFile) && !existsSync(this.sessionFile)) {
      try {
        unlinkSync(tmpFile);
      } catch {
        // Best effort
      }
      return defaultState();
    }

    if (!existsSync(this.sessionFile)) return defaultState();

    try {
      const raw = readFileSync(this.sessionFile, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (isValidState(parsed)) return parsed;
      return defaultState();
    } catch {
      return defaultState();
    }
  }

  getState(): SessionState {
    return this.state;
  }

  startOrContinue(scope: DiffScope): RecoveryInfo {
    this.acquireLock();

    // Check if there's an existing active session
    if (this.state.status === "active" && this.state.sessionId) {
      // Check for session auto-expiry: scope base changed
      if (hasScopeBaseChanged(this.state.scope, scope)) {
        this.state.status = "expired";
        try {
          this.persist();
        } finally {
          this.releaseLock();
        }
        throw new Error(
          "Session expired: scope base has changed. Run `review-orchestra reset` to start a new session.",
        );
      }

      // Check for crash recovery: is there an incomplete round?
      const currentRound = this.state.rounds[this.state.rounds.length - 1];
      if (currentRound && currentRound.phase !== "complete") {
        // Incomplete round from a crash — return recovery info
        const completedReviewers = Object.keys(currentRound.reviews);
        this.persist();
        return {
          isRecovery: true,
          phase: currentRound.phase,
          completedReviewers,
        };
      }

      // Active session with all rounds complete — continue session
      this.persist();
      return { isRecovery: false };
    }

    // No active session (or status is not 'active') — create new session
    this.state = defaultState();
    this.state.sessionId = generateSessionId();
    this.state.status = "active";
    this.state.scope = scope;
    this.state.startedAt = new Date().toISOString();
    this.persist();
    return { isRecovery: false };
  }

  newRound(worktreeHash: string): Round {
    const round: Round = {
      number: this.state.currentRound + 1,
      phase: "reviewing",
      reviews: {},
      consolidated: [],
      worktreeHash,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    this.state.currentRound = round.number;
    this.state.worktreeHash = worktreeHash;
    this.state.rounds.push(round);
    this.persist();
    return round;
  }

  getCurrentRound(): Round | undefined {
    return this.state.rounds[this.state.rounds.length - 1];
  }

  getPreviousRound(): Round | undefined {
    if (this.state.rounds.length < 2) return undefined;
    return this.state.rounds[this.state.rounds.length - 2];
  }

  updatePhase(phase: RoundPhase): void {
    const round = this.getCurrentRound();
    if (round) {
      round.phase = phase;
      if (phase === "complete") {
        round.completedAt = new Date().toISOString();
      }
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

  markFindingsPersisted(): void {
    const round = this.getCurrentRound();
    if (round) {
      round.findingsPersisted = true;
      this.persist();
    }
  }

  fail(): void {
    // Keep session active so the user can retry after failure.
    // releaseLock runs in finally so a persist failure (e.g. disk full)
    // doesn't leave the lock held.
    try {
      this.persist();
    } finally {
      this.releaseLock();
    }
  }

  private persist(): void {
    mkdirSync(this.stateDir, { recursive: true });
    // Atomic write: write to tmp, then rename
    const tmpFile = join(this.stateDir, "session.json.tmp");
    writeFileSync(tmpFile, JSON.stringify(this.state, null, 2));
    renameSync(tmpFile, this.sessionFile);
  }

  private acquireLock(): void {
    mkdirSync(this.stateDir, { recursive: true });
    try {
      // Atomic create — fails with EEXIST if the file already exists
      writeFileSync(this.lockFile, String(process.pid), { flag: "wx" });
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        // Lock file exists — check if the holder is still alive
        try {
          const lockPid = readFileSync(this.lockFile, "utf-8").trim();
          const pid = parseInt(lockPid, 10);
          if (!isNaN(pid)) {
            try {
              process.kill(pid, 0);
              throw new ConcurrentInstanceError(
                `Another review-orchestra instance is running (PID ${pid}). ` +
                  `Delete ${this.lockFile} if this is incorrect.`,
              );
            } catch (e) {
              if (e instanceof ConcurrentInstanceError) throw e;
              // EPERM means the process exists but is owned by another user
              // — still a live lock, not a stale one. Only ESRCH (no such
              // process) means the holder is gone and the lock is safe to
              // overwrite. Other error codes are treated conservatively as
              // "live" too.
              const code =
                e && typeof e === "object" && "code" in e
                  ? (e as NodeJS.ErrnoException).code
                  : undefined;
              if (code !== "ESRCH") {
                throw new ConcurrentInstanceError(
                  `Another review-orchestra instance is running (PID ${pid}, ` +
                    `signal check returned ${code ?? "unknown"}). ` +
                    `Delete ${this.lockFile} if this is incorrect.`,
                );
              }
              // ESRCH — process gone, stale lock, safe to overwrite
            }
          }
        } catch (e) {
          if (e instanceof ConcurrentInstanceError) throw e;
          // Can't read lock file — treat as stale
        }
        // Stale lock — remove it and try to reacquire atomically
        try {
          unlinkSync(this.lockFile);
        } catch {
          // Another process may have already removed it — ignore
        }
        try {
          writeFileSync(this.lockFile, String(process.pid), { flag: "wx" });
        } catch (retryErr) {
          // Another instance raced in between the unlink and retry.
          if (
            retryErr &&
            typeof retryErr === "object" &&
            "code" in retryErr &&
            (retryErr as NodeJS.ErrnoException).code === "EEXIST"
          ) {
            let racingPid: number | null = null;
            try {
              racingPid = parseInt(readFileSync(this.lockFile, "utf-8").trim(), 10);
            } catch {
              // Can't read — fall through with null
            }
            if (racingPid && !isNaN(racingPid)) {
              throw new ConcurrentInstanceError(
                `Another review-orchestra instance is running (PID ${racingPid}). ` +
                  `Delete ${this.lockFile} if this is incorrect.`,
              );
            }
            throw new ConcurrentInstanceError(
              `Lock contention on ${this.lockFile} — another instance may be starting. Retry in a moment.`,
            );
          }
          throw retryErr;
        }
      } else {
        throw err;
      }
    }
  }

  releaseLock(): void {
    try {
      if (!existsSync(this.lockFile)) return;
      // Only delete if we own the lock — prevents a recovering process from
      // stealing another instance's lock if the lock was overwritten.
      const lockPid = parseInt(readFileSync(this.lockFile, "utf-8").trim(), 10);
      if (!isNaN(lockPid) && lockPid !== process.pid) return;
      unlinkSync(this.lockFile);
    } catch {
      // Best effort
    }
  }
}
