import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { detectToolchain, formatToolchainContext } from "../src/toolchain";

const TEST_DIR = "/tmp/review-orchestra-test-toolchain";

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("detectToolchain", () => {
  it("detects Node.js/TypeScript project with scripts", () => {
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest", lint: "eslint .", build: "tsc" },
      })
    );
    writeFileSync(join(TEST_DIR, "tsconfig.json"), "{}");

    const info = detectToolchain(TEST_DIR);
    expect(info.language).toBe("TypeScript");
    expect(info.commands).toHaveLength(3);
    expect(info.commands.map((c) => c.name)).toEqual(["test", "lint", "build"]);
  });

  it("detects plain JavaScript (no tsconfig)", () => {
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ scripts: { test: "jest" } })
    );

    const info = detectToolchain(TEST_DIR);
    expect(info.language).toBe("JavaScript");
  });

  it("adds tsc --noEmit for TS projects without lint/typecheck scripts", () => {
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } })
    );
    writeFileSync(join(TEST_DIR, "tsconfig.json"), "{}");

    const info = detectToolchain(TEST_DIR);
    expect(info.commands.some((c) => c.command === "npx tsc --noEmit")).toBe(true);
  });

  it("detects Rust project", () => {
    writeFileSync(join(TEST_DIR, "Cargo.toml"), "[package]\nname = \"test\"");

    const info = detectToolchain(TEST_DIR);
    expect(info.language).toBe("Rust");
    expect(info.commands.map((c) => c.name)).toEqual(["check", "test", "clippy"]);
  });

  it("detects Go project", () => {
    writeFileSync(join(TEST_DIR, "go.mod"), "module example.com/test");

    const info = detectToolchain(TEST_DIR);
    expect(info.language).toBe("Go");
    expect(info.commands.map((c) => c.name)).toEqual(["build", "test", "vet"]);
  });

  it("detects Python project with pytest and ruff", () => {
    writeFileSync(
      join(TEST_DIR, "pyproject.toml"),
      '[tool.pytest]\n[tool.ruff]\n[tool.mypy]'
    );

    const info = detectToolchain(TEST_DIR);
    expect(info.language).toBe("Python");
    expect(info.commands.map((c) => c.name)).toEqual(["test", "lint", "typecheck"]);
  });

  it("returns unknown for unrecognized project", () => {
    const info = detectToolchain(TEST_DIR);
    expect(info.language).toBe("unknown");
    expect(info.commands).toEqual([]);
  });
});

describe("formatToolchainContext", () => {
  it("returns empty string for no commands", () => {
    expect(formatToolchainContext({ language: "unknown", commands: [] })).toBe("");
  });

  it("formats commands into markdown", () => {
    const output = formatToolchainContext({
      language: "TypeScript",
      commands: [
        { name: "test", command: "npm test", description: "Run test suite" },
      ],
    });
    expect(output).toContain("TypeScript");
    expect(output).toContain("`npm test`");
    expect(output).toContain("Run test suite");
  });
});
