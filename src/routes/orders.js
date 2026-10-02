import express from "express";
import { provider } from "../providers/index.js";
import { prisma } from "../lib/prisma.js";
import { toUnits } from "../lib/units.js";
import { serializeOrder } from "../lib/serialize.js";
import { refreshOrder } from "../lib/orderSync.js";
import { publishOrderUpdate } from "../lib/events.js";
import {
  validate,
  rateQuerySchema,
  createOrderSchema,
  createMultiOrderSchema,
  createBatchOrderSchema,
  addAddressesSchema,
  listOrdersQuerySchema,
} from "../lib/validation.js";

export const ordersRouter = express.Router();

const ORDER_EXPIRY_MS = Number(process.env.ORDER_EXPIRY_MINUTES || 30) * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// decimals differ per network, so find the exact (symbol, network) row
function findCurrency(currencies, symbol, network, direction) {
  const rows = currencies.filter((c) => c.symbol?.toUpperCase() === symbol);
  if (!rows.length) throw new HttpError(400, `Unsupported currency: ${symbol}`);

  const onNetwork = network ? rows.filter((c) => c.network?.toUpperCase() === network) : rows;
  if (!onNetwork.length) throw new HttpError(400, `${symbol} is not available on ${network}`);

  const enabledFlag = direction === "send" ? "sendEnabled" : "receiveEnabled";
  const usable = onNetwork.filter((c) => c[enabledFlag] !== false);
  if (!usable.length) {
    throw new HttpError(400, `${symbol} can't be ${direction === "send" ? "sent" : "received"}${network ? ` on ${network}` : ""} right now`);
  }

  return usable.find((c) => c.isDefault) ?? usable[0];
}

async function resolvePair(from, to, sendNetwork, receiveNetwork) {
  const currencies = await provider.getCurrencies();
  return [findCurrency(currencies, from, sendNetwork, "send"), findCurrency(currencies, to, receiveNetwork, "receive")];
}

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const clientIp = (req) => req.body?.ipAddress ?? req.ip;

const expiry = () => new Date(Date.now() + ORDER_EXPIRY_MS);

async function loadOrder(id, expectedType) {
  // not an ObjectId, Prisma would throw a 500
  if (!/^[0-9a-f]{24}$/i.test(id)) throw new HttpError(404, "order not found");
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) throw new HttpError(404, "order not found");
  if (expectedType && order.type !== expectedType) {
    throw new HttpError(400, `order is type "${order.type}", not "${expectedType}"`);
  }
  return order;
}

ordersRouter.get(
  "/currencies",
  h(async (req, res) => {
    res.json({ success: true, data: await provider.getCurrencies() });
  }),
);

ordersRouter.get(
  "/rate",
  validate(rateQuerySchema, "query"),
  h(async (req, res) => {
    const { from, to, amount, amountType, sendNetwork, receiveNetwork, externalUserId } = req.query;

    const [fromMeta, toMeta] = await resolvePair(from, to, sendNetwork, receiveNetwork);
    const amountUnits = toUnits(amount, amountType === "receive" ? toMeta.decimals : fromMeta.decimals);

    const result = await provider.getRate({
      from,
      to,
      amountUnits,
      sendNetwork,
      receiveNetwork,
      amountType,
      externalUserId,
    });

    res.json({
      success: true,
      data: {
        rate: result.rate,
        toAmountUnits: result.toAmountUnits.toString(),
        provider: result.provider,
      },
    });
  }),
);

ordersRouter.post(
  "/",
  validate(createOrderSchema, "body"),
  h(async (req, res) => {
    const { fromCurrency, toCurrency, amount, payoutAddress, sendNetwork, receiveNetwork, externalUserId } =
      req.body;

    const [fromMeta] = await resolvePair(fromCurrency, toCurrency, sendNetwork, receiveNetwork);
    const amountUnits = toUnits(amount, fromMeta.decimals);

    const result = await provider.createExchange({
      from: fromCurrency,
      to: toCurrency,
      amountUnits,
      payoutAddress,
      sendNetwork,
      receiveNetwork,
      ipAddress: clientIp(req),
      externalUserId,
    });

    const order = await prisma.order.create({
      data: {
        type: "exchange",
        fromCurrency,
        toCurrency,
        fromAmountUnits: amountUnits,
        toAmountUnits: result.toAmountUnits,
        quotedRate: result.rate,
        provider: provider.name,
        providerOrderId: result.providerOrderId,
        depositAddress: result.depositAddress,
        payoutAddress,
        externalUserId: externalUserId ?? null,
        status: "awaiting_deposit",
        expiresAt: expiry(),
      },
    });

    publishOrderUpdate(order);
    res.status(201).json({ success: true, data: serializeOrder(order) });
  }),
);

