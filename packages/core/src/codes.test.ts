import { describe, expect, it } from "vitest";
import { codeWords, keywordWeight } from "./codes.js";

describe("codeWords", () => {
  it.each([
    ["Seeing E5901 in the logs, any idea?", ["E5901"]],
    ["Why does TCK-45675 keep showing up?", ["TCK-45675"]],
    ["Any notes on INV_183?", ["INV_183"]],
    ["What causes 0xE0A9?", ["0xE0A9"]],
    ["QZK-27F and E5901 again", ["QZK-27F", "E5901"]],
  ])("finds the code in %j", (query, expected) => {
    expect(codeWords(query)).toEqual(expected);
  });

  it.each([
    "How did the kubernetes deploy go?",
    "I bought 3 shirts",
    "the v2 api",
  ])("finds no code in %j", (query) => {
    expect(codeWords(query)).toEqual([]);
  });
});

describe("keywordWeight", () => {
  it("uses the code weight when the query has a code", () => {
    expect(keywordWeight(["E5901"], { textWeight: 0.5, codeWeight: 1 })).toBe(
      1,
    );
  });

  it("uses the text weight when the query has no code", () => {
    expect(keywordWeight([], { textWeight: 0.5, codeWeight: 1 })).toBe(0.5);
  });

  it("falls back to the text weight when no code weight is set", () => {
    expect(keywordWeight(["E5901"], { textWeight: 0.25 })).toBe(0.25);
  });
});
