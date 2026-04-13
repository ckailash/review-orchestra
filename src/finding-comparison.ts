import type { Finding, FindingComparisonConfig } from "./types";
import { spawnWithStreaming } from "./process";
import { extractJson } from "./json-utils";
import { log } from "./log";
import { isFuzzyMatch } from "./fuzzy-match";

export interface ComparisonResult {
  newFindings: Finding[];
  persistingFindings: Finding[];
  resolvedFindings: Finding[];
}

export interface AssignedResult {
  findings: Finding[];
  resolvedFindings: Finding[];
}

/**
 * Truncate a string to ~100 chars. If > 100, slice to 97 and append '...'
 */
function truncate(text: string, limit = 100): string {
  if (text.length > limit) {
    return text.slice(0, limit - 3) + "...";
  }
  return text;
}

/**
 * Summarize a finding into a 3-line format for LLM comparison.
 *
 * Line 1: [LABEL] file:<path> line:<N> cat:<category> sev:<severity>
 * Line 2:   Issue: <truncated description>
 * Line 3:   Fix: <truncated suggestion>
 *
 * If description or suggestion is very short (<20 chars), appends title as
 * supplementary context.
 */
export function summarizeFinding(finding: Finding, label: string): string {
  const line1 = `[${label}] file:${finding.file} line:${finding.line} cat:${finding.category} sev:${finding.severity}`;

  let descText = finding.description;
  if (descText.length < 20 && finding.title.length >= 20) {
    descText += ` (title: ${finding.title})`;
  }
  descText = truncate(descText);

  let suggText = finding.suggestion;
  if (suggText.length < 20 && finding.title.length >= 20) {
    suggText += ` (title: ${finding.title})`;
  }
  suggText = truncate(suggText);

  const line2 = `  Issue: ${descText}`;
  const line3 = `  Fix: ${suggText}`;

  return `${line1}\n${line2}\n${line3}`;
}

/**
 * Build the full comparison prompt for LLM-based finding matching.
 *
 * Takes pre-built summary strings for previous and current findings
 * and assembles them into the prompt template with matching rules and
 * JSON output format instructions.
 */
export function buildComparisonPrompt(
  previousSummaries: string,
  currentSummaries: string,
): string {
  return `You are comparing code review findings across two review rounds of the same codebase.
Determine which current-round findings match previous-round findings — meaning they
describe the same underlying code problem.

"Same issue" means: same root cause bug or code problem at approximately the same
location, regardless of how the reviewer worded the title or description. Consider:
- Same file or a renamed/moved file with the same issue
- Same logical problem even if line numbers shifted (code was edited between rounds)
- Same category of issue in the same code region

Do NOT match findings that are merely similar in category but describe different
concrete problems (e.g., two different SQL injection bugs in different functions are
NOT the same finding).

Each current finding should match at most one previous finding (pick the best match).
Each previous finding should match at most one current finding.

## Previous round findings:
${previousSummaries}

## Current round findings:
${currentSummaries}

Return JSON only, no explanation:
{
  "matches": [
    {"current": "CUR-1", "previous": "PREV-3"},
    {"current": "CUR-2", "previous": null}
  ]
}

Every current finding must appear exactly once in the matches array.
If a current finding has no match, set "previous" to null.`;
}

/**
 * Build a comparison key for a finding: file + title.toLowerCase().
 * This is the best-effort matching heuristic described in the plan.
 */
function comparisonKey(finding: Finding): string {
  return `${finding.file}\0${finding.title.toLowerCase().trim()}`;
}

/**
 * Compare current round's findings against previous round's findings using
 * file + title.toLowerCase() (case-insensitive) heuristic.
 *
 * Returns:
 * - newFindings: in current but not in previous
 * - persistingFindings: in both current and previous (with previous round's ID preserved)
 * - resolvedFindings: in previous but not in current (returned as-is)
 */
