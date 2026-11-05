import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDiscounts } from "./src/discounts.mjs";

test("takes the loyalty percentage first, then the coupon", () => {
  const result = applyDiscounts(100, { loyaltyPercent: 10, couponAmount: 5 });
  assert.ok(Math.abs(result - 85) < 1e-9, `got ${result}`);
});

test("caps the combined discount at 30%, not the partner cap", () => {
  const result = applyDiscounts(100, { loyaltyPercent: 20, couponAmount: 20 });
  assert.ok(Math.abs(result - 70) < 1e-9, `got ${result}`);
});
