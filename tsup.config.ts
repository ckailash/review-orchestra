import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/orchestrator.ts", "src/scope.ts", "src/config.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    sourcemap: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);
