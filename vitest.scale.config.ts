import { defineConfig } from "vitest/config";

// Needs a running Docker daemon: seeds a real pgvector container, so it is run by hand, not in CI.
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
    include: ["packages/*/src/**/*.scale.test.ts"],
    testTimeout: 7_200_000,
    hookTimeout: 7_200_000,
  },
});
