import { defineConfig } from "vitest/config";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    root: dirname(fileURLToPath(import.meta.url)),
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 90,
        statements: 90,
        branches: 68,
        functions: 92,
      },
    },
  },
});
