import IORedis from "ioredis";

export const redisUrl = () => process.env.REDIS_URL || null;

// BullMQ requires maxRetriesPerRequest: null on the connections it blocks on
export function createRedis(options = {}) {
  return new IORedis(redisUrl(), { maxRetriesPerRequest: null, ...options });
}

export async function redisIsReachable(timeoutMs = 2000) {
  if (!redisUrl()) return false;
  const probe = new IORedis(redisUrl(), {
    lazyConnect: true,
    connectTimeout: timeoutMs,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  probe.on("error", () => {});
  try {
    await probe.connect();
    return (await probe.ping()) === "PONG";
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}
