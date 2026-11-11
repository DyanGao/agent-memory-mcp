import { describe, expect, it } from "vitest";
import { redact } from "./redact.js";

describe("redact", () => {
  it.each([
    ["Anthropic key", "key sk-ant-api03-abcDEF123456789012345678"],
    ["OpenAI key", "key sk-proj-abcDEF1234567890abcDEF12"],
    ["GitHub token", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["GitHub PAT", "github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz"],
    ["AWS key", "AKIAIOSFODNN7EXAMPLE"],
    ["Slack token", "xoxb-1234567890-abcdefghijkl"],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc123DEF456ghi789"],
    ["bearer header", "Authorization: Bearer abc123def456ghi789jkl"],
    ["password assignment", "password=hunter2secret"],
    ["API key assignment", 'api_key: "abcd1234efgh"'],
    ["connection string", "postgres://admin:s3cret@db.internal:5432/prod"],
    ["email", "reach me at jane.doe@example.com"],
    [
      "private key",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
    ],
  ])("removes a %s", (_name, input) => {
    expect(redact(input).text).toContain("[REDACTED:");
  });

  it("removes the secret value itself", () => {
    const { text } = redact("password=hunter2secret");
    expect(text).not.toContain("hunter2secret");
  });

  it("keeps the user part out of a connection string", () => {
    const { text } = redact("postgres://admin:s3cret@db.internal:5432/prod");
    expect(text).not.toContain("s3cret");
  });

  it("leaves ordinary text alone", () => {
    const input =
      "We use port 5433 and the password policy lives in docs/auth.md";
    expect(redact(input)).toEqual({ text: input, count: 0 });
  });

  it.each([
    [
      "The admin password for staging is Tangerine-4417, keep it handy.",
      "Tangerine-4417",
    ],
    ["The root token for the vault is Larkspur-9032-ZX.", "Larkspur-9032-ZX"],
    ["our api key was Qx7-plum-88", "Qx7-plum-88"],
    [
      "logging in with the staging admin password Juniper-4402-LM fixed it.",
      "Juniper-4402-LM",
    ],
    ["Use the api key Zt93-fern-41 for the sandbox.", "Zt93-fern-41"],
    ["The vault token Hollow7Pine2Dusk opens it.", "Hollow7Pine2Dusk"],
  ])("removes a secret stated in words: %s", (input, secret) => {
    expect(redact(input).text).not.toContain(secret);
  });

  it.each([
    "Passwords are hashed with Argon2id.",
    "The password is required on every login.",
    "The admin password for staging is rotated monthly.",
    "Every token is checked for expiry.",
    "The password field accepts 64 characters.",
    "Password reset emails go out within 5 minutes.",
    "The token v2 format is documented.",
    "Rotate the api key quarterly per ISO27001 guidance.",
    "The secret santa draw is on 2026-12-01.",
  ])("keeps a sentence about secrets that holds none: %s", (input) => {
    expect(redact(input)).toEqual({ text: input, count: 0 });
  });

  it("counts every redaction", () => {
    expect(redact("a@b.co and c@d.co").count).toBe(2);
  });

  it("applies extra patterns from configuration", () => {
    const { text } = redact("customer ACME-4471 called", {
      extraPatterns: [/ACME-\d+/g],
    });
    expect(text).toBe("customer [REDACTED:custom] called");
  });
});
