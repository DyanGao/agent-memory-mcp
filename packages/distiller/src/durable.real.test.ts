import { describe, expect, it } from "vitest";
import { isLasting } from "./durable.js";
import { OllamaProvider } from "./llm.js";

const llm = new OllamaProvider("qwen3", "http://127.0.0.1:11434");

describe("lasting check with real qwen3", () => {
  it.each([
    "Invoices are archived for 10 years.",
    "Use pnpm, not npm.",
    "The internal admin API has its own limit of 200 requests per minute.",
    "Widget size is now 20, replacing 30.",
    "The rate limit is now 52, not 37.",
  ])("keeps: %s", async (note) => {
    expect(await isLasting(llm, note)).toBe(true);
  });

  it.each([
    "Lena liked the new cart page.",
    "Split the navbar into two files.",
    "Omar is out until Monday.",
    "Priya asked about the sidebar this morning.",
  ])("drops: %s", async (note) => {
    expect(await isLasting(llm, note)).toBe(false);
  });
});
