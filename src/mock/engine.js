import { randomBytes } from "node:crypto";

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Prices are made up but close enough for a demo.
const coins = {
  BTC: { name: "Bitcoin", networks: ["BTC"], decimals: 8, price: 62000 },
  ETH: { name: "Ethereum", networks: ["ETH"], decimals: 18, price: 2450 },
  USDT: { name: "Tether", networks: ["TRX", "ETH", "BSC"], decimals: 6, price: 1 },
  USDC: { name: "USD Coin", networks: ["ETH", "BSC"], decimals: 6, price: 1 },
  BNB: { name: "BNB", networks: ["BSC"], decimals: 18, price: 600 },
  SOL: { name: "Solana", networks: ["SOL"], decimals: 9, price: 145 },
  TRX: { name: "TRON", networks: ["TRX"], decimals: 6, price: 0.12 },
  LTC: { name: "Litecoin", networks: ["LTC"], decimals: 8, price: 85 },
  XMR: { name: "Monero", networks: ["XMR"], decimals: 12, price: 165 },
};

const MIN_USD = 10;

const orders = new Map(); // single + private exchanges
const multiOrders = new Map();
const batchOrders = new Map();
const users = new Map();
const recipientParent = new Map(); // recipientId -> multi order id

export function resetAll() {
  orders.clear();
  multiOrders.clear();
  batchOrders.clear();
  users.clear();
  recipientParent.clear();
  return { ok: true };
}

const now = () => new Date().toISOString();
const rand = (bytes) => randomBytes(bytes).toString("hex");
const round = (n) => (Number.isFinite(n) ? +n.toFixed(8) : 0);

function required(obj, fields) {
  for (const f of fields) {
    const v = obj?.[f];
    if (v === undefined || v === null || v === "") {
      throw new ApiError(400, `${f} is required`);
    }
  }
}

function positive(value, field) {
  const n = Number(value);
  if (!(n > 0)) throw new ApiError(400, `${field} must be a positive number`);
  return n;
}

function coin(symbol) {
  const key = String(symbol || "").toUpperCase();
  if (!coins[key]) throw new ApiError(400, `unsupported coin: ${symbol}`);
  return { symbol: key, ...coins[key] };
}

function network(symbol, net) {
  const c = coin(symbol);
  if (!net) return c.networks[0];
  const n = String(net).toUpperCase();
  if (!c.networks.includes(n)) throw new ApiError(400, `${c.symbol} is not available on ${net}`);
  return n;
}

function depositAddress(net) {
  const body = rand(20);
  if (net === "BTC") return "bc1q" + body;
  if (net === "TRX") return "T" + body;
  if (net === "SOL") return body;
  return "0x" + body;
}

// small random wobble plus the fee/markup cut
function convert(from, to, amount, { markup = 0, reverse = false } = {}) {
  const wobble = () => 1 + (Math.random() - 0.5) * 0.006;
  const fromPrice = coins[from].price * wobble();
  const toPrice = coins[to].price * wobble();
  const fee = 0.005 + Number(markup || 0) / 100;

  let send;
  let receive;
  if (reverse) {
    receive = amount;
    send = (receive * toPrice) / (1 - fee) / fromPrice;
  } else {
    send = amount;
    receive = (send * fromPrice * (1 - fee)) / toPrice;
  }
  return { sendAmount: round(send), receiveAmount: round(receive), rate: round(receive / send) };
}

function exchangeStatus(ageMs) {
  if (ageMs < 15000) return "pending";
  if (ageMs < 35000) return "confirming";
  if (ageMs < 65000) return "exchanging";
  return "completed";
}

function out(order) {
  return { ...order, createdAt: new Date(order.createdAt).toISOString() };
}

export function getCurrencies() {
  return Object.entries(coins).map(([symbol, c]) => ({
    symbol,
    name: c.name,
    network: c.networks[0],
    networks: c.networks,
    decimals: c.decimals,
    minAmount: round(MIN_USD / c.price),
  }));
}

