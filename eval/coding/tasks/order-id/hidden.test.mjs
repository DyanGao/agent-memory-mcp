import assert from "node:assert/strict";
import { test } from "node:test";
import { nextOrderId } from "./src/orderid.mjs";

const in2026 = new Date("2026-06-01T12:00:00Z");

test("starts at 1 in the agreed format", () => {
  assert.equal(nextOrderId(in2026, null), "ORD-2026-000001");
});

test("increments within a year", () => {
  assert.equal(nextOrderId(in2026, "ORD-2026-000041"), "ORD-2026-000042");
});

test("restarts in a new year", () => {
  const in2027 = new Date("2027-02-01T12:00:00Z");
  assert.equal(nextOrderId(in2027, "ORD-2026-000900"), "ORD-2027-000001");
});
