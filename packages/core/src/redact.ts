interface Rule {
  kind: string;
  pattern: RegExp;
}

// Order matters: specific formats first, so a generic rule cannot claim
// part of a match and leave the rest of a secret behind.
const RULES: Rule[] = [
  {
    kind: "private_key",
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: "anthropic_key", pattern: /\bsk-ant-[\w-]{16,}/g },
  { kind: "openai_key", pattern: /\bsk-(?:proj-)?[\w-]{20,}/g },
  { kind: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { kind: "github_token", pattern: /\bgithub_pat_\w{20,}/g },
  { kind: "aws_key", pattern: /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g },
  { kind: "slack_token", pattern: /\bxox[abeoprs]-[\w-]{10,}/g },
  {
    kind: "jwt",
    pattern: /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g,
  },
  {
    kind: "connection_string",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@[^\s'"]+/gi,
  },
  { kind: "bearer_token", pattern: /\bBearer\s+[\w.~+/-]{12,}=*/g },
  {
    kind: "credential",
    pattern:
      /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b["']?\s*[:=]\s*["']?[^\s"',;]{4,}/gi,
  },
  {
    // Secrets stated in words, as in "the password for staging is X". The value
    // must hold a digit, so "the password is required" is left alone.
    kind: "credential",
    pattern:
      /\b(?:password|passwd|passphrase|pwd|token|secret|api[ _-]?key)\b(?:\s+(?!is\b|was\b)[\w-]+){0,4}?\s+(?:is|was)\s+["']?(?=[^\s"',;]*\d)[^\s"',;]+?(?=[.,;]?(?:\s|$))/gi,
  },
  {
    // The same with no verb, as in "the admin password Juniper-4402-LM". Only
    // the word right after the keyword counts, and it needs a letter, a digit
    // and 8 or more characters, so "token v2" and "password field" are left.
    kind: "credential",
    pattern:
      /\b(?:password|passwd|passphrase|pwd|token|secret|api[ _-]?key)\s+["']?(?=[^\s"',;]*\d)(?=[^\s"',;]*[A-Za-z])[^\s"',;]{8,}?(?=[.,;]?(?:\s|$))/gi,
  },
  { kind: "email", pattern: /\b[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g },
];

export interface RedactOptions {
  /** Site-specific patterns. They must use the g flag. */
  extraPatterns?: RegExp[];
}

export interface RedactResult {
  text: string;
  count: number;
}

/**
 * Removes secrets and direct identifiers. A filter like this reduces risk
 * but cannot promise to catch everything, so forget remains the real remedy.
 */
export function redact(
  input: string,
  options: RedactOptions = {},
): RedactResult {
  const rules = [
    ...RULES,
    ...(options.extraPatterns ?? []).map((pattern) => ({
      kind: "custom",
      pattern,
    })),
  ];

  let text = input;
  let count = 0;
  for (const { kind, pattern } of rules) {
    text = text.replace(pattern, () => {
      count += 1;
      return `[REDACTED:${kind}]`;
    });
  }
  return { text, count };
}