export function getRate(query = {}) {
  required(query, ["sendToken", "receiveToken"]);
  const from = coin(query.sendToken);
  const to = coin(query.receiveToken);
  const reverse = query.amountType === "receive";
  const amount = positive(
    reverse ? query.receiveAmount : query.sendAmount,
    reverse ? "receiveAmount" : "sendAmount",
  );

  const q = convert(from.symbol, to.symbol, amount, { markup: query.markup, reverse });
  return {
    sendToken: from.symbol,
    receiveToken: to.symbol,
    sendNetwork: network(from.symbol, query.sendNetwork),
    receiveNetwork: network(to.symbol, query.receiveNetwork),
    ...q,
    provider: query.provider || "floating",
    minAmount: round(MIN_USD / from.price),
    estimatedMinutes: 12,
  };
}

export function createExchange(body = {}) {
  required(body, ["send", "receive", "amount", "receiveAddress"]);
  const from = coin(body.send);
  const to = coin(body.receive);
  const amount = positive(body.amount, "amount");

  const min = MIN_USD / from.price;
  if (amount < min) throw new ApiError(400, `minimum send amount is ${round(min)} ${from.symbol}`);

  const sendNetwork = network(from.symbol, body.sendNetwork);
  const q = convert(from.symbol, to.symbol, amount, { markup: body.markup });

  const order = {
    id: rand(4),
    type: "exchange",
    status: "pending",
    provider: body.provider || "floating",
    sendToken: from.symbol,
    receiveToken: to.symbol,
    sendNetwork,
    receiveNetwork: network(to.symbol, body.receiveNetwork),
    ...q,
    sendAddress: depositAddress(sendNetwork),
    receiveAddress: body.receiveAddress,
    externalUserId: body.externalUserId || null,
    hashIn: null,
    hashOut: null,
    createdAt: Date.now(),
    updatedAt: now(),
  };
  orders.set(order.id, order);
  return out(order);
}

export function getOrderStatus(id) {
  const order = orders.get(id);
  if (!order) throw new ApiError(404, "order not found");

  const status = exchangeStatus(Date.now() - order.createdAt);
  if (status !== order.status) order.updatedAt = now();
  order.status = status;
  if (status !== "pending") order.hashIn ||= "0x" + rand(32);
  if (status === "completed") order.hashOut ||= "0x" + rand(32);
  return out(order);
}

function checkPercents(recipients) {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new ApiError(400, "recipients must be a non-empty array");
  }
  const total = recipients.reduce((sum, r) => sum + Number(r.percent || 0), 0);
  if (Math.abs(total - 100) > 0.01) {
    throw new ApiError(400, `recipient percents must add up to 100 (got ${total})`);
  }
}

export function getMultiRate(body = {}) {
  required(body, ["sendToken", "receiveToken", "totalAmount", "recipients"]);
  checkPercents(body.recipients);
  const from = coin(body.sendToken);
  const to = coin(body.receiveToken);
  const total = positive(body.totalAmount, "totalAmount");

  let totalReceive = 0;
  const recipients = body.recipients.map((r) => {
    const q = convert(from.symbol, to.symbol, (total * r.percent) / 100, { markup: body.markup });
    totalReceive += q.receiveAmount;
    return { percent: Number(r.percent), provider: r.provider || "husher", ...q };
  });

  return {
    sendToken: from.symbol,
    receiveToken: to.symbol,
    sendNetwork: network(from.symbol, body.sendNetwork),
    receiveNetwork: network(to.symbol, body.receiveNetwork),
    totalAmount: total,
    totalReceiveAmount: round(totalReceive),
    rate: round(totalReceive / total),
    recipients,
  };
}

export function createMultiExchange(body = {}) {
  required(body, ["send", "receive", "totalAmount", "recipients"]);
  checkPercents(body.recipients);
  body.recipients.forEach((r) => required(r, ["address", "percent"]));

  const from = coin(body.send);
  const to = coin(body.receive);
  const total = positive(body.totalAmount, "totalAmount");
  const sendNetwork = network(from.symbol, body.sendNetwork);

  const order = {
    id: rand(12),
    type: "multi",
    status: "awaiting_deposit",
    sendToken: from.symbol,
    receiveToken: to.symbol,
    sendNetwork,
    receiveNetwork: network(to.symbol, body.receiveNetwork),
    totalAmount: total,
    depositAddress: depositAddress(sendNetwork),
    externalUserId: body.externalUserId || null,
    createdAt: Date.now(),
    updatedAt: now(),
    recipients: body.recipients.map((r) => {
      const q = convert(from.symbol, to.symbol, (total * r.percent) / 100, { markup: body.markup });
      return {
        id: "rec_" + rand(4),
        address: r.address,
        percent: Number(r.percent),
        provider: r.provider || "husher",
        timeDelay: Number(r.timeDelay) || 0,
        ...q,
        status: "pending",
        hashOut: null,
      };
    }),
  };

  multiOrders.set(order.id, order);
  order.recipients.forEach((r) => recipientParent.set(r.id, order.id));
  return out(order);
}

