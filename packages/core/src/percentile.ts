export function estimateP95Ms(timings: number[]): number {
  const sorted = [...timings].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}
