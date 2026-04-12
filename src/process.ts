import { spawn } from "child_process";
import { log } from "./log";

const DEFAULT_CATASTROPHIC_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const DEFAULT_INACTIVITY_TIMEOUT = 10 * 60 * 1000; // 10 minutes

export interface SpawnOptions {
  bin: string;
  args: string[];
  input?: string;
  env?: NodeJS.ProcessEnv;
  label: string;
  catastrophicTimeout?: number;
  inactivityTimeout?: number;
}

/**
 * Spawn a child process with streaming stderr, activity monitoring, and timeouts.
 * - stderr is streamed line-by-line to the review-orchestra log
 * - stdout is collected and returned as a string
 * - Inactivity timeout: kills process if no stdout/stderr for N ms
 * - Catastrophic timeout: kills process after N ms wall clock
 */
export function spawnWithStreaming(opts: SpawnOptions): Promise<string> {
  const {
    bin,
    args,
    input,
    env,
    label,
    catastrophicTimeout = DEFAULT_CATASTROPHIC_TIMEOUT,
    inactivityTimeout = DEFAULT_INACTIVITY_TIMEOUT,
  } = opts;

  if (!/^[a-zA-Z0-9._\-/]+$/.test(bin)) {
    return Promise.reject(new Error(`${label}: invalid binary name: ${bin}`));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    let catastrophicTimer: ReturnType<typeof setTimeout> | null = null;
    let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
    const startMs = Date.now();

    function cleanup() {
      if (catastrophicTimer) clearTimeout(catastrophicTimer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
    }

    function resetInactivityTimer() {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
        log(`${label}: inactivity timeout (no output for ${inactivityTimeout / 1000}s, elapsed ${elapsed}s) — killing process`);
        child.kill("SIGTERM");
        if (sigkillTimer) clearTimeout(sigkillTimer);
        sigkillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 5000);
      }, inactivityTimeout);
    }

    resetInactivityTimer();

    // Catastrophic wall clock timeout
    catastrophicTimer = setTimeout(() => {
      const elapsed = ((Date.now() - startMs) / 1000 / 60).toFixed(1);
      log(`${label}: catastrophic timeout (${elapsed} min) — killing process`);
      child.kill("SIGTERM");
      if (sigkillTimer) clearTimeout(sigkillTimer);
      sigkillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 5000);
    }, catastrophicTimeout);

    // Stream stderr line by line
    let stderrBuffer = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      resetInactivityTimer();
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          log(`${label}: ${line.trim()}`);
        }
      }
    });

    // Collect stdout
    child.stdout?.on("data", (chunk: Buffer) => {
      resetInactivityTimer();
      stdoutChunks.push(chunk);
    });

    // Write stdin and close
    if (input) {
      child.stdin?.write(input);
    }
    child.stdin?.end();

    child.on("close", (code) => {
      cleanup();
      // Flush remaining stderr
      if (stderrBuffer.trim()) {
        log(`${label}: ${stderrBuffer.trim()}`);
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${label} exited with code ${code}`));
      }
    });

    child.on("error", (err) => {
      cleanup();
      reject(new Error(`${label} failed to start: ${err.message}`));
    });
  });
}