// private exchange: same body as a normal exchange
ordersRouter.post(
  "/private",
  validate(createOrderSchema, "body"),
  h(async (req, res) => {
    const { fromCurrency, toCurrency, amount, payoutAddress, sendNetwork, receiveNetwork, externalUserId } =
      req.body;

    const [fromMeta] = await resolvePair(fromCurrency, toCurrency, sendNetwork, receiveNetwork);

    const result = await provider.createPrivate({
      from: fromCurrency,
      to: toCurrency,
      amount,
      payoutAddress,
      sendNetwork,
      receiveNetwork,
      ipAddress: clientIp(req),
      externalUserId,
    });

    const order = await prisma.order.create({
      data: {
        type: "private",
        fromCurrency,
        toCurrency,
        fromAmountUnits: toUnits(amount, fromMeta.decimals),
        quotedRate: 0, // priced upstream when it executes
        provider: provider.name,
        providerOrderId: result.providerOrderId,
        depositAddress: result.depositAddress,
        payoutAddress,
        externalUserId: externalUserId ?? null,
        status: "awaiting_deposit",
        meta: { upstream: result.raw },
        expiresAt: expiry(),
      },
    });

    publishOrderUpdate(order);
    res.status(201).json({ success: true, data: serializeOrder(order) });
  }),
);

// multi exchange: one deposit split across recipients
ordersRouter.post(
  "/multi",
  validate(createMultiOrderSchema, "body"),
  h(async (req, res) => {
    const { fromCurrency, toCurrency, amount, recipients, sendNetwork, receiveNetwork, externalUserId } =
      req.body;

    const [fromMeta] = await resolvePair(fromCurrency, toCurrency, sendNetwork, receiveNetwork);

    const result = await provider.createMulti({
      from: fromCurrency,
      to: toCurrency,
      amount,
      recipients,
      sendNetwork,
      receiveNetwork,
      ipAddress: clientIp(req),
      externalUserId,
    });

    const order = await prisma.order.create({
      data: {
        type: "multi",
        fromCurrency,
        toCurrency,
        fromAmountUnits: toUnits(amount, fromMeta.decimals),
        quotedRate: 0, // each recipient has its own rate
        provider: provider.name,
        providerOrderId: result.providerOrderId,
        depositAddress: result.depositAddress,
        externalUserId: externalUserId ?? null,
        status: "awaiting_deposit",
        meta: { requestedRecipients: recipients, upstream: result.raw },
        expiresAt: expiry(),
      },
    });

    publishOrderUpdate(order);
    res.status(201).json({ success: true, data: serializeOrder(order) });
  }),
);

// batch: many deposit addresses, one pair
ordersRouter.post(
  "/batch",
  validate(createBatchOrderSchema, "body"),
  h(async (req, res) => {
    const {
      fromCurrency,
      toCurrency,
      addressCount,
      payoutAddress,
      autoProcess,
      sendNetwork,
      receiveNetwork,
      externalUserId,
    } = req.body;

    await resolvePair(fromCurrency, toCurrency, sendNetwork, receiveNetwork);

    const result = await provider.createBatch({
      from: fromCurrency,
      to: toCurrency,
      addressCount,
      payoutAddress,
      autoProcess,
      sendNetwork,
      receiveNetwork,
      ipAddress: clientIp(req),
      externalUserId,
    });

    const order = await prisma.order.create({
      data: {
        type: "batch",
        fromCurrency,
        toCurrency,
        fromAmountUnits: 0n, // unknown until deposits arrive
        quotedRate: 0,
        provider: provider.name,
        providerOrderId: result.providerOrderId,
        payoutAddress,
        externalUserId: externalUserId ?? null,
        status: "awaiting_deposit",
        meta: { upstream: result.raw },
        expiresAt: expiry(),
      },
    });

    publishOrderUpdate(order);
    res.status(201).json({ success: true, data: serializeOrder(order) });
  }),
);

ordersRouter.post(
  "/:id/batch/add-addresses",
  validate(addAddressesSchema, "body"),
  h(async (req, res) => {
    const order = await loadOrder(req.params.id, "batch");
    await provider.addBatchAddresses(order.providerOrderId, req.body.addressCount);
    res.json({ success: true, data: serializeOrder(await refreshOrder(order)) });
  }),
);

ordersRouter.post(
  "/:id/batch/execute",
  h(async (req, res) => {
    const order = await loadOrder(req.params.id, "batch");
    await provider.executeBatch(order.providerOrderId);
    res.json({ success: true, data: serializeOrder(await refreshOrder(order)) });
  }),
);

ordersRouter.get(
  "/",
  validate(listOrdersQuerySchema, "query"),
  h(async (req, res) => {
    const { externalUserId, type, status, page, limit } = req.query;
    const where = {
      ...(externalUserId && { externalUserId }),
      ...(type && { type }),
      ...(status && { status }),
    };

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.order.count({ where }),
    ]);

    res.json({ success: true, data: { orders: orders.map(serializeOrder), page, limit, total } });
  }),
);

ordersRouter.get(
  "/:id",
  h(async (req, res) => {
    const order = await loadOrder(req.params.id);
    res.json({ success: true, data: serializeOrder(await refreshOrder(order)) });
  }),
);
