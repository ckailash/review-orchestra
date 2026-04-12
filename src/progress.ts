import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";

export interface ReviewerProgress {
  status: "running" | "done" | "error";
  findingsCount: number | null;
  elapsedMs: number | null;
}

export interface ProgressData {
  round: number;
  startedAt: string;
  reviewers: Record<string, ReviewerProgress>;
}

export function writeProgress(stateDir: string, data: ProgressData): void {
  writeFileSync(
    join(stateDir, "progress.json"),
    JSON.stringify(data, null, 2),
  );
}

export function clearProgress(stateDir: string): void {
  try {
    unlinkSync(join(stateDir, "progress.json"));
  } catch {
    // Best effort — file may not exist
  }
}