function advanceMulti(order) {
  const age = Date.now() - order.createdAt;
  for (const r of order.recipients) {
    if (r.status === "completed") continue;
    if (age >= 55000 + r.timeDelay * 1000) {
      r.status = "completed";
      r.hashOut ||= "0x" + rand(32);
    } else if (age >= 35000) {
      r.status = "exchanging";
    }
  }
  if (order.recipients.every((r) => r.status === "completed")) order.status = "completed";
  else if (age >= 35000) order.status = "processing";
  else if (age >= 15000) order.status = "confirming";
  return order;
}

export function getMultiExchangeOrder(id) {
  const order = multiOrders.get(id);
  if (!order) throw new ApiError(404, "multi exchange order not found");
  return out(advanceMulti(order));
}

export function executeRecipientInstantly(recipientId) {
  const parentId = recipientParent.get(recipientId);
  if (!parentId) throw new ApiError(404, "recipient not found");
  const order = advanceMulti(multiOrders.get(parentId));

  if (Date.now() - order.createdAt < 15000) {
    throw new ApiError(400, "parent order deposit hasn't been confirmed yet");
  }
  const recipient = order.recipients.find((r) => r.id === recipientId);
  if (recipient.status !== "completed") {
    recipient.status = "completed";
    recipient.hashOut ||= "0x" + rand(32);
    order.updatedAt = now();
  }
  return { multiExchangeOrderId: order.id, recipient };
}

export function getMultiExchangeProviders() {
  return ["husher", "binance", "changenow", "floating", "fixed"];
}

export function getMinimumWithdrawals(query = {}) {
  required(query, ["token"]);
  const c = coin(query.token);
  return {
    token: c.symbol,
    network: network(c.symbol, query.network),
    minimum: round(MIN_USD / c.price),
    decimals: c.decimals,
  };
}

export function createPrivateExchange(body = {}) {
  required(body, ["send", "receive", "amount", "receiveAddress"]);
  const from = coin(body.send);
  const to = coin(body.receive);
  const amount = positive(body.amount, "amount");
  const sendNetwork = network(from.symbol, body.sendNetwork);
  const q = convert(from.symbol, to.symbol, amount, { markup: body.markup });

  const order = {
    id: rand(4),
    type: "private",
    status: "pending",
    sendToken: from.symbol,
    receiveToken: to.symbol,
    sendNetwork,
    receiveNetwork: network(to.symbol, body.receiveNetwork),
    ...q,
    sendAddress: depositAddress(sendNetwork),
    receiveAddress: body.receiveAddress,
    externalUserId: body.externalUserId || null,
    hashIn: null,
    hashOut: null,
    createdAt: Date.now(),
    updatedAt: now(),
  };
  orders.set(order.id, order);
  return order.id; // upstream returns the bare id string here
}

function newAddress(net, index) {
  return { index, address: depositAddress(net), status: "awaiting_deposit", receivedAmount: 0 };
}

// how many of the batch's addresses have "received" a deposit by now
function funded(order) {
  const age = Date.now() - order.createdAt;
  const n = age > 45000 ? 3 : age > 25000 ? 2 : age > 10000 ? 1 : 0;
  return Math.min(n, order.addresses.length);
}

function advanceBatch(order) {
  const count = funded(order);
  order.addresses.forEach((a, i) => {
    if (i < count && a.status === "awaiting_deposit") {
      a.status = "funded";
      a.receivedAmount = round(10 + Math.random() * 40);
    }
  });
  if (order.status === "processing" && Date.now() - order.executedAt > 30000) {
    order.status = "completed";
  } else if (order.status !== "processing" && order.status !== "completed") {
    order.status = count > 0 ? "deposits_arriving" : "awaiting_deposits";
  }
  return order;
}

