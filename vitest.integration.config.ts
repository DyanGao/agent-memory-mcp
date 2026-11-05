import { defineConfig } from "vitest/config";

// Needs a running Docker daemon: these tests start a real pgvector container.
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.int.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
