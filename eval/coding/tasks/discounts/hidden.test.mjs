import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDiscounts } from "./src/discounts.mjs";

test("applies percentages one after the other", () => {
  const result = applyDiscounts(100, { loyaltyPercent: 10, couponPercent: 10 });
  assert.ok(Math.abs(result - 81) < 1e-9, `got ${result}`);
});

test("caps the combined discount at 30%", () => {
  const result = applyDiscounts(100, { loyaltyPercent: 20, couponPercent: 20 });
  assert.ok(Math.abs(result - 70) < 1e-9, `got ${result}`);
});
