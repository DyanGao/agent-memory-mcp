import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/.tsbuild/**", "**/node_modules/**", "eval/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
