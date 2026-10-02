import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createFakePrisma } from "./fakePrisma.js";

process.env.EXCHANGE_PROVIDER = "mock";
const prisma = createFakePrisma();
globalThis.prisma = prisma;

const { processJob } = await import("../src/worker.js");
const { onOrderUpdate } = await import("../src/lib/events.js");
const { mockProvider } = await import("../src/providers/mockProvider.js");

async function seedOrder(overrides = {}) {
  const created = await mockProvider.createExchange({ from: "BTC", to: "ETH", amountUnits: 10_000_000n, payoutAddress: "0xabc" });
  return prisma.order.create({
    data: {
      type: "exchange",
      fromCurrency: "BTC",
      toCurrency: "ETH",
      fromAmountUnits: 10_000_000n,
      quotedRate: created.rate,
      provider: mockProvider.name,
      providerOrderId: created.providerOrderId,
      status: "awaiting_deposit",
      ...overrides,
    },
  });
}

test("scan queues one deduplicated refresh job per open order", async () => {
  const open = await seedOrder();
  await seedOrder({ status: "completed" });

  const added = [];
  const queue = { addBulk: async (jobs) => added.push(...jobs) };
  const result = await processJob({ name: "scan" }, queue);

  const ids = added.map((j) => j.opts.jobId);
  assert.ok(ids.includes(`refresh-${open.id}`));
  assert.ok(ids.every((id) => !id.includes(":")), "BullMQ rejects ':' in job ids");
  assert.equal(result.queued, added.length);
  assert.ok(added.every((j) => j.name === "refresh"));
});

test("refresh moves the order and publishes the transition", async () => {
  mock.timers.enable({ apis: ["Date"], now: 5_000_000 });
  const events = [];
  const stop = onOrderUpdate((o) => events.push(o));
  try {
    const order = await seedOrder();
    mock.timers.setTime(5_000_000 + 6000); // mock provider: confirming after 5s

    const result = await processJob({ name: "refresh", data: { orderId: order.id } });
    assert.equal(result.status, "confirming");
    assert.equal((await prisma.order.findUnique({ where: { id: order.id } })).status, "confirming");
    assert.deepEqual(events.map((e) => [e.id, e.status]), [[order.id, "confirming"]]);

    // a poll that changes nothing publishes nothing
    await processJob({ name: "refresh", data: { orderId: order.id } });
    assert.equal(events.length, 1);
  } finally {
    stop();
    mock.timers.reset();
  }
});

test("refresh skips finished or deleted orders", async () => {
  const done = await seedOrder({ status: "failed" });
  assert.deepEqual(await processJob({ name: "refresh", data: { orderId: done.id } }), { skipped: true });
  assert.deepEqual(await processJob({ name: "refresh", data: { orderId: "f".repeat(24) } }), { skipped: true });
});

test("unknown job names fail loudly", async () => {
  await assert.rejects(() => processJob({ name: "mystery" }), /unknown job/);
});
