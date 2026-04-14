import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { log } from "../log";

/**
 * Write a reviewer's raw stdout to `<stateDir>/round-<N>-<name>-raw.txt`.
 *
 * Called from inside each reviewer immediately after the spawn returns,
 * BEFORE any parsing step. That ordering is the whole point: parsing can
 * throw (malformed JSON, schema mismatch) and we want the raw output on
 * disk regardless of outcome so the user can inspect it.
 *
 * Failures here are downgraded to a warning — losing the debug file is
 * not a reason to abort an otherwise-successful review.
 */
export function persistRawOutput(
  stateDir: string,
  roundNumber: number,
  reviewerName: string,
  rawOutput: string,
): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, `round-${roundNumber}-${reviewerName}-raw.txt`),
      rawOutput,
    );
  } catch (err) {
    log(
      `warning: failed to save raw output for ${reviewerName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
