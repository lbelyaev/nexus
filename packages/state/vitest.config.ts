import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    root: path.dirname(new URL(import.meta.url).pathname),
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 75,
        statements: 75,
        branches: 63,
        functions: 85,
      },
    },
  },
});
