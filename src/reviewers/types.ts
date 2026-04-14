import type { DiffScope, Finding } from "../types";

export interface ReviewerResult {
  findings: Finding[];
  rawOutput: string;
  elapsedMs?: number;
}

export interface ReviewerCallContext {
  /** Round number for this invocation. Used to name the raw-output file. */
  roundNumber: number;
}

export interface Reviewer {
  name: string;
  review(
    prompt: string,
    scope: DiffScope,
    context: ReviewerCallContext,
  ): Promise<ReviewerResult>;
}