function compareFindingsHeuristic(
  currentFindings: Finding[],
  previousFindings: Finding[],
): ComparisonResult {
  // Index previous findings by comparison key (supports duplicates)
  const previousByKey = new Map<string, Finding[]>();
  for (const f of previousFindings) {
    const key = comparisonKey(f);
    const existing = previousByKey.get(key);
    if (existing) {
      existing.push(f);
    } else {
      previousByKey.set(key, [f]);
    }
  }

  const exactNewFindings: Finding[] = [];
  const persistingFindings: Finding[] = [];

  for (const current of currentFindings) {
    const key = comparisonKey(current);
    const candidates = previousByKey.get(key);

    if (candidates && candidates.length > 0) {
      // Persisting: consume first available match (FIFO)
      const previous = candidates.shift()!;
      persistingFindings.push({ ...current, id: previous.id });
    } else {
      // Not matched by exact key — candidate for fuzzy matching
      exactNewFindings.push(current);
    }
  }

  // Collect unconsumed previous findings for fuzzy matching
  const unmatchedPrevious: Finding[] = [];
  for (const remaining of previousByKey.values()) {
    unmatchedPrevious.push(...remaining);
  }

  // Second pass: fuzzy match unmatched current against unmatched previous
  const newFindings: Finding[] = [];
  for (const current of exactNewFindings) {
    let matched = false;
    for (let i = 0; i < unmatchedPrevious.length; i++) {
      if (isFuzzyMatch(current, unmatchedPrevious[i])) {
        persistingFindings.push({ ...current, id: unmatchedPrevious[i].id });
        unmatchedPrevious.splice(i, 1);
        matched = true;
        break;
      }
    }
    if (!matched) {
      newFindings.push(current);
    }
  }

  // Resolved: any remaining unmatched previous findings
  const resolvedFindings: Finding[] = [...unmatchedPrevious];

  // Sort persisting findings by their original ID for stable ordering
  persistingFindings.sort((a, b) => a.id.localeCompare(b.id));

  return { newFindings, persistingFindings, resolvedFindings };
}

/**
 * Compare findings using LLM-based semantic matching.
 *
 * Spawns `claude -p` with a comparison prompt, parses the JSON response,
 * validates the match structure, and converts to ComparisonResult.
 *
 * Throws on any error (spawn failure, parse failure, validation failure).
 * Caller handles fallback.
 */
async function compareFindingsViaLLM(
  currentFindings: Finding[],
  previousFindings: Finding[],
  config: FindingComparisonConfig,
): Promise<ComparisonResult> {
  // Build summaries
  const previousSummaries = previousFindings
    .map((f, i) => summarizeFinding(f, `PREV-${i + 1}`))
    .join("\n");
  const currentSummaries = currentFindings
    .map((f, i) => summarizeFinding(f, `CUR-${i + 1}`))
    .join("\n");

  // Build prompt
  const prompt = buildComparisonPrompt(previousSummaries, currentSummaries);

  // Spawn claude CLI with nested-session env cleared
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SSE_PORT;
  const output = await spawnWithStreaming({
    bin: "claude",
    args: ["-p", "-", "--output-format", "text", "--model", config.model],
    input: prompt,
    env,
    label: "finding-comparison",
    inactivityTimeout: config.timeoutMs,
    catastrophicTimeout: config.timeoutMs * 2,
  });

  // Extract JSON from output (may be surrounded by text)
  const parsed = extractJson(output);
  if (parsed === null) {
    throw new Error("No valid JSON found in LLM response");
  }

  // Validate structure
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("matches" in parsed) ||
    !Array.isArray((parsed as Record<string, unknown>).matches)
  ) {
    throw new Error("LLM response missing 'matches' array");
  }

  const matches = (parsed as { matches: unknown[] }).matches;

  // Validate each match entry
  const validCurrentIds = new Set(
    currentFindings.map((_, i) => `CUR-${i + 1}`),
  );
  const validPreviousIds = new Set(
    previousFindings.map((_, i) => `PREV-${i + 1}`),
  );

  const seenCurrentIds = new Set<string>();
  const seenPreviousIds = new Set<string>();

  for (const match of matches) {
    if (!match || typeof match !== "object") {
      throw new Error("Invalid match entry in LLM response");
    }
    const m = match as Record<string, unknown>;
    if (typeof m.current !== "string" || !m.current.startsWith("CUR-")) {
      throw new Error(`Invalid current ID in match: ${String(m.current)}`);
    }
    if (!validCurrentIds.has(m.current)) {
      throw new Error(`Unknown current ID: ${m.current}`);
    }
    if (seenCurrentIds.has(m.current)) {
      throw new Error(`Duplicate current ID in matches: ${m.current}`);
    }
    seenCurrentIds.add(m.current);
    if (m.previous !== null) {
      if (typeof m.previous !== "string" || !m.previous.startsWith("PREV-")) {
        throw new Error(`Invalid previous ID in match: ${String(m.previous)}`);
      }
      if (!validPreviousIds.has(m.previous)) {
        throw new Error(`Unknown previous ID: ${m.previous}`);
      }
      if (seenPreviousIds.has(m.previous)) {
        throw new Error(`Duplicate previous ID in matches: ${m.previous}`);
      }
      seenPreviousIds.add(m.previous);
    }
  }

  // Validate completeness: every current finding must appear exactly once
  if (matches.length !== currentFindings.length) {
    throw new Error(
      `Matches count (${matches.length}) does not equal current findings count (${currentFindings.length})`,
    );
  }
  // Convert validated matches to ComparisonResult
  const typedMatches = matches as Array<{
    current: string;
    previous: string | null;
  }>;

  const matchedPreviousIds = new Set<string>();
  const newFindings: Finding[] = [];
  const persistingFindings: Finding[] = [];

  for (const match of typedMatches) {
    const curIndex = parseInt(match.current.replace("CUR-", ""), 10) - 1;
    const currentFinding = currentFindings[curIndex];

    if (match.previous === null) {
      newFindings.push(currentFinding);
    } else {
      const prevIndex =
        parseInt(match.previous.replace("PREV-", ""), 10) - 1;
      const previousFinding = previousFindings[prevIndex];
      persistingFindings.push({ ...currentFinding, id: previousFinding.id });
      matchedPreviousIds.add(match.previous);
    }
  }

  // Sort persisting findings by their original ID for stable ordering
  persistingFindings.sort((a, b) => a.id.localeCompare(b.id));

  // Unmatched previous findings are resolved
  const resolvedFindings: Finding[] = previousFindings.filter(
    (_, i) => !matchedPreviousIds.has(`PREV-${i + 1}`),
  );

  return { newFindings, persistingFindings, resolvedFindings };
}

