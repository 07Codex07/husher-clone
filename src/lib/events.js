import { EventEmitter } from "node:events";
import { serializeOrder } from "./serialize.js";
import { createRedis } from "./redis.js";

const CHANNEL = "husher:order-updates";
const bus = new EventEmitter();
let publisher = null;
let subscriber = null;

export function publishOrderUpdate(order) {
  const payload = serializeOrder(order);
  if (publisher) {
    publisher.publish(CHANNEL, JSON.stringify(payload)).catch((err) => {
      console.error(`[events] publish failed: ${err.message}`);
    });
  } else {
    bus.emit("update", payload);
  }
}

export function onOrderUpdate(listener) {
  bus.on("update", listener);
  return () => bus.off("update", listener);
}

export async function startRedisBridge() {
  publisher = createRedis();
  subscriber = createRedis();
  subscriber.on("message", (channel, message) => {
    if (channel === CHANNEL) bus.emit("update", JSON.parse(message));
  });
  await subscriber.subscribe(CHANNEL);
}

export async function stopRedisBridge() {
  await Promise.all([publisher?.quit(), subscriber?.quit()]);
  publisher = subscriber = null;
}
