import "dotenv/config";
import { app } from "./app.js";
import { assertAuthConfigured } from "./lib/auth.js";
import { redisUrl, redisIsReachable } from "./lib/redis.js";
import { startRedisBridge, stopRedisBridge } from "./lib/events.js";
import { prisma } from "./lib/prisma.js";
import { attachRealtime } from "./realtime.js";
import { startWorker } from "./worker.js";

const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === "production";

assertAuthConfigured();

// Redis is optional in dev, but in production an unreachable Redis should stop startup
let useRedis = false;
if (redisUrl()) {
  useRedis = await redisIsReachable();
  if (!useRedis) {
    if (isProduction) throw new Error(`REDIS_URL is set but Redis is unreachable`);
    console.warn("[redis] REDIS_URL is set but unreachable; using in-process worker and events");
  }
}
if (useRedis) await startRedisBridge();

const server = app.listen(PORT, () => {
  console.log(`husher integration backend on http://localhost:${PORT} (provider: ${process.env.EXCHANGE_PROVIDER || "mock"})`);
  console.log(`tester page: http://localhost:${PORT}/   realtime: socket.io on the same port`);
});
const realtime = attachRealtime(server);

const worker =
  process.env.WORKER === "off"
    ? null
    : await startWorker({
        intervalMs: Number(process.env.WORKER_INTERVAL_MS) || 5000,
        concurrency: Number(process.env.WORKER_CONCURRENCY) || 5,
        useQueue: useRedis,
      });

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try {
    await worker?.stop();
    await realtime.close(); // also closes the HTTP server
    if (useRedis) await stopRedisBridge();
    await prisma.$disconnect();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
