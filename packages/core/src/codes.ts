const WORD = /[\p{L}\p{N}][\p{L}\p{N}_-]*[\p{L}\p{N}]/gu;
const DOTTED = /\p{L}[\p{L}\p{N}_]*(?:\.[\p{L}\p{N}_]+)+/gu;
const MIN_CODE_LENGTH = 4;

/**
 * Shapes of word that count as an exact identifier:
 * - digit: holds a digit, as error codes, ticket ids and hex values do
 * - snake: letters joined by an underscore, as in ERR_CONN_RESET or max_retry_count
 * - camel: a lower-case letter followed by a capital, as in getUserById
 * - dotted: words joined by dots, as in billing.queue.timeout
 */
export type CodeShape = "digit" | "snake" | "camel" | "dotted";

export const DEFAULT_CODE_SHAPES: readonly CodeShape[] = [
  "digit",
  "snake",
  "camel",
  "dotted",
];

const SHAPES: Record<Exclude<CodeShape, "dotted">, RegExp> = {
  digit: /\d/,
  snake: /\p{L}_\p{L}/u,
  camel: /\p{Ll}\p{Lu}/u,
};

/**
 * Words that look like exact identifiers, at least 4 characters long (dotted
 * ones aside). "E5901", "ERR_CONN_RESET", "getUserById" and
 * "billing.queue.timeout" count, and "3", "v2" or "read-only" do not. Brand
 * names such as "YouTube" count as camel case; on the tuning set that cost
 * plain questions nothing.
 */
export function codeWords(
  query: string,
  shapes: readonly CodeShape[] = DEFAULT_CODE_SHAPES,
): string[] {
  const found = new Set<string>();
  const tests = shapes.flatMap((shape) =>
    shape === "dotted" ? [] : [SHAPES[shape]],
  );
  for (const word of query.match(WORD) ?? []) {
    if (
      word.length >= MIN_CODE_LENGTH &&
      tests.some((test) => test.test(word))
    ) {
      found.add(word);
    }
  }
  if (shapes.includes("dotted")) {
    for (const word of query.match(DOTTED) ?? []) found.add(word);
  }
  return [...found];
}

/**
 * How much a keyword rank counts in fusion. A query with codes can weigh
 * keywords more, so an exact code match outranks vector results that only
 * look alike, without changing how plain questions are ranked.
 */
export function keywordWeight(
  codes: string[],
  weights: { textWeight: number; codeWeight?: number | undefined },
): number {
  return codes.length > 0
    ? (weights.codeWeight ?? weights.textWeight)
    : weights.textWeight;
}
