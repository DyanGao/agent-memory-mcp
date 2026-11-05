import { expect, it } from "vitest";
import { estimateP95Ms } from "./percentile.js";

it("takes the 95th of 100 sorted values", () => {
  const values = Array.from({ length: 100 }, (_, i) => 100 - i);
  expect(estimateP95Ms(values)).toBe(95);
});
