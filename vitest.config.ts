import { defineConfig } from "vitest/config";

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
    include: ["packages/*/src/**/*.test.ts"],
    exclude: [
      "**/*.int.test.ts",
      "**/*.scale.test.ts",
      "**/node_modules/**",
      "**/dist/**",
    ],
  },
});
