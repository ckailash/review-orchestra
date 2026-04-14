import { spawn } from "child_process";
import { log } from "./log";

// Bare binary name: alphanumerics, dots, underscores, hyphens. Path
// separators are NOT allowed here — those go through the absolute-path
// branch below.
const BARE_BIN_PATTERN = /^[a-zA-Z0-9._-]+$/;

// Path-traversal segments (`..` as a full segment in a path) are rejected
// even within absolute paths so a config can't quietly walk out of an
// expected directory.
const PATH_TRAVERSAL_PATTERN = /(^|[\\/])\.\.([\\/]|$)/;

function looksLikeAbsolutePath(bin: string): boolean {
  if (bin.startsWith("/")) return true;
  // Windows: drive-letter (C:\... or C:/...) and UNC (\\server\share)
  if (/^[a-zA-Z]:[\\/]/.test(bin)) return true;
  if (bin.startsWith("\\\\")) return true;
  return false;
}

/**
 * Decide whether a `bin` value is safe to pass to `spawn`. We accept two
 * shapes:
 *  - a bare name matching BARE_BIN_PATTERN, or
 *  - an absolute path (Unix `/...`, Windows `C:\...`, UNC `\\...`) that
 *    is free of shell metacharacters and path-traversal segments.
 *
 * `spawn` itself does not invoke a shell, so this check is defence in
 * depth against a malicious config rather than a strict requirement, but
 * it keeps the surface area small.
 */
function isAcceptableBin(bin: string): boolean {
  if (looksLikeAbsolutePath(bin)) {
    if (PATH_TRAVERSAL_PATTERN.test(bin)) return false;
    // Reject characters that could be misinterpreted by a shell or that
    // are not valid in any realistic path (NUL, control chars).
    if (/[\x00-\x1f"`$|;&<>*?]/.test(bin)) return false;
    return true;
  }
  return BARE_BIN_PATTERN.test(bin);
}

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

  if (!isAcceptableBin(bin)) {
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

    // Write stdin and close. Attach an error listener so EPIPE (child exits
    // before consuming stdin) is absorbed here — the close handler below
    // reports the non-zero exit/signal as a rejected promise.
    child.stdin?.on("error", () => {});
    if (input && child.stdin) {
      // Use Writable.end(chunk) so Node handles backpressure for us:
      // for large payloads it buffers and drains correctly rather than
      // forcing a synchronous write that ignores the high-water mark.
      child.stdin.end(input);
    } else {
      child.stdin?.end();
    }

    child.on("close", (code, signal) => {
      cleanup();
      // Flush remaining stderr
      if (stderrBuffer.trim()) {
        log(`${label}: ${stderrBuffer.trim()}`);
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      if (code === 0) {
        resolve(stdout);
      } else if (signal) {
        reject(new Error(`${label} killed by signal ${signal}`));
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
