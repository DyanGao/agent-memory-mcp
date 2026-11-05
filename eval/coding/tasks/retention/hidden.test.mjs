import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldPurge } from "./src/retention.mjs";

const day = 86_400_000;
const now = new Date("2026-06-01T00:00:00Z");
const deleted = (days) => new Date(now.getTime() - days * day);

test("purges after 45 days, not before", () => {
  assert.equal(shouldPurge({ deletedAt: deleted(44), status: "closed" }, now), false);
  assert.equal(shouldPurge({ deletedAt: deleted(46), status: "closed" }, now), true);
});

test("never purges a legal hold", () => {
  assert.equal(shouldPurge({ deletedAt: deleted(900), status: "legal_hold" }, now), false);
});

test("keeps accounts that were not deleted", () => {
  assert.equal(shouldPurge({ deletedAt: null, status: "closed" }, now), false);
});
