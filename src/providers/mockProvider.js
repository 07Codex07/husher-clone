import { nanoid } from "nanoid";
import * as engine from "../mock/engine.js";
import { normalizeStatus } from "../lib/status.js";

// same shape as husherProvider
const CURRENCIES = [
  ["BTC", "Bitcoin", ["BTC"], 8],
  ["ETH", "Ethereum", ["ETH"], 18],
  ["USDT", "Tether", ["TRX", "ETH", "BSC"], 6],
  ["USDC", "USD Coin", ["ETH", "BSC"], 6],
  ["SOL", "Solana", ["SOL"], 9],
].flatMap(([symbol, name, networks, decimals]) =>
  networks.map((network, i) => ({
    symbol,
    name,
    network,
    decimals,
    sendEnabled: true,
    receiveEnabled: true,
    isDefault: i === 0,
  })),
);

// prices in micro-USD so quotes are exact and repeatable
const PRICES_MICRO_USD = { BTC: 65000_000000n, ETH: 3400_000000n, USDT: 1_000000n, USDC: 1_000000n, SOL: 165_000000n };
const SPREAD_BPS = 50n; // 0.5% provider spread
const QUOTE_PRECISION = 8;

function currencyOf(symbol) {
  const c = CURRENCIES.find((c) => c.symbol === symbol);
  if (!c) throw new Error(`Unsupported currency: ${symbol}`);
  return c;
}

// test hooks: a payout address containing "fail" or "expire" ends that way
function behaviorFor(payoutAddress = "") {
  const a = payoutAddress.toLowerCase();
  if (a.includes("fail")) return "fail";
  if (a.includes("expire")) return "expire";
  return "normal";
}

function unknownOrder() {
  return Object.assign(new Error("Unknown provider order"), { code: "UNKNOWN_ORDER" });
}

const fakeOrders = new Map();

export const mockProvider = {
  name: "mock-provider",

  async getCurrencies() {
    return CURRENCIES;
  },

  async getRate({ from, to, amountUnits }) {
    const fromMeta = currencyOf(from);
    const toMeta = currencyOf(to);

    let toAmountUnits =
      (amountUnits * PRICES_MICRO_USD[from] * (10_000n - SPREAD_BPS) * 10n ** BigInt(toMeta.decimals)) /
      (10_000n * PRICES_MICRO_USD[to] * 10n ** BigInt(fromMeta.decimals));

    if (toMeta.decimals > QUOTE_PRECISION) {
      const step = 10n ** BigInt(toMeta.decimals - QUOTE_PRECISION);
      toAmountUnits -= toAmountUnits % step;
    }

    const amountWhole = Number(amountUnits) / 10 ** fromMeta.decimals;
    const toWhole = Number(toAmountUnits) / 10 ** toMeta.decimals;
    const rate = amountWhole ? Number((toWhole / amountWhole).toFixed(QUOTE_PRECISION)) : 0;

    return { rate, toAmountUnits, provider: this.name };
  },

  async createExchange({ from, to, amountUnits, payoutAddress }) {
    const { rate, toAmountUnits } = await this.getRate({ from, to, amountUnits });
    const providerOrderId = `mock_${nanoid(12)}`;
    const depositAddress = `${from.toLowerCase()}_deposit_${providerOrderId}`;

    fakeOrders.set(providerOrderId, {
      status: "awaiting_deposit",
      toAmountUnits,
      payoutAddress,
      behavior: behaviorFor(payoutAddress),
      createdAt: Date.now(),
    });

    return { providerOrderId, depositAddress, rate, toAmountUnits };
  },

  async getStatus(providerOrderId) {
    const order = fakeOrders.get(providerOrderId);
    if (!order) throw unknownOrder();

    // 0-5s awaiting_deposit, 5-10s confirming, 10-15s exchanging, then completed
    const elapsed = Date.now() - order.createdAt;

    if (order.behavior !== "normal" && elapsed > 5000) {
      const failed = order.behavior === "fail";
      return {
        status: failed ? "failed" : "expired",
        toAmountUnits: null,
        txHash: null,
        failureReason: failed ? "mock: simulated exchange failure" : "mock: simulated deposit timeout",
      };
    }

    let status = "awaiting_deposit";
    if (elapsed > 15000) status = "completed";
    else if (elapsed > 10000) status = "exchanging";
    else if (elapsed > 5000) status = "confirming";

    order.status = status;

    return {
      status,
      toAmountUnits: order.toAmountUnits,
      txHash: status === "completed" ? `0xmocktx${providerOrderId}` : null,
    };
  },
  async createMulti({ from, to, amount, sendNetwork, receiveNetwork, recipients, externalUserId }) {
    const d = engine.createMultiExchange({
      send: from,
      receive: to,
      totalAmount: Number(amount),
      sendNetwork,
      receiveNetwork,
      recipients,
      externalUserId,
    });
    return { providerOrderId: d.id, depositAddress: d.depositAddress, raw: d };
  },

  async getMultiStatus(providerOrderId) {
    const d = engine.getMultiExchangeOrder(providerOrderId);
    return { status: normalizeStatus(d.status), raw: d };
  },

  async createPrivate({ from, to, amount, payoutAddress, sendNetwork, receiveNetwork, externalUserId }) {
    const id = engine.createPrivateExchange({
      send: from,
      receive: to,
      amount: Number(amount),
      receiveAddress: payoutAddress,
      sendNetwork,
      receiveNetwork,
      externalUserId,
    });
    const d = engine.getOrderStatus(id);
    return { providerOrderId: id, depositAddress: d.sendAddress, raw: d };
  },

  async getPrivateStatus(providerOrderId) {
    const d = engine.getOrderStatus(providerOrderId);
    return { status: normalizeStatus(d.status), txHash: d.hashOut ?? null, raw: d };
  },

  async createBatch({ from, to, addressCount, payoutAddress, sendNetwork, receiveNetwork, autoProcess, externalUserId }) {
    const d = engine.createBatchOrder({
      addressCount,
      sendToken: from,
      receiveToken: to,
      sendNetwork,
      receiveNetwork,
      receiveAddress: payoutAddress,
      autoProcess,
      externalUserId,
    });
    return { providerOrderId: d.id, raw: d };
  },

  async getBatchStatus(providerOrderId) {
    const d = engine.getBatchOrder(providerOrderId);
    return { status: normalizeStatus(d.status), raw: d };
  },

  async addBatchAddresses(providerOrderId, addressCount) {
    const d = engine.addBatchAddresses(providerOrderId, addressCount);
    return { status: normalizeStatus(d.status), raw: d };
  },

  async executeBatch(providerOrderId) {
    const d = engine.executeBatchOrder(providerOrderId);
    return { status: normalizeStatus(d.status), raw: d };
  },
};