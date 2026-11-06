import assert from "node:assert/strict";
import { test } from "node:test";
import { invoiceVat } from "./src/invoice.mjs";

test("calculates per line at 19%", () => {
  assert.equal(invoiceVat([100]), 19);
  // Per line: 0.19 + 0.19 + 0.19 = 0.57. On the total it would be the same,
  // so the next case separates them.
  assert.equal(invoiceVat([1, 1, 1]), 0.57);
});

test("rounds each line, not the total", () => {
  // 0.03 * 0.19 = 0.0057 rounds to 0.01 per line, so 0.03 for three lines.
  // On the total: 0.09 * 0.19 = 0.0171, which would round to 0.02.
  assert.equal(invoiceVat([0.03, 0.03, 0.03]), 0.03);
});

test("rounds exact halves to even", () => {
  // 2.5 * 0.19 = 0.475, half-even gives 0.48. 7.5 * 0.19 = 1.425 gives 1.42.
  assert.equal(invoiceVat([7.5]), 1.42);
});
