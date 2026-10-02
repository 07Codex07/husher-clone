import { Queue, Worker } from "bullmq";
import { prisma } from "./lib/prisma.js";
import { refreshOrder } from "./lib/orderSync.js";
import { TERMINAL_STATUSES, isTerminal } from "./lib/status.js";
import { createRedis } from "./lib/redis.js";

const BATCH_SIZE = 50;
export const QUEUE_NAME = "order-status";

export function findOpenOrders(limit = BATCH_SIZE) {
  return prisma.order.findMany({
    where: { status: { notIn: TERMINAL_STATUSES } },
    orderBy: { lastPolledAt: "asc" },
    take: limit,
  });
}

export async function refreshAndLog(order) {
  const updated = await refreshOrder(order);
  if (updated.status !== order.status) {
    console.log(`[worker] ${order.type} ${order.id}: ${order.status} -> ${updated.status}`);
  }
  return updated;
}

export function startWorker({ intervalMs = 5000, useQueue = false, concurrency = 5, prefix = "bull" } = {}) {
  return useQueue ? startQueueWorker({ intervalMs, concurrency, prefix }) : startInProcessWorker({ intervalMs });
}

export async function processJob(job, queue) {
  if (job.name === "scan") {
    const open = await findOpenOrders();
    await queue.addBulk(
      open.map((order) => ({
        name: "refresh",
        data: { orderId: order.id },
        // BullMQ rejects ":" in custom ids
        opts: { jobId: `refresh-${order.id}` },
      })),
    );
    return { queued: open.length };
  }

  if (job.name === "refresh") {
    const order = await prisma.order.findUnique({ where: { id: job.data.orderId } });
    if (!order || isTerminal(order.status)) return { skipped: true };
    const updated = await refreshAndLog(order);
    return { status: updated.status };
  }

  throw new Error(`unknown job ${job.name}`);
}

async function startQueueWorker({ intervalMs, concurrency, prefix }) {
  const connection = createRedis();
  const queue = new Queue(QUEUE_NAME, {
    connection,
    prefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      // remove finished jobs so the order can be queued again next scan
      removeOnComplete: true,
      removeOnFail: true,
    },
  });

  // every instance calls this on boot, Redis keeps just one schedule
  await queue.upsertJobScheduler("scan-open-orders", { every: intervalMs }, { name: "scan" });

  const workerConnection = createRedis();
  const worker = new Worker(QUEUE_NAME, (job) => processJob(job, queue), {
    connection: workerConnection,
    concurrency,
    prefix,
  });

  worker.on("failed", (job, err) => {
    const retrying = job && job.attemptsMade < (job.opts.attempts ?? 1);
    console.error(`[worker] ${job?.name} ${job?.data?.orderId ?? ""} failed${retrying ? " (will retry)" : ""}: ${err.message}`);
  });

  console.log(`[worker] BullMQ queue "${QUEUE_NAME}": scan every ${intervalMs}ms, concurrency ${concurrency}`);

  return {
    mode: "bullmq",
    queue,
    stop: async () => {
      await worker.close();
      await queue.close();
      // BullMQ leaves connections it was handed open; close ours
      await Promise.all([connection.quit(), workerConnection.quit()]);
    },
  };
}

function startInProcessWorker({ intervalMs }) {
  let running = false;
  let lastErrorMessage = null;

  async function tick() {
    if (running) return; // previous tick still running
    running = true;
    try {
      for (const order of await findOpenOrders()) {
        try {
          await refreshAndLog(order);
        } catch (err) {
          console.error(`[worker] ${order.id} refresh failed: ${err.message}`);
        }
      }
      lastErrorMessage = null;
    } catch (err) {
      // log once, not on every tick
      if (err.message !== lastErrorMessage) console.error(`[worker] tick failed: ${err.message.split("\n")[0]}`);
      lastErrorMessage = err.message;
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  console.log(`[worker] in-process: polling open orders every ${intervalMs}ms`);
  return { mode: "in-process", tick, stop: async () => clearInterval(timer) };
}