export function createBatchOrder(body = {}) {
  required(body, ["addressCount", "sendToken", "receiveToken", "receiveAddress"]);
  const count = positive(body.addressCount, "addressCount");
  if (count > 50) throw new ApiError(400, "addressCount can't be more than 50");

  const from = coin(body.sendToken);
  const to = coin(body.receiveToken);
  const sendNetwork = network(from.symbol, body.sendNetwork);

  const order = {
    id: "batch_" + rand(4),
    type: "batch",
    status: "awaiting_deposits",
    sendToken: from.symbol,
    receiveToken: to.symbol,
    sendNetwork,
    receiveNetwork: network(to.symbol, body.receiveNetwork),
    receiveAddress: body.receiveAddress,
    autoProcess: !!body.autoProcess,
    externalUserId: body.externalUserId || null,
    addresses: Array.from({ length: count }, (_, i) => newAddress(sendNetwork, i)),
    executedAt: null,
    createdAt: Date.now(),
    updatedAt: now(),
  };
  batchOrders.set(order.id, order);
  return out(order);
}

export function getBatchOrder(id) {
  const order = batchOrders.get(id);
  if (!order) throw new ApiError(404, "batch order not found");
  return out(advanceBatch(order));
}

export function addBatchAddresses(id, addressCount) {
  const order = batchOrders.get(id);
  if (!order) throw new ApiError(404, "batch order not found");
  const count = positive(addressCount, "addressCount");
  if (order.addresses.length + count > 100) {
    throw new ApiError(400, "a batch order can't hold more than 100 addresses");
  }
  const start = order.addresses.length;
  for (let i = 0; i < count; i++) order.addresses.push(newAddress(order.sendNetwork, start + i));
  order.updatedAt = now();
  return out(advanceBatch(order));
}

export function executeBatchOrder(id) {
  const order = batchOrders.get(id);
  if (!order) throw new ApiError(404, "batch order not found");
  advanceBatch(order);
  if (funded(order) === 0) throw new ApiError(400, "no deposits have arrived yet");

  order.status = "processing";
  order.executedAt = Date.now();
  order.updatedAt = now();
  return out(order);
}

export function createExternalUser(body = {}) {
  required(body, ["externalUserId"]);
  const id = String(body.externalUserId);
  if (users.has(id)) throw new ApiError(409, `external user ${id} already exists`);

  const user = {
    externalUserId: id,
    feePercentage: Number(body.feePercentage) || 0,
    description: body.description || "",
    createdAt: now(),
    updatedAt: now(),
  };
  users.set(id, user);
  return user;
}

export function listExternalUsers() {
  return [...users.values()];
}

export function getExternalUser(id) {
  const user = users.get(String(id));
  if (!user) throw new ApiError(404, "external user not found");
  return user;
}

export function updateExternalUser(id, body = {}) {
  const user = users.get(String(id));
  if (!user) throw new ApiError(404, "external user not found");
  if (body.feePercentage !== undefined) user.feePercentage = Number(body.feePercentage) || 0;
  if (body.description !== undefined) user.description = body.description;
  user.updatedAt = now();
  return user;
}

export function deleteExternalUser(id) {
  const key = String(id);
  if (!users.delete(key)) throw new ApiError(404, "external user not found");

  let removed = 0;
  for (const store of [orders, multiOrders, batchOrders]) {
    for (const [k, v] of store) {
      if (v.externalUserId === key) {
        store.delete(k);
        removed++;
      }
    }
  }
  return { externalUserId: key, deleted: true, removedOrders: removed };
}

export function getOrdersForExternalUser(externalUserId, { page = 1, limit = 10 } = {}) {
  const key = String(externalUserId);
  const p = Math.max(1, Number(page) || 1);
  const size = Math.min(100, Math.max(1, Number(limit) || 10));

  const all = [];
  for (const store of [orders, multiOrders, batchOrders]) {
    for (const v of store.values()) {
      if (v.externalUserId !== key) continue;
      all.push({
        id: v.id,
        type: v.type,
        status: v.status,
        sendToken: v.sendToken,
        receiveToken: v.receiveToken,
        createdAt: new Date(v.createdAt).toISOString(),
      });
    }
  }
  all.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  return {
    orders: all.slice((p - 1) * size, p * size),
    page: p,
    limit: size,
    total: all.length,
  };
}
