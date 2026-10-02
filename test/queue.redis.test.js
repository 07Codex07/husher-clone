import test from "node:test";
import assert from "node:assert/strict";
import { createFakePrisma } from "./fakePrisma.js";

const skip = process.env.REDIS_URL ? false : "set REDIS_URL to run the BullMQ integration test";

process.env.EXCHANGE_PROVIDER = "mock";
const prisma = createFakePrisma();
globalThis.prisma = prisma;

test("scheduled scan + refresh jobs move an order through Redis", { skip, timeout: 20_000 }, async () => {
  const { startWorker } = await import("../src/worker.js");
  const { mockProvider } = await import("../src/providers/mockProvider.js");
  const { startRedisBridge, stopRedisBridge, onOrderUpdate } = await import("../src/lib/events.js");

  await startRedisBridge();
  const seen = [];
  const stopListening = onOrderUpdate((o) => seen.push(o.status));

  const created = await mockProvider.createExchange({ from: "BTC", to: "ETH", amountUnits: 10_000_000n, payoutAddress: "0xabc" });
  const order = await prisma.order.create({
    data: {
      type: "exchange",
      fromCurrency: "BTC",
      toCurrency: "ETH",
      fromAmountUnits: 10_000_000n,
      quotedRate: created.rate,
      provider: mockProvider.name,
      providerOrderId: created.providerOrderId,
      status: "awaiting_deposit",
    },
  });

  const prefix = `husher-test-${process.pid}`;
  const worker = await startWorker({ intervalMs: 300, useQueue: true, prefix });
  try {
    assert.equal(worker.mode, "bullmq");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && seen.length === 0) await new Promise((r) => setTimeout(r, 200));

    const row = await prisma.order.findUnique({ where: { id: order.id } });
    assert.equal(row.status, "confirming");
    assert.deepEqual(seen, ["confirming"], "the transition came back through Redis pub/sub");
  } finally {
    stopListening();
    await worker.queue.obliterate({ force: true }); // only this test's prefix
    await worker.stop();
    await stopRedisBridge();
  }
});
