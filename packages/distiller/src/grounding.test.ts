import { describe, expect, it } from "vitest";
import {
  isGrounded,
  isSafeReplacement,
  saysSomethingNew,
} from "./grounding.js";

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

describe("isSafeReplacement", () => {
  it("allows a stated change that keeps the details", () => {
    expect(
      isSafeReplacement(
        "The badge prefix is STF now instead of EMP.",
        "The badge prefix is STF.",
        "Badges look like STF-0421-B: STF, a four-digit number and a site letter.",
        [
          "Badges look like EMP-0421-B: EMP, a four-digit number and a site letter.",
        ],
      ),
    ).toBe(true);
  });

  it("allows a full replacement that names the old value", () => {
    expect(
      isSafeReplacement(
        "We replaced Memcached with Redis for the cache.",
        "The cache uses Redis.",
        "The cache uses Redis.",
        ["The cache uses Memcached."],
      ),
    ).toBe(true);
  });

  it("refuses when no change was stated", () => {
    expect(
      isSafeReplacement(
        "Refurbished items only get 6 months of warranty.",
        "Refurbished items get 6 months of warranty.",
        "The warranty runs for 6 months on refurbished items.",
        ["Our warranty runs for 24 months."],
      ),
    ).toBe(false);
  });

  it("refuses to absorb a memory about something else", () => {
    expect(
      isSafeReplacement(
        "Refurbished warranty is 6 months now.",
        "Refurbished warranty is 6 months.",
        "Refurbished warranty is 6 months. Trials last 10 days without credit card.",
        ["Trials last 10 days without credit card."],
      ),
    ).toBe(false);
  });

  it("refuses when the old details disappear", () => {
    expect(
      isSafeReplacement(
        "Also, we ship to Switzerland from now on.",
        "We ship to Switzerland.",
        "We ship to Switzerland.",
        ["We ship to customers inside the European Union."],
      ),
    ).toBe(false);
  });

  it("allows a merge that keeps both", () => {
    expect(
      isSafeReplacement(
        "Also, we ship to Switzerland from now on.",
        "We ship to Switzerland.",
        "We ship to customers inside the European Union and to Switzerland.",
        ["We ship to customers inside the European Union."],
      ),
    ).toBe(true);
  });
});
