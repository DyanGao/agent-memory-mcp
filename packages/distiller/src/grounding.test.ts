import { describe, expect, it } from "vitest";
import { isGrounded, saysSomethingNew } from "./grounding.js";

const source =
  "user: Decision: nightly backups run at 02:00 UTC and are kept for 14 days.";

describe("isGrounded", () => {
  it("accepts a close restatement", () => {
    expect(isGrounded("Backups run nightly at 02:00 UTC.", source)).toBe(true);
  });

  it("accepts a rephrasing that keeps most words", () => {
    expect(
      isGrounded("Nightly backups are retained for 14 days.", source),
    ).toBe(true);
  });

  it("rejects text copied from somewhere else", () => {
    expect(
      isGrounded("Exports exclude reports from before 2020.", source),
    ).toBe(false);
  });

  it("rejects a changed number even if the words match", () => {
    expect(isGrounded("Nightly backups are kept for 30 days.", source)).toBe(
      false,
    );
  });

  it("rejects a changed time", () => {
    expect(isGrounded("Nightly backups run at 03:00 UTC.", source)).toBe(false);
  });

  it("accepts a memory too short to judge by words", () => {
    expect(isGrounded("Use tabs.", "user: use tabs in go files")).toBe(true);
  });
});

describe("saysSomethingNew", () => {
  it("finds a word the existing text lacks", () => {
    expect(
      saysSomethingNew(
        "Accounts with status dispute are never purged.",
        "1. Accounts with status legal_hold are never purged.",
      ),
    ).toBe(true);
  });

  it("finds a changed number", () => {
    expect(saysSomethingNew("Limit is 52.", "Limit is 37.")).toBe(true);
  });

  it("sees a plain repeat as nothing new", () => {
    expect(
      saysSomethingNew(
        "Purged after deletion.",
        "Accounts are purged after deletion.",
      ),
    ).toBe(false);
  });
});
