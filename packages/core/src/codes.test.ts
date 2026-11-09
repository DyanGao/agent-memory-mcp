import { describe, expect, it } from "vitest";
import { codeWords } from "./codes.js";

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
