import { describe, it, expect } from "vitest";
import { buildReviewPrompt } from "../src/reviewers/prompt";
import type { DiffScope } from "../src/types";

function makeScope(overrides: Partial<DiffScope> = {}): DiffScope {
  return {
    type: "branch",
    diff: "fake diff",
    files: ["src/auth.ts", "src/api.ts"],
    baseBranch: "main",
    description: "branch diff vs main",
    ...overrides,
  };
}

describe("buildReviewPrompt", () => {
  const basePrompt = "You are a code reviewer.";

  it("includes 'Recent Commits' section when commitMessages is populated", () => {
    const scope = makeScope({
      commitMessages: "abc123 Fix auth bug\ndef456 Add tests",
    });

    const result = buildReviewPrompt(basePrompt, scope);

    expect(result).toContain("## Recent Commits (developer intent)");
    expect(result).toContain("abc123 Fix auth bug");
    expect(result).toContain("def456 Add tests");
  });

  it("omits 'Recent Commits' section when commitMessages is undefined", () => {
    const scope = makeScope({ commitMessages: undefined });

    const result = buildReviewPrompt(basePrompt, scope);

    expect(result).not.toContain("Recent Commits");
  });

  it("omits 'Recent Commits' section when commitMessages is empty string", () => {
    const scope = makeScope({ commitMessages: "" });

    const result = buildReviewPrompt(basePrompt, scope);

    expect(result).not.toContain("Recent Commits");
  });

  it("omits 'Recent Commits' section when commitMessages is whitespace only", () => {
    const scope = makeScope({ commitMessages: "   \n  " });

    const result = buildReviewPrompt(basePrompt, scope);

    expect(result).not.toContain("Recent Commits");
  });

  it("includes base prompt, scope description, and file list", () => {
    const scope = makeScope();

    const result = buildReviewPrompt(basePrompt, scope);

    expect(result).toContain(basePrompt);
    expect(result).toContain("Scope: branch diff vs main");
    expect(result).toContain("src/auth.ts");
    expect(result).toContain("src/api.ts");
  });
});
