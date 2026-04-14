/**
 * When the orchestrator runs from inside a Claude Code session, child
 * `claude -p` invocations would inherit the parent's session env vars and
 * misbehave as if they were nested sessions. Strip them before spawning.
 */
const NESTED_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
] as const;

export function stripNestedSessionEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of NESTED_SESSION_VARS) {
    delete env[key];
  }
  return env;
}
