import type { DiffScope, Finding } from "../types";

export interface Reviewer {
  name: string;
  review(prompt: string, scope: DiffScope): Promise<Finding[]>;
}
