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
  createdAt: Date;
  importance: number;
}

export interface ScoreBreakdown {
  vectorRank: number | null;
  textRank: number | null;
  relevance: number;
  recency: number;
  importance: number;
  total: number;
}

function reciprocalRank(rank: number | undefined): number {
  return rank === undefined ? 0 : 1 / (RRF_K + rank);
}

/** Reciprocal rank fusion, scaled so ranking first in both lists gives 1. */
function relevanceScore(candidate: Candidate): number {
  const best = 2 / (RRF_K + 1);
  return (
    (reciprocalRank(candidate.vectorRank) +
      reciprocalRank(candidate.textRank)) /
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
): ScoreBreakdown {
  const relevance = relevanceScore(candidate);
  const recency = recencyScore(candidate.createdAt, now);
  return {
    vectorRank: candidate.vectorRank ?? null,
    textRank: candidate.textRank ?? null,
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
