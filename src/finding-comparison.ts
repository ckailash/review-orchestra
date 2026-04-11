import type { Finding } from "./types";

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
 * Build a comparison key for a finding: file + title.toLowerCase().
 * This is the best-effort matching heuristic described in the plan.
 */
function comparisonKey(finding: Finding): string {
  return `${finding.file}\0${finding.title.toLowerCase().trim()}`;
}

/**
 * Compare current round's findings against previous round's findings.
 *
 * Matching uses file + title.toLowerCase() (case-insensitive).
 *
 * Returns:
 * - newFindings: in current but not in previous
 * - persistingFindings: in both current and previous (with previous round's ID preserved)
 * - resolvedFindings: in previous but not in current (returned as-is)
 */
export function compareFindings(
  currentFindings: Finding[],
  previousFindings: Finding[],
): ComparisonResult {
  // Index previous findings by comparison key
  const previousByKey = new Map<string, Finding>();
  for (const f of previousFindings) {
    previousByKey.set(comparisonKey(f), f);
  }

  const newFindings: Finding[] = [];
  const persistingFindings: Finding[] = [];
  const matchedPreviousKeys = new Set<string>();

  for (const current of currentFindings) {
    const key = comparisonKey(current);
    const previous = previousByKey.get(key);

    if (previous) {
      // Persisting: found in both rounds — keep previous ID
      persistingFindings.push({ ...current, id: previous.id });
      matchedPreviousKeys.add(key);
    } else {
      // New: not found in previous round
      newFindings.push(current);
    }
  }

  // Resolved: in previous but not matched by any current finding
  const resolvedFindings: Finding[] = [];
  for (const prev of previousFindings) {
    if (!matchedPreviousKeys.has(comparisonKey(prev))) {
      resolvedFindings.push(prev);
    }
  }

  return { newFindings, persistingFindings, resolvedFindings };
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
 */
export function assignFindingIds(
  currentFindings: Finding[],
  previousFindings: Finding[],
  roundNumber: number,
): AssignedResult {
  const { newFindings, persistingFindings, resolvedFindings } =
    compareFindings(currentFindings, previousFindings);

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
