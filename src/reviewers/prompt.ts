import type { DiffScope } from "../types";

export function buildReviewPrompt(
  basePrompt: string,
  scope: DiffScope
): string {
  const parts = [
    basePrompt,
    "",
    `Scope: ${scope.description}`,
    "",
    "Files to review:",
    scope.files.join("\n"),
  ];

  if (scope.commitMessages && scope.commitMessages.trim().length > 0) {
    parts.push(
      "",
      "## Recent Commits (developer intent)",
      "",
      scope.commitMessages
    );
  }

  return parts.join("\n");
}
