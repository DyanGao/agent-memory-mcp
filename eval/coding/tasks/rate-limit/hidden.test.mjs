import assert from "node:assert/strict";
import { test } from "node:test";
import { createLimiter } from "./src/ratelimit.mjs";

test("allows exactly 37 in a window, then refuses as agreed", () => {
  const limiter = createLimiter();
  for (let i = 0; i < 37; i++) assert.equal(limiter.check("k", 1000 + i).ok, true);
  const refused = limiter.check("k", 2000);
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 429);
  assert.deepEqual(refused.body, { error: "slow_down" });
});

test("the window rolls after 60 seconds, per key", () => {
  const limiter = createLimiter();
  for (let i = 0; i < 37; i++) limiter.check("a", 0);
  assert.equal(limiter.check("b", 1).ok, true);
  assert.equal(limiter.check("a", 60_001).ok, true);
});
