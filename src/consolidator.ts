import type { Finding, PLevel } from "./types";
import { isFuzzyMatch } from "./fuzzy-match";

interface DiffHunk {
  file: string;
  startLine: number;
  lineCount: number;
}

const P_LEVEL_ORDER: Record<PLevel, number> = {
  p0: 0,
  p1: 1,
  p2: 2,
  p3: 3,
};

function parseDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let currentFile = "";

  for (const line of diff.split("\n")) {
    // Any +++ line resets the current file context. We only attribute
    // hunks to a real file path (`+++ b/<path>`); for `+++ /dev/null`
    // (deleted file) and any other `+++` form, currentFile is cleared so
    // following hunks don't get misattributed to a previous file.
    if (line.startsWith("+++ ")) {
      const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
      currentFile = fileMatch ? fileMatch[1] : "";
      continue;
    }

    // Match hunk header: @@ -38,7 +38,13 @@
    const hunkMatch = line.match(/^@@ .+ \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentFile) {
      hunks.push({
        file: currentFile,
        startLine: parseInt(hunkMatch[1], 10),
        lineCount: hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1,
      });
    }
  }

  return hunks;
}

function isInDiffHunks(
  file: string,
  line: number,
  hunks: DiffHunk[]
): boolean {
  return hunks.some(
    (h) => h.file === file && line >= h.startLine && line < h.startLine + h.lineCount
  );
}

function deduplicationKey(f: Finding): string {
  return `${f.file}:${f.line}:${f.title.toLowerCase().trim()}`;
}

function countPopulatedOptionalFields(f: Finding): number {
  let count = 0;
  if (f.expected != null) count++;
  if (f.observed != null) count++;
  if (Array.isArray(f.evidence) && f.evidence.length > 0) count++;
  return count;
}

function mergeFuzzyPair(a: Finding, b: Finding): Finding {
  const sevA = P_LEVEL_ORDER[a.severity];
  const sevB = P_LEVEL_ORDER[b.severity];

  let winner: Finding;
  if (sevA < sevB) {
    winner = a;
  } else if (sevB < sevA) {
    winner = b;
  } else {
    // Tie-break by populated optional fields
    winner =
      countPopulatedOptionalFields(a) >= countPopulatedOptionalFields(b)
        ? a
        : b;
  }

  // Comma-join reviewer names
  const reviewer = `${a.reviewer},${b.reviewer}`;
  return { ...winner, reviewer };
}

function parseReviewerSet(reviewer: string): Set<string> {
  return new Set(reviewer.split(",").map((r) => r.trim()).filter(Boolean));
}

function setsAreDisjoint(a: Set<string>, b: Set<string>): boolean {
  for (const item of a) {
    if (b.has(item)) return false;
  }
  return true;
}

function fuzzyDeduplicate(findings: Finding[]): Finding[] {
  // Group by file
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const group = byFile.get(f.file);
    if (group) {
      group.push(f);
    } else {
      byFile.set(f.file, [f]);
    }
  }

  const merged = new Set<Finding>();

  for (const group of byFile.values()) {
    // Track which findings in this group have been consumed by a merge
    const consumed = new Set<number>();
    // Track reviewer identity as sets (splitting comma-joined strings)
    const reviewerSets = new Map<number, Set<string>>();
    for (let i = 0; i < group.length; i++) {
      reviewerSets.set(i, parseReviewerSet(group[i].reviewer));
    }

    for (let i = 0; i < group.length; i++) {
      if (consumed.has(i)) continue;

      let current = group[i];
      let currentReviewers = reviewerSets.get(i)!;

      for (let j = i + 1; j < group.length; j++) {
        if (consumed.has(j)) continue;

        const other = group[j];
        const otherReviewers = reviewerSets.get(j)!;

        // Only merge cross-reviewer pairs (reviewer sets must be disjoint)
        if (!setsAreDisjoint(currentReviewers, otherReviewers)) continue;

        if (isFuzzyMatch(current, other)) {
          current = mergeFuzzyPair(current, other);
          // Union the reviewer sets after merge
          currentReviewers = new Set([...currentReviewers, ...otherReviewers]);
          consumed.add(j);
        }
      }

      merged.add(current);
    }
  }

  return [...merged];
}

export function consolidate(findings: Finding[], diff: string): Finding[] {
  if (findings.length === 0) return [];

  const hunks = parseDiffHunks(diff);
  const diffFiles = new Set(hunks.map((h) => h.file));

  // Deduplicate: group by file:line:title, keep highest severity
  const deduped = new Map<string, Finding>();
  for (const finding of findings) {
    const key = deduplicationKey(finding);
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, finding);
    } else if (
      P_LEVEL_ORDER[finding.severity] < P_LEVEL_ORDER[existing.severity]
    ) {
      deduped.set(key, finding);
    } else if (
      P_LEVEL_ORDER[finding.severity] === P_LEVEL_ORDER[existing.severity] &&
      countPopulatedOptionalFields(finding) > countPopulatedOptionalFields(existing)
    ) {
      deduped.set(key, finding);
    }
  }

  // Semantic (fuzzy) dedup: merge cross-reviewer near-duplicates
  const exactDeduped = [...deduped.values()];
  const semanticDeduped = fuzzyDeduplicate(exactDeduped);

  // Tag pre-existing
  // Findings in files not in the diff are always pre-existing
  // Findings with line=0 and file in diff have unknown location — treat as NOT pre-existing
  const result: Finding[] = [];
  for (const finding of semanticDeduped) {
    const fileInDiff = diffFiles.has(finding.file);
    const inDiff =
      fileInDiff &&
      (finding.line === 0 || isInDiffHunks(finding.file, finding.line, hunks));

    result.push({
      ...finding,
      pre_existing: !inDiff,
    });
  }

  return result;
}
