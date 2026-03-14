import type { DiffScope } from "../types";

export function buildReviewPrompt(
  basePrompt: string,
  scope: DiffScope
): string {
  return [
    basePrompt,
    "",
    `Scope: ${scope.description}`,
    "",
    "Files to review:",
    scope.files.join("\n"),
  ].join("\n");
}
