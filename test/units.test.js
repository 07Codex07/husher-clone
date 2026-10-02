import test from "node:test";
import assert from "node:assert/strict";
import { toUnits, fromUnits } from "../src/lib/units.js";

test("toUnits converts decimal strings without float error", () => {
  assert.equal(toUnits("0.1", 8), 10000000n);
  assert.equal(toUnits("1.5", 18), 1500000000000000000n);
  assert.equal(toUnits("0.00000001", 8), 1n);
});

test("fromUnits is the inverse of toUnits", () => {
  for (const [a, d] of [["1.5", 8], ["0.123456", 6], ["100", 18]]) {
    assert.equal(fromUnits(toUnits(a, d), d), a);
  }
});

test("toUnits truncates excess precision", () => {
  assert.equal(toUnits("1.123456789", 6), 1123456n);
});
