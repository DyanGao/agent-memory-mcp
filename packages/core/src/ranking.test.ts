import { describe, expect, it } from "vitest";
import { estimateTokens, packToBudget, scoreCandidate } from "./ranking.js";

const now = new Date("2026-11-05T00:00:00Z");
const base = { id: "a", createdAt: now, importance: 0.5 };

describe("scoreCandidate", () => {
  it("gives relevance 1 for first place in both lists", () => {
    const score = scoreCandidate({ ...base, vectorRank: 1, textRank: 1 }, now);
    expect(score.relevance).toBeCloseTo(1);
  });

  it("scores a result found by both retrievers above one found by either", () => {
    const both = scoreCandidate({ ...base, vectorRank: 3, textRank: 3 }, now);
    const one = scoreCandidate({ ...base, vectorRank: 1 }, now);
    expect(both.total).toBeGreaterThan(one.total);
  });

  it("halves recency after 30 days", () => {
    const old = new Date("2026-10-06T00:00:00Z");
    const score = scoreCandidate(
      { ...base, vectorRank: 1, createdAt: old },
      now,
    );
    expect(score.recency).toBeCloseTo(0.5);
  });

  it("treats a future timestamp as brand new", () => {
    const future = new Date("2027-01-01T00:00:00Z");
    expect(scoreCandidate({ ...base, createdAt: future }, now).recency).toBe(1);
  });

  it("reports null ranks for a list the result was not in", () => {
    const score = scoreCandidate({ ...base, textRank: 2 }, now);
    expect(score.vectorRank).toBeNull();
    expect(score.textRank).toBe(2);
  });
});

describe("packToBudget", () => {
  const item = (tokens: number) => ({ content: "x".repeat(tokens * 4) });

  it("never exceeds the budget", () => {
    const packed = packToBudget([item(60), item(60), item(60)], 100);
    const total = packed.reduce((n, i) => n + estimateTokens(i.content), 0);
    expect(total).toBeLessThanOrEqual(100);
  });

  it("skips an oversized item but keeps later ones that fit", () => {
    const small = item(10);
    expect(packToBudget([item(200), small], 100)).toEqual([small]);
  });

  it("returns nothing for a zero budget", () => {
    expect(packToBudget([item(1)], 0)).toEqual([]);
  });
});
