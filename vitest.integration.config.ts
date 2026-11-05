import { defineConfig } from "vitest/config";

// Needs a running Docker daemon: these tests start a real pgvector container.
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
    include: ["packages/*/src/**/*.int.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
