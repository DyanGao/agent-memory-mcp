import assert from "node:assert/strict";
import { test } from "node:test";
import { invoiceVat } from "./src/invoice.mjs";

test("uses the current rate", () => {
  assert.equal(invoiceVat([100]), 21);
});

test("rounds each line, not the total", () => {
  // Per line: 0.0063 rounds to 0.01, so 0.03. On the total it would be 0.02.
  assert.equal(invoiceVat([0.03, 0.03, 0.03]), 0.03);
});

test("rounds exact halves to even", () => {
  // 2.5 * 0.21 = 0.525 exactly, which half-even takes down to 0.52.
  assert.equal(invoiceVat([2.5]), 0.52);
});
