# dogfood fixture

The file used during initial dogfood testing of review-orchestra. Contains 3 planted security vulnerabilities:

1. **Command injection** — `execSync` with unsanitized user input interpolated into a shell command
2. **Path traversal** — `readFileSync` with unconstrained file path from user input
3. **Hardcoded credentials** — API key embedded as a string literal in source code

All 3 were successfully detected by both Claude and Codex reviewers during initial dogfood testing, and the fixer applied correct fixes.
