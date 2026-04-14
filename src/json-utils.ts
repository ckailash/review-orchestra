/**
 * Shared JSON extraction and CLI envelope unwrapping.
 * Used by reviewer-parser.ts to handle raw output from
 * headless claude/codex CLI calls.
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

// Cap on the number of candidate start positions we'll try, to avoid
// O(n^2) behaviour on pathological inputs (e.g. long prose with many `{`).
const MAX_PARSE_ATTEMPTS = 64;

/**
 * Try up to MAX_PARSE_ATTEMPTS occurrences of `char` in `raw` as JSON start
 * positions. Returns the first successfully parsed value, or null.
 */
function tryAllOccurrences(raw: string, char: string): unknown | null {
  let searchFrom = 0;
  let attempts = 0;
  while (attempts < MAX_PARSE_ATTEMPTS) {
    const idx = raw.indexOf(char, searchFrom);
    if (idx === -1) break;

    const result = tryBalancedParse(raw, idx);
    if (result !== null) return result;

    attempts++;
    searchFrom = idx + 1;
  }
  return null;
}

/**
 * Find the position of the first `{` or `[` in `raw`. Returns {char, idx}
 * or null if neither is present. Used to choose which top-level container
 * shape to prefer when extracting JSON from noisy output.
 */
function firstContainerStart(raw: string): { char: "{" | "["; idx: number } | null {
  const obj = raw.indexOf("{");
  const arr = raw.indexOf("[");
  if (obj === -1 && arr === -1) return null;
  if (obj === -1) return { char: "[", idx: arr };
  if (arr === -1) return { char: "{", idx: obj };
  return obj < arr ? { char: "{", idx: obj } : { char: "[", idx: arr };
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

  // Prefer whichever top-level container (`{` or `[`) appears first in the
  // raw string, so an array payload with leading prose (e.g.
  // `note\n[{...}]`) is parsed as the array rather than as its first
  // inner object. Fall back to scanning the other container kind if the
  // first choice didn't yield a parse.
  const first = firstContainerStart(raw);
  if (first) {
    const primary = tryAllOccurrences(raw, first.char);
    if (primary !== null) return primary;
    const otherChar = first.char === "{" ? "[" : "{";
    const secondary = tryAllOccurrences(raw, otherChar);
    if (secondary !== null) return secondary;
  }

  return null;
}

/**
 * Unwraps the claude CLI JSON envelope.
 * `claude -p --output-format json` wraps output in:
 * { "type": "result", "result": "..." }
 * where result is a stringified JSON (possibly inside a code block).
 */
export function unwrapCliEnvelope(parsed: unknown): unknown {
  // Handle streaming JSON array format: find the type:"result" element and unwrap it
  if (Array.isArray(parsed)) {
    const resultEl = parsed.find(
      (el): el is Record<string, unknown> =>
        typeof el === "object" && el !== null && "type" in el && el.type === "result" && "result" in el,
    );
    if (resultEl) {
      const inner = resultEl.result;
      if (typeof inner === "string") {
        const unwrapped = extractJson(inner);
        if (unwrapped !== null) return unwrapped;
      } else if (typeof inner === "object" && inner !== null) {
        return inner;
      }
    }
    return parsed;
  }

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
