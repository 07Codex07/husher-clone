import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mockProvider } from "../src/providers/mockProvider.js";

const order = (payoutAddress) =>
  mockProvider.createExchange({ from: "BTC", to: "ETH", amountUnits: 10_000_000n, payoutAddress });

test("normal order walks awaiting_deposit -> confirming -> exchanging -> completed", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const { providerOrderId } = await order("0xabc");
    const at = async (ms) => {
      mock.timers.setTime(1_000_000 + ms);
      return (await mockProvider.getStatus(providerOrderId)).status;
    };
    assert.equal(await at(1000), "awaiting_deposit");
    assert.equal(await at(6000), "confirming");
    assert.equal(await at(11000), "exchanging");
    assert.equal(await at(16000), "completed");
  } finally {
    mock.timers.reset();
  }
});

test('payout address containing "fail" ends in failed with a reason', async () => {
  mock.timers.enable({ apis: ["Date"], now: 2_000_000 });
  try {
    const { providerOrderId } = await order("0xfail");
    mock.timers.setTime(2_000_000 + 6000);
    const s = await mockProvider.getStatus(providerOrderId);
    assert.equal(s.status, "failed");
    assert.match(s.failureReason, /simulated/);
  } finally {
    mock.timers.reset();
  }
});

test('payout address containing "expire" ends in expired', async () => {
  mock.timers.enable({ apis: ["Date"], now: 3_000_000 });
  try {
    const { providerOrderId } = await order("0xexpire");
    mock.timers.setTime(3_000_000 + 6000);
    assert.equal((await mockProvider.getStatus(providerOrderId)).status, "expired");
  } finally {
    mock.timers.reset();
  }
});

test("unknown provider order is flagged so the worker can drop it", async () => {
  await assert.rejects(() => mockProvider.getStatus("nope"), { code: "UNKNOWN_ORDER" });
});
