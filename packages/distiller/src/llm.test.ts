import { describe, expect, it } from "vitest";
import { createProvider } from "./llm.js";

describe("createProvider", () => {
  it("treats Ollama as local", () => {
    const provider = createProvider("ollama:qwen3", "http://localhost:11434");
    expect(provider).toMatchObject({ name: "ollama:qwen3", hosted: false });
  });

  it("keeps a model name that contains a colon", () => {
    const provider = createProvider(
      "ollama:qwen3:8b",
      "http://localhost:11434",
    );
    expect(provider.name).toBe("ollama:qwen3:8b");
  });

  it("rejects a spec with no provider", () => {
    expect(() => createProvider("qwen3", "x")).toThrow(/provider:model/);
  });

  it("rejects an unknown provider", () => {
    expect(() => createProvider("acme:big", "x")).toThrow(/Unknown provider/);
  });
});
