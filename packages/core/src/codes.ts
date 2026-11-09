const WORD = /[\p{L}\p{N}][\p{L}\p{N}_-]*[\p{L}\p{N}]/gu;
const MIN_CODE_LENGTH = 4;

/**
 * Words that look like exact identifiers: error codes, ticket ids, hex values.
 * A word counts if it has a digit and at least 4 characters, so "E5901",
 * "INV_183" and "0xE0A9" do, and "3" or "v2" do not.
 */
export function codeWords(query: string): string[] {
  return (query.match(WORD) ?? []).filter(
    (word) => word.length >= MIN_CODE_LENGTH && /\d/.test(word),
  );
}
