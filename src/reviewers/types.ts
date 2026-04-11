import type { DiffScope, Finding } from "../types";

export interface ReviewerResult {
  findings: Finding[];
  rawOutput: string;
}

export interface Reviewer {
  name: string;
  review(prompt: string, scope: DiffScope): Promise<ReviewerResult>;
}
