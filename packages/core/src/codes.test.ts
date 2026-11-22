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

describe("codeWords with more shapes", () => {
  const all = ["digit", "snake", "camel", "dotted"] as const;

  it.each([
    ["Why does ERR_CONN_RESET keep showing up?", ["ERR_CONN_RESET"]],
    ["What is max_retry_count set to?", ["max_retry_count"]],
    ["getUserById throws in the worker", ["getUserById"]],
    ["Seen InvoiceLockTimeoutError before?", ["InvoiceLockTimeoutError"]],
    ["What does billing.queue.timeout do?", ["billing.queue.timeout"]],
    ["E5901 and ERR_CONN_RESET again", ["E5901", "ERR_CONN_RESET"]],
  ])("finds the identifier in %j", (query, expected) => {
    expect(codeWords(query, all)).toEqual(expected);
  });

  it.each([
    "How did the kubernetes deploy go?",
    "I moved to a new place. It was big.",
    "the read-only replica",
  ])("finds no identifier in %j", (query) => {
    expect(codeWords(query, all)).toEqual([]);
  });

  it("finds digit-free identifiers by default", () => {
    expect(codeWords("ERR_CONN_RESET in getUserById")).toEqual([
      "ERR_CONN_RESET",
      "getUserById",
    ]);
  });

  it("leaves digit-free identifiers alone with the digit shape only", () => {
    expect(codeWords("ERR_CONN_RESET in getUserById", ["digit"])).toEqual([]);
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
