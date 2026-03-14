/**
 * Structured stderr logging for review-orchestra.
 * All output goes to stderr so stdout stays clean for JSON results.
 */

const PREFIX = "[review-orchestra]";

export function log(message: string): void {
  console.error(`${PREFIX} ${message}`);
}

export function logCommand(label: string, bin: string, args: string[]): void {
  const cmd = [bin, ...args].join(" ");
  // Truncate long commands (prompts piped via stdin aren't shown)
  const display = cmd.length > 120 ? cmd.slice(0, 120) + "..." : cmd;
  console.error(`${PREFIX} ${label}: ${display}`);
}

export function logTiming(label: string, startMs: number): void {
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.error(`${PREFIX} ${label} (${elapsed}s)`);
}
