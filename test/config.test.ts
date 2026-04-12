import { describe, it, expect, vi, afterEach } from "vitest";
import { loadConfig, DEFAULT_CONFIG, DEFAULT_FINDING_COMPARISON_CONFIG } from "../src/config";
import type { Config } from "../src/types";

const mockConfigOverride = vi.hoisted(() => ({ json: null as string | null }));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => {
      const path = args[0] as string;
      if (mockConfigOverride.json !== null && typeof path === "string" && path.includes("default.json")) {
        return mockConfigOverride.json;
      }
      return actual.readFileSync.apply(null, args as Parameters<typeof actual.readFileSync>);
    },
  };
});

describe("loadConfig", () => {
  it("returns default config when no overrides provided", () => {
    const config = loadConfig();
    expect(config.thresholds.stopAt).toBe("p1");
  });

  it("has claude and codex reviewers enabled by default", () => {
    const config = loadConfig();
    expect(config.reviewers.claude).toBeDefined();
    expect(config.reviewers.claude.enabled).toBe(true);
    expect(config.reviewers.codex).toBeDefined();
    expect(config.reviewers.codex.enabled).toBe(true);
  });

  it("merges partial overrides into defaults", () => {
    const config = loadConfig({
      thresholds: { stopAt: "p2" },
    });
    expect(config.thresholds.stopAt).toBe("p2");
    // Other defaults preserved
    expect(config.reviewers.claude.enabled).toBe(true);
  });

  it("can disable a specific reviewer", () => {
    const config = loadConfig({
      reviewers: {
        codex: { enabled: false },
      },
    });
    expect(config.reviewers.codex.enabled).toBe(false);
    // Claude untouched
    expect(config.reviewers.claude.enabled).toBe(true);
  });

  it("can add a custom reviewer", () => {
    const config = loadConfig({
      reviewers: {
        gemini: {
          enabled: true,
          command: "gemini review {prompt}",
          outputFormat: "json",
        },
      },
    });
    expect(config.reviewers.gemini).toBeDefined();
    expect(config.reviewers.gemini.enabled).toBe(true);
    // Defaults still present
    expect(config.reviewers.claude.enabled).toBe(true);
    expect(config.reviewers.codex.enabled).toBe(true);
  });

  it("logs warning and returns defaults when config has invalid JSON", () => {
    mockConfigOverride.json = "{invalid";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const config = loadConfig();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("invalid JSON"),
    );
    expect(config.thresholds.stopAt).toBe(DEFAULT_CONFIG.thresholds.stopAt);
    expect(config.reviewers.claude.enabled).toBe(true);
    expect(config.reviewers.codex.enabled).toBe(true);

    mockConfigOverride.json = null;
    errorSpy.mockRestore();
  });

  it("adding a new reviewer via overrides fills in defaults", () => {
    const config = loadConfig({
      reviewers: { gemini: { enabled: true, command: "gemini review" } },
    });
    expect(config.reviewers.gemini).toBeDefined();
    expect(config.reviewers.gemini.enabled).toBe(true);
    expect(config.reviewers.gemini.command).toBe("gemini review");
    expect(config.reviewers.gemini.outputFormat).toBe("json"); // filled default
  });

  it("DEFAULT_CONFIG is deeply frozen", () => {
    const a = DEFAULT_CONFIG;
    const b = DEFAULT_CONFIG;
    expect(a).toBe(b);
    expect(a.thresholds.stopAt).toBe("p1");
    // Top-level frozen
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
    // Nested objects are also frozen
    expect(Object.isFrozen(DEFAULT_CONFIG.reviewers)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG.reviewers.claude)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG.reviewers.codex)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG.thresholds)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG.findingComparison)).toBe(true);
    // DEFAULT_FINDING_COMPARISON_CONFIG is also deeply frozen
    expect(Object.isFrozen(DEFAULT_FINDING_COMPARISON_CONFIG)).toBe(true);
  });

  it("DEFAULT_CONFIG includes findingComparison with correct defaults", () => {
    expect(DEFAULT_CONFIG.findingComparison).toBeDefined();
    expect(DEFAULT_CONFIG.findingComparison).toEqual(DEFAULT_FINDING_COMPARISON_CONFIG);
    expect(DEFAULT_CONFIG.findingComparison!.method).toBe("llm");
    expect(DEFAULT_CONFIG.findingComparison!.model).toBe("claude-haiku-4-5");
    expect(DEFAULT_CONFIG.findingComparison!.timeoutMs).toBe(60000);
    expect(DEFAULT_CONFIG.findingComparison!.fallback).toBe("heuristic");
  });
});

describe("findingComparison config", () => {
  it("DEFAULT_FINDING_COMPARISON_CONFIG has correct defaults", () => {
    expect(DEFAULT_FINDING_COMPARISON_CONFIG).toEqual({
      method: "llm",
      model: "claude-haiku-4-5",
      timeoutMs: 60000,
      fallback: "heuristic",
    });
  });

  it("loadBaseConfig includes findingComparison from default.json", () => {
    const config = loadConfig();
    expect(config.findingComparison).toBeDefined();
    expect(config.findingComparison!.method).toBe("llm");
    expect(config.findingComparison!.model).toBe("claude-haiku-4-5");
    expect(config.findingComparison!.timeoutMs).toBe(60000);
    expect(config.findingComparison!.fallback).toBe("heuristic");
  });

  it("loadConfig merges findingComparison overrides", () => {
    const config = loadConfig({
      findingComparison: { method: "heuristic" },
    });
    expect(config.findingComparison!.method).toBe("heuristic");
    // Other defaults preserved
    expect(config.findingComparison!.model).toBe("claude-haiku-4-5");
    expect(config.findingComparison!.timeoutMs).toBe(60000);
    expect(config.findingComparison!.fallback).toBe("heuristic");
  });

  it("loadConfig can override model and timeoutMs", () => {
    const config = loadConfig({
      findingComparison: { model: "claude-sonnet-4-20250514", timeoutMs: 90000 },
    });
    expect(config.findingComparison!.model).toBe("claude-sonnet-4-20250514");
    expect(config.findingComparison!.timeoutMs).toBe(90000);
    // method stays default
    expect(config.findingComparison!.method).toBe("llm");
  });

  it("loadConfig can override fallback to error", () => {
    const config = loadConfig({
      findingComparison: { fallback: "error" },
    });
    expect(config.findingComparison!.fallback).toBe("error");
  });
});
