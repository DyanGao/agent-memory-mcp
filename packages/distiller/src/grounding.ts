const STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "been",
  "before",
  "from",
  "have",
  "into",
  "must",
  "only",
  "over",
  "should",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "under",
  "were",
  "what",
  "when",
  "which",
  "will",
  "with",
  "would",
  "your",
]);

// Leaves room for a model to rephrase, and catches text from nowhere.
const MIN_WORDS_FOUND = 0.6;
const STEM_LENGTH = 5;

const stem = (word: string): string => word.slice(0, STEM_LENGTH);

function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).flatMap((word) =>
    word.split("-"),
  );
}

const significant = (text: string): string[] =>
  words(text).filter((word) => word.length >= 4 && !STOP_WORDS.has(word));

const numbers = (text: string): string[] =>
  text.match(/\d+(?:[.:]\d+)*/g) ?? [];

/**
 * Whether a memory could have come from this text. A model can copy text from
 * its own prompt, or invent it, and a memory store must not state what nobody
 * said. Numbers must match exactly, as a wrong number looks most like a fact.
 */
export function isGrounded(content: string, source: string): boolean {
  const known = new Set(numbers(source));
  if (!numbers(content).every((value) => known.has(value))) return false;

  const wanted = significant(content);
  if (wanted.length === 0) return true;
  const available = new Set(significant(source).map(stem));
  const found = wanted.filter((word) => available.has(stem(word))).length;
  return found / wanted.length >= MIN_WORDS_FOUND;
}

/** Whether a text holds a significant word or number the other does not. */
export function saysSomethingNew(content: string, existing: string): boolean {
  const seen = new Set(significant(existing).map(stem));
  const known = new Set(numbers(existing));
  return (
    significant(content).some((word) => !seen.has(stem(word))) ||
    numbers(content).some((value) => !known.has(value))
  );
}
