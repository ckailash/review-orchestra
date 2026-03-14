/**
 * Shared JSON extraction and CLI envelope unwrapping.
 * Used by both reviewer-parser.ts and fixer.ts to handle
 * raw output from headless claude/codex CLI calls.
 */

/**
 * Try to parse a balanced JSON value starting at `raw[startIdx]`.
 * Uses a brace/bracket walker that respects string literals.
 * Returns the parsed value or null.
 */
function tryBalancedParse(raw: string, startIdx: number): unknown | null {
  const openChar = raw[startIdx];
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(startIdx, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Try all occurrences of `char` in `raw` as JSON start positions.
 * Returns the first successfully parsed value, or null.
 */
function tryAllOccurrences(raw: string, char: string): unknown | null {
  let searchFrom = 0;
  while (true) {
    const idx = raw.indexOf(char, searchFrom);
    if (idx === -1) break;

    // Try parsing from this position to end of string
    try {
      return JSON.parse(raw.slice(idx));
    } catch {
      // noop
    }

    // Try balanced extraction
    const result = tryBalancedParse(raw, idx);
    if (result !== null) return result;

    searchFrom = idx + 1;
  }
  return null;
}

/**
 * Extracts a JSON value from raw CLI output that may contain
 * markdown code blocks, surrounding text, or other noise.
 */
export function extractJson(raw: string): unknown | null {
  // Try direct parse first
  try {
    return JSON.parse(raw);
  } catch {
    // noop
  }

  // Try extracting from markdown code blocks
  const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]);
    } catch {
      // noop
    }
  }

  // f-018: Prefer objects over arrays to avoid misidentifying bracket-prefixed prose.
  // Try all { positions first, then fall back to [ positions.
  const objResult = tryAllOccurrences(raw, "{");
  if (objResult !== null) return objResult;

  const arrResult = tryAllOccurrences(raw, "[");
  if (arrResult !== null) return arrResult;

  return null;
}

/**
 * Unwraps the claude CLI JSON envelope.
 * `claude -p --output-format json` wraps output in:
 * { "type": "result", "result": "..." }
 * where result is a stringified JSON (possibly inside a code block).
 */
export function unwrapCliEnvelope(parsed: unknown): unknown {
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "type" in parsed &&
    "result" in parsed &&
    (parsed as Record<string, unknown>).type === "result"
  ) {
    const inner = (parsed as Record<string, unknown>).result;
    if (typeof inner === "string") {
      const unwrapped = extractJson(inner);
      if (unwrapped !== null) return unwrapped;
    } else if (typeof inner === "object" && inner !== null) {
      return inner;
    }
  }
  return parsed;
}
