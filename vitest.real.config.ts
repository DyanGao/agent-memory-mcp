import { defineConfig } from "vitest/config";

// Needs a running Docker daemon: also needs Ollama with qwen3 and bge-m3, so it is run by hand, not in CI.
export default defineConfig({
  resolve: {
    alias: {
      "@agent-memory/core/testing": new URL(
        "./packages/core/src/testing.ts",
        import.meta.url,
      ).pathname,
      "@agent-memory/core": new URL(
        "./packages/core/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    include: ["packages/*/src/**/*.real.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
