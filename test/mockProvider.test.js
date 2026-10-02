import test from "node:test";
import assert from "node:assert/strict";
import { mockProvider } from "../src/providers/mockProvider.js";

test("0.1 BTC -> ETH gives an exact, repeatable quote", async () => {
  const a = await mockProvider.getRate({ from: "BTC", to: "ETH", amountUnits: 10_000_000n });
  const b = await mockProvider.getRate({ from: "BTC", to: "ETH", amountUnits: 10_000_000n });
  assert.equal(a.toAmountUnits, b.toAmountUnits);
  assert.equal(a.toAmountUnits, 1902205880000000000n); // 1.90220588 ETH
  assert.equal(a.rate, 19.0220588);
});

test("quotes are cut to 8 decimals (no dust in the low digits)", async () => {
  const r = await mockProvider.getRate({ from: "SOL", to: "ETH", amountUnits: 1_234_567_891n });
  assert.equal(r.toAmountUnits % 10n ** 10n, 0n);
});

test("unsupported currency throws", async () => {
  await assert.rejects(() => mockProvider.getRate({ from: "DOGE", to: "ETH", amountUnits: 1n }), /Unsupported/);
});
