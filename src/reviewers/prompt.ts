import type { DiffScope } from "../types";

export function buildReviewPrompt(
  basePrompt: string,
  scope: DiffScope
): string {
  return [
    basePrompt,
    "",
    "Files to review:",
    scope.files.join("\n"),
    "",
    "<code_diff>",
    scope.diff,
    "</code_diff>",
  ].join("\n");
}
