import { provider } from "../providers/index.js";
import { prisma } from "./prisma.js";
import { isTerminal } from "./status.js";
import { publishOrderUpdate } from "./events.js";

const STATUS_FETCHERS = {
  exchange: (id) => provider.getStatus(id),
  multi: (id) => provider.getMultiStatus(id),
  private: (id) => provider.getPrivateStatus(id),
  batch: (id) => provider.getBatchStatus(id),
};

export async function refreshOrder(order) {
  if (!order.providerOrderId || isTerminal(order.status)) return order;

  const fetchStatus = STATUS_FETCHERS[order.type];
  if (!fetchStatus) return order;

  let upstream;
  try {
    upstream = await fetchStatus(order.providerOrderId);
  } catch (err) {
    // the in-memory mock forgets orders on restart; don't poll a ghost forever
    const lost = err.code === "UNKNOWN_ORDER" || err.status === 404;
    if (lost && order.provider === "mock-provider") {
      const updated = await prisma.order.update({
        where: { id: order.id },
        data: { status: "failed", failureReason: "provider order not found (mock restarted?)", lastPolledAt: new Date() },
      });
      publishOrderUpdate(updated);
      return updated;
    }
    throw err;
  }

  let status = upstream.status;
  let failureReason = upstream.failureReason ?? order.failureReason;

  // no deposit in time; the provider won't always tell us
  if (status === "awaiting_deposit" && order.expiresAt && order.expiresAt < new Date()) {
    status = "expired";
    failureReason = "no deposit received before expiry";
  }

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: {
      status,
      failureReason,
      toAmountUnits: upstream.toAmountUnits ?? order.toAmountUnits,
      txHash: upstream.txHash ?? order.txHash,
      meta: upstream.raw ? { ...(order.meta ?? {}), upstream: upstream.raw } : order.meta ?? undefined,
      lastPolledAt: new Date(),
    },
  });

  // only publish real status changes
  if (updated.status !== order.status) publishOrderUpdate(updated);
  return updated;
}
