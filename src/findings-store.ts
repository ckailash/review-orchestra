import {
  existsSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Finding } from "./types";
import { log } from "./log";

const DEFAULT_BASE_DIR = join(homedir(), ".review-orchestra");
const JSONL_FILENAME = "findings.jsonl";

export interface AppendFindingsOptions {
  findings: Finding[];
  sessionId: string;
  round: number;
  project: string;
  baseDir?: string;
}

export interface BackfillResolvedOptions {
  resolvedFindings: Finding[];
  sessionId: string;
  resolvedInRound: number;
  project: string;
  baseDir?: string;
}

interface JsonlEntry {
  timestamp: string;
  project: string;
  sessionId: string;
  round: number;
  finding: Finding;
  status: string;
  resolved_in_round: number | null;
}

/**
 * Appends all findings as JSONL lines to <baseDir>/findings.jsonl in a
 * single append call, so a mid-loop failure (ENOSPC, permission change) can't
 * leave the store partially written.
 * Creates directory recursively if missing.
 * Empty findings array is a no-op.
 */
export function appendFindings(options: AppendFindingsOptions): void {
  const { findings, sessionId, round, project } = options;
  const baseDir = options.baseDir ?? DEFAULT_BASE_DIR;

  if (findings.length === 0) return;

  mkdirSync(baseDir, { recursive: true });

  const filePath = join(baseDir, JSONL_FILENAME);
  const timestamp = new Date().toISOString();

  const payload = findings
    .map((finding) => {
      const entry: JsonlEntry = {
        timestamp,
        project,
        sessionId,
        round,
        finding,
        status: finding.status ?? "new",
        resolved_in_round: null,
      };
      return JSON.stringify(entry);
    })
    .join("\n") + "\n";

  appendFileSync(filePath, payload);
}

/**
 * Reads findings.jsonl, finds matching entries by finding.id + sessionId
 * where resolved_in_round is null, sets resolved_in_round to resolvedInRound,
 * rewrites file atomically (write to .tmp + rename).
 * Empty resolvedFindings array is a no-op.
 * Missing file is a no-op.
 * Already-resolved entries (resolved_in_round !== null) are skipped.
 *
 * Cost: O(n) read + write of the entire JSONL on each call. Acceptable for
 * the typical "tens of findings per round, single-digit rounds per
 * project" workload; revisit with an index/append-update format if the
 * store grows into the hundreds of thousands of lines.
 */
export function backfillResolved(options: BackfillResolvedOptions): void {
  const { resolvedFindings, sessionId, resolvedInRound, project } = options;
  const baseDir = options.baseDir ?? DEFAULT_BASE_DIR;

  if (resolvedFindings.length === 0) return;

  const filePath = join(baseDir, JSONL_FILENAME);

  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, "utf-8").trim();
  if (content === "") return;

  const lines = content.split("\n");
  const resolvedIds = new Set(resolvedFindings.map((f) => f.id));

  // Fast path: scan once to confirm at least one matching entry exists
  // before doing a full parse/serialise rewrite. For a project with many
  // rounds and most calls being no-ops, this avoids paying the rewrite
  // cost when nothing matches.
  let hasMatch = false;
  for (const line of lines) {
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line) as JsonlEntry;
    } catch {
      continue;
    }
    if (
      entry.sessionId === sessionId &&
      entry.project === project &&
      resolvedIds.has(entry.finding.id) &&
      entry.resolved_in_round === null
    ) {
      hasMatch = true;
      break;
    }
  }
  if (!hasMatch) return;

  let modified = false;
  const updatedLines = lines.map((line) => {
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line) as JsonlEntry;
    } catch {
      log(`warning: skipping malformed JSONL line in findings store`);
      return line;
    }

    if (
      entry.sessionId === sessionId &&
      entry.project === project &&
      resolvedIds.has(entry.finding.id) &&
      entry.resolved_in_round === null
    ) {
      entry.resolved_in_round = resolvedInRound;
      modified = true;
      return JSON.stringify(entry);
    }
    return line;
  });

  if (!modified) return;

  // Atomic rewrite: write to temp file, then rename
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, updatedLines.join("\n") + "\n");
  renameSync(tmpPath, filePath);
}