/**
 * Compare current round's findings against previous round's findings.
 *
 * Dispatches to LLM-based or heuristic comparison based on config.
 * Falls back to heuristic on any LLM failure (unless fallback='error').
 *
 * When config is undefined, uses heuristic for backward compatibility.
 */
export async function compareFindings(
  currentFindings: Finding[],
  previousFindings: Finding[],
  config?: FindingComparisonConfig,
): Promise<ComparisonResult> {
  // Short-circuit: no previous findings means all are new
  if (previousFindings.length === 0) {
    return {
      newFindings: [...currentFindings],
      persistingFindings: [],
      resolvedFindings: [],
    };
  }

  // Short-circuit: no current findings means all previous are resolved
  if (currentFindings.length === 0) {
    return {
      newFindings: [],
      persistingFindings: [],
      resolvedFindings: [...previousFindings],
    };
  }

  // No config = backward compat = heuristic
  if (!config) {
    return compareFindingsHeuristic(currentFindings, previousFindings);
  }

  // Explicit heuristic method
  if (config.method === "heuristic") {
    return compareFindingsHeuristic(currentFindings, previousFindings);
  }

  // LLM path
  try {
    return await compareFindingsViaLLM(currentFindings, previousFindings, config);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (config.fallback === "error") {
      throw err;
    }
    log(
      `warning: LLM finding comparison failed (${reason}), falling back to heuristic matching`,
    );
    return compareFindingsHeuristic(currentFindings, previousFindings);
  }
}

/**
 * Assign round-scoped IDs and statuses to findings after comparison.
 *
 * New findings get IDs in format `rN-f-NNN` (e.g. r1-f-001, r2-f-003)
 * and status 'new'.
 *
 * Persisting findings keep their original ID from the round they first
 * appeared and get status 'persisting'.
 *
 * Resolved findings are returned in a separate array as-is from the
 * previous round.
 *
 * When config is omitted, uses heuristic matching (backward compatible).
 */
export async function assignFindingIds(
  currentFindings: Finding[],
  previousFindings: Finding[],
  roundNumber: number,
  config?: FindingComparisonConfig,
): Promise<AssignedResult> {
  const { newFindings, persistingFindings, resolvedFindings } =
    await compareFindings(currentFindings, previousFindings, config);

  // Assign round-scoped IDs to new findings
  const assignedNew: Finding[] = newFindings.map((f, i) => ({
    ...f,
    id: `r${roundNumber}-f-${String(i + 1).padStart(3, "0")}`,
    status: "new" as const,
  }));

  // Persisting findings keep their original ID, get 'persisting' status
  const assignedPersisting: Finding[] = persistingFindings.map((f) => ({
    ...f,
    status: "persisting" as const,
  }));

  // Combine: persisting first (stable IDs), then new
  const findings = [...assignedPersisting, ...assignedNew];

  return { findings, resolvedFindings };
}
