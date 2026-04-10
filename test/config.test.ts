import { describe, it, expect } from "vitest";
import { loadConfig, DEFAULT_CONFIG } from "../src/config";
import type { Config } from "../src/types";

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

  it("DEFAULT_CONFIG is a frozen reference", () => {
    const a = DEFAULT_CONFIG;
    const b = DEFAULT_CONFIG;
    expect(a).toBe(b);
    expect(a.thresholds.stopAt).toBe("p1");
  });
});
