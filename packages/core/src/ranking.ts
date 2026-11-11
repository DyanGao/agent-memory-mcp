const RRF_K = 60;
const RECENCY_HALF_LIFE_DAYS = 30;
const MS_PER_DAY = 86_400_000;
const CHARS_PER_TOKEN = 4;

const WEIGHT_RELEVANCE = 0.7;
const WEIGHT_RECENCY = 0.15;
const WEIGHT_IMPORTANCE = 0.15;

export interface Candidate {
  id: string;
  /** 1-based rank in the vector results, if it appeared there. */
  vectorRank?: number;
  /** 1-based rank in the full-text results, if it appeared there. */
  textRank?: number;
  /** Cosine similarity to the query, if it appeared in the vector results. */
  similarity?: number;
  createdAt: Date;
  importance: number;
}

export interface ScoreBreakdown {
  vectorRank: number | null;
  textRank: number | null;
  /**
   * Cosine similarity to the query, from -1 to 1. Unlike the ranks, it does
   * not depend on what else is stored, so it can say a match is weak.
   */
  similarity: number | null;
  relevance: number;
  recency: number;
  importance: number;
  total: number;
}

function reciprocalRank(rank: number | undefined): number {
  return rank === undefined ? 0 : 1 / (RRF_K + rank);
}

export interface FusionOptions {
  /** How much a text rank counts against a vector rank, which counts 1. */
  textWeight?: number | undefined;
}

/** Reciprocal rank fusion, scaled so ranking first in both lists gives 1. */
function relevanceScore(candidate: Candidate, textWeight: number): number {
  const best = (1 + textWeight) / (RRF_K + 1);
  return (
    (reciprocalRank(candidate.vectorRank) +
      textWeight * reciprocalRank(candidate.textRank)) /
    best
  );
}

function recencyScore(createdAt: Date, now: Date): number {
  const ageDays = Math.max(0, now.getTime() - createdAt.getTime()) / MS_PER_DAY;
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

export function scoreCandidate(
  candidate: Candidate,
  now: Date,
  options: FusionOptions = {},
): ScoreBreakdown {
  const relevance = relevanceScore(candidate, options.textWeight ?? 1);
  const recency = recencyScore(candidate.createdAt, now);
  return {
    vectorRank: candidate.vectorRank ?? null,
    textRank: candidate.textRank ?? null,
    similarity: candidate.similarity ?? null,
    relevance,
    recency,
    importance: candidate.importance,
    total:
      WEIGHT_RELEVANCE * relevance +
      WEIGHT_RECENCY * recency +
      WEIGHT_IMPORTANCE * candidate.importance,
  };
}

/** Approximate, and good enough for a budget. Eval reports measured tokens. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Takes items in order, skipping any that would exceed the budget. */
export function packToBudget<T extends { content: string }>(
  items: T[],
  maxTokens: number,
): T[] {
  const packed: T[] = [];
  let used = 0;
  for (const item of items) {
    const cost = estimateTokens(item.content);
    if (used + cost > maxTokens) continue;
    packed.push(item);
    used += cost;
  }
  return packed;
}
