import type { Finding, PLevel } from "./types";

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
    // Match diff file header: +++ b/src/auth.ts
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
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

  // Tag pre-existing
  // Findings with line=0 have unknown location — treat as NOT pre-existing
  const result: Finding[] = [];
  for (const finding of deduped.values()) {
    const inDiff =
      finding.line === 0 ||
      (diffFiles.has(finding.file) &&
        isInDiffHunks(finding.file, finding.line, hunks));

    result.push({
      ...finding,
      pre_existing: !inDiff,
    });
  }

  return result;
}
