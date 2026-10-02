import test from "node:test";
import assert from "node:assert/strict";

process.env.HUSHER_API_KEY = "test-key";
process.env.HUSHER_API_URL = "https://husher.test";

const upstreamCurrencies = [
  {
    currency: "USDT",
    name: "Tether",
    networkList: [
      { network: "TRX", receiveDecimals: 6, sendStatus: true, receiveStatus: true, isDefault: true },
      { network: "BSC", receiveDecimals: 4, sendStatus: false, receiveStatus: true },
    ],
  },
  { currency: "BNB", name: "BNB", networkList: [{ network: "BSC", receiveDecimals: 8, isDefault: true }] },
];

const calls = [];
globalThis.fetch = async (url) => {
  calls.push(String(url));
  const payload = String(url).includes("/currencies")
    ? { success: true, data: upstreamCurrencies }
    : { success: true, data: { sendAmount: "100", receiveAmount: "0.16" } };
  return new Response(JSON.stringify(payload), { status: 200 });
};

const { husherProvider } = await import("../src/providers/husherProvider.js");

test("currencies are flattened to one row per (symbol, network) with their own decimals", async () => {
  const rows = await husherProvider.getCurrencies();
  const usdt = rows.filter((r) => r.symbol === "USDT");
  assert.deepEqual(
    usdt.map((r) => [r.network, r.decimals, r.sendEnabled]),
    [
      ["TRX", 6, true],
      ["BSC", 4, false],
    ],
  );
});

test("a network disabled for sending is a 400, and no rate call is made", async () => {
  calls.length = 0;
  await assert.rejects(
    () => husherProvider.getRate({ from: "USDT", to: "BNB", amountUnits: 1_000_000n, sendNetwork: "BSC" }),
    (err) => err.status === 400 && /not sendable on BSC/.test(err.message),
  );
  assert.ok(!calls.some((u) => u.includes("/rate")));
});

test("rate uses the requested network's decimals", async () => {
  const r = await husherProvider.getRate({ from: "USDT", to: "BNB", amountUnits: 100_000000n, sendNetwork: "TRX", receiveNetwork: "BSC" });
  const rateUrl = new URL(calls.find((u) => u.includes("/rate")));
  assert.equal(rateUrl.searchParams.get("sendAmount"), "100");
  assert.equal(r.toAmountUnits, 16_000000n); // 0.16 BNB at 8 decimals
});
