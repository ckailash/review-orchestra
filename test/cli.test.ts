import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/parse-args";

describe("parseArgs", () => {
  it("returns defaults for empty input", () => {
    const result = parseArgs("");
    expect(result).toEqual({
      paths: [],
      disabledReviewers: [],
      models: {},
      dryRun: false,
    });
  });

  it("parses file paths", () => {
    const result = parseArgs("src/auth/ src/api/");
    expect(result.paths).toEqual(["src/auth/", "src/api/"]);
  });

  it("parses bare directory names as paths", () => {
    const result = parseArgs("src lib");
    expect(result.paths).toEqual(["src", "lib"]);
  });

  it("parses dry run flag", () => {
    expect(parseArgs("dry run").dryRun).toBe(true);
    expect(parseArgs("--dry-run").dryRun).toBe(true);
  });

  it("parses max rounds", () => {
    const result = parseArgs("max 3 rounds");
    expect(result.maxRounds).toBe(3);
  });

  it("parses 'fix everything' threshold", () => {
    const result = parseArgs("fix everything");
    expect(result.stopAt).toBe("p3");
  });

  it("parses 'fix quality issues too' threshold", () => {
    const result = parseArgs("fix quality issues too");
    expect(result.stopAt).toBe("p2");
  });

  it("parses 'skip codex'", () => {
    const result = parseArgs("skip codex");
    expect(result.disabledReviewers).toEqual(["codex"]);
  });

  it("parses 'only use claude'", () => {
    const result = parseArgs("only use claude");
    expect(result.onlyReviewer).toBe("claude");
  });

  it("parses 'only claude'", () => {
    const result = parseArgs("only claude");
    expect(result.onlyReviewer).toBe("claude");
  });

  it("parses model for specific reviewer: 'use opus for claude'", () => {
    const result = parseArgs("use opus for claude");
    expect(result.models).toEqual({ claude: "opus" });
  });

  it("parses model for specific reviewer: 'use o4 for codex'", () => {
    const result = parseArgs("use o4 for codex");
    expect(result.models).toEqual({ codex: "o4" });
  });

  it("parses multiple model overrides: 'use opus for claude use o4 for codex'", () => {
    const result = parseArgs("use opus for claude use o4 for codex");
    expect(result.models).toEqual({ claude: "opus", codex: "o4" });
  });

  it("infers reviewer from model name pattern", () => {
    expect(parseArgs("use opus").models).toEqual({ claude: "opus" });
    expect(parseArgs("use sonnet").models).toEqual({ claude: "sonnet" });
    expect(parseArgs("use o4").models).toEqual({ codex: "o4" });
  });

  it("passes full model IDs through verbatim", () => {
    const result = parseArgs("use claude-opus-4-6 for claude");
    expect(result.models).toEqual({ claude: "claude-opus-4-6" });
  });

  it("passes through unknown model names verbatim", () => {
    const result = parseArgs("use gpt-4o for codex");
    expect(result.models).toEqual({ codex: "gpt-4o" });
  });

  it("defaults unknown model families to claude reviewer", () => {
    const result = parseArgs("use my-custom-model");
    expect(result.models).toEqual({ claude: "my-custom-model" });
  });

  it("parses HEAD~N as a commit ref", () => {
    expect(parseArgs("HEAD~1").commitRef).toBe("HEAD~1");
    expect(parseArgs("HEAD~3").commitRef).toBe("HEAD~3");
  });

  it("parses commit ranges", () => {
    expect(parseArgs("HEAD~3..HEAD").commitRef).toBe("HEAD~3..HEAD");
    expect(parseArgs("abc1234..def5678").commitRef).toBe("abc1234..def5678");
  });

  it("parses bare SHAs as commit refs", () => {
    expect(parseArgs("abc1234").commitRef).toBe("abc1234");
    const sha40 = "abcdef1234abcdef1234abcdef1234abcdef1234";
    expect(parseArgs(sha40).commitRef).toBe(sha40);
  });

  it("does not confuse short tokens with SHAs", () => {
    // 6 chars or fewer are NOT treated as SHAs (too ambiguous)
    expect(parseArgs("abc123").commitRef).toBeUndefined();
  });

  it("combines commit ref with other args", () => {
    const result = parseArgs("HEAD~2 src/auth/ only claude");
    expect(result.commitRef).toBe("HEAD~2");
    expect(result.paths).toEqual(["src/auth/"]);
    expect(result.onlyReviewer).toBe("claude");
  });

  it("parses combined args", () => {
    const result = parseArgs("src/auth/ max 3 rounds only claude use opus dry run");
    expect(result.paths).toEqual(["src/auth/"]);
    expect(result.maxRounds).toBe(3);
    expect(result.onlyReviewer).toBe("claude");
    expect(result.models).toEqual({ claude: "opus" });
    expect(result.dryRun).toBe(true);
  });
});
