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
 * Appends each finding as one JSONL line to <baseDir>/findings.jsonl.
 * Creates directory recursively if missing.
 * Empty findings array is a no-op (no file write).
 * Uses fs.appendFileSync for each line (atomic per-line).
 */
export function appendFindings(options: AppendFindingsOptions): void {
  const { findings, sessionId, round, project } = options;
  const baseDir = options.baseDir ?? DEFAULT_BASE_DIR;

  if (findings.length === 0) return;

  mkdirSync(baseDir, { recursive: true });

  const filePath = join(baseDir, JSONL_FILENAME);

  for (const finding of findings) {
    const entry: JsonlEntry = {
      timestamp: new Date().toISOString(),
      project,
      sessionId,
      round,
      finding,
      status: finding.status ?? "new",
      resolved_in_round: null,
    };
    appendFileSync(filePath, JSON.stringify(entry) + "\n");
  }
}

/**
 * Reads findings.jsonl, finds matching entries by finding.id + sessionId
 * where resolved_in_round is null, sets resolved_in_round to resolvedInRound,
 * rewrites file atomically (write to .tmp + rename).
 * Empty resolvedFindings array is a no-op.
 * Missing file is a no-op.
 * Already-resolved entries (resolved_in_round !== null) are skipped.
 */
export function backfillResolved(options: BackfillResolvedOptions): void {
  const { resolvedFindings, sessionId, resolvedInRound } = options;
  const baseDir = options.baseDir ?? DEFAULT_BASE_DIR;

  if (resolvedFindings.length === 0) return;

  const filePath = join(baseDir, JSONL_FILENAME);

  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, "utf-8").trim();
  if (content === "") return;

  const lines = content.split("\n");
  const resolvedIds = new Set(resolvedFindings.map((f) => f.id));

  let modified = false;
  const updatedLines = lines.map((line) => {
    const entry = JSON.parse(line) as JsonlEntry;

    if (
      entry.sessionId === sessionId &&
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
