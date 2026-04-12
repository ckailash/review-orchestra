import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface ToolchainInfo {
  language: string;
  commands: { name: string; command: string; description: string }[];
}

export function detectToolchain(rootDir: string = process.cwd()): ToolchainInfo {
  // Node/TypeScript
  if (existsSync(join(rootDir, "package.json"))) {
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf-8"));
    } catch {
      return { language: "unknown", commands: [] };
    }
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const commands: ToolchainInfo["commands"] = [];

    if (scripts.test) {
      commands.push({ name: "test", command: "npm test", description: "Run test suite" });
    }
    if (scripts.lint) {
      commands.push({ name: "lint", command: "npm run lint", description: "Run linter/type checker" });
    }
    if (scripts.build) {
      commands.push({ name: "build", command: "npm run build", description: "Build the project" });
    }
    if (scripts.typecheck || scripts["type-check"]) {
      const cmd = scripts.typecheck ? "npm run typecheck" : "npm run type-check";
      commands.push({ name: "typecheck", command: cmd, description: "Run type checking" });
    }

    const hasTsConfig = existsSync(join(rootDir, "tsconfig.json"));
    const lang = hasTsConfig ? "TypeScript" : "JavaScript";

    if (hasTsConfig && !commands.some((c) => c.name === "typecheck" || c.name === "lint")) {
      commands.push({ name: "typecheck", command: "npx tsc --noEmit", description: "Type check with TypeScript compiler" });
    }

    return { language: lang, commands };
  }

  // Rust
  if (existsSync(join(rootDir, "Cargo.toml"))) {
    return {
      language: "Rust",
      commands: [
        { name: "check", command: "cargo check", description: "Type check without building" },
        { name: "test", command: "cargo test", description: "Run test suite" },
        { name: "clippy", command: "cargo clippy", description: "Run Rust linter" },
      ],
    };
  }

  // Go
  if (existsSync(join(rootDir, "go.mod"))) {
    return {
      language: "Go",
      commands: [
        { name: "build", command: "go build ./...", description: "Build all packages" },
        { name: "test", command: "go test ./...", description: "Run test suite" },
        { name: "vet", command: "go vet ./...", description: "Run Go vet" },
      ],
    };
  }

  // Python
  if (existsSync(join(rootDir, "pyproject.toml")) || existsSync(join(rootDir, "setup.py"))) {
    const commands: ToolchainInfo["commands"] = [];

    if (existsSync(join(rootDir, "pyproject.toml"))) {
      const pyproject = readFileSync(join(rootDir, "pyproject.toml"), "utf-8");
      if (/\bpytest\b/.test(pyproject)) {
        commands.push({ name: "test", command: "pytest", description: "Run test suite" });
      }
      if (/\bruff\b/.test(pyproject)) {
        commands.push({ name: "lint", command: "ruff check .", description: "Run Ruff linter" });
      }
      if (/\bmypy\b/.test(pyproject)) {
        commands.push({ name: "typecheck", command: "mypy .", description: "Run type checker" });
      }
    }

    if (commands.length === 0) {
      commands.push({ name: "test", command: "python -m pytest", description: "Run test suite" });
    }

    return { language: "Python", commands };
  }

  return { language: "unknown", commands: [] };
}

export function formatToolchainContext(info: ToolchainInfo): string {
  if (info.commands.length === 0) return "";

  const lines = [
    `\n## Repository Toolchain (${info.language})`,
    "",
    "You can verify your findings by running these commands with the Bash tool:",
    "",
  ];

  for (const cmd of info.commands) {
    lines.push(`- **${cmd.description}**: \`${cmd.command}\``);
  }

  lines.push("");
  lines.push(
    "Use these to verify suspected issues — for example, run tests to confirm a bug, or run the type checker to verify a type error."
  );

  return lines.join("\n");
}
