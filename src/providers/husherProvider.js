import { fromUnits, toUnits } from "../lib/units.js";
import * as husher from "./husherClient.js";
import { normalizeStatus } from "../lib/status.js";

let currencyCache = null;
let currencyCacheAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

function inferDecimals(symbol) {
  const known = { BTC: 8, ETH: 18, USDT: 6, USDC: 6, BNB: 18, SOL: 9, TRX: 6 };
  return known[symbol] ?? 8;
}

// Husher lists each currency once with a networkList, and decimals and send/receive
// flags differ per network (USDT on BSC vs TRX). Flatten to one row per (symbol, network).
function normalizeCurrencies(raw) {
  const list = Array.isArray(raw) ? raw : raw?.currencies ?? [];
  const out = [];

  for (const entry of list) {
    const symbol = entry.currency ?? entry.symbol ?? entry.coin ?? entry.token;
    const name = entry.name ?? symbol;
    const networks = Array.isArray(entry.networkList) ? entry.networkList : [];

    for (const net of networks) {
      out.push({
        symbol,
        name,
        network: net.network,
        decimals: net.receiveDecimals ?? inferDecimals(symbol),
        sendEnabled: net.sendStatus !== false,
        receiveEnabled: net.receiveStatus !== false,
        isDefault: !!net.isDefault,
      });
    }
  }

  return out;
}

async function loadCurrencies() {
  if (currencyCache && Date.now() - currencyCacheAt < CACHE_TTL_MS) {
    return currencyCache;
  }

  const raw = await husher.getCurrencies();
  currencyCache = normalizeCurrencies(raw);
  currencyCacheAt = Date.now();
  return currencyCache;
}

function findCurrency(currencies, symbol, network, capability) {
  let pool = currencies.filter((c) => c.symbol === symbol);
  if (!pool.length) return null;

  if (network) {
    pool = pool.filter((c) => c.network.toUpperCase() === network.toUpperCase());
    if (!pool.length) return null;
  }

  if (capability) {
    const enabled = pool.filter((c) => (capability === "send" ? c.sendEnabled : c.receiveEnabled));
    if (!enabled.length) return null; // listed, but disabled for this direction
    pool = enabled;
  }

  return pool.find((c) => c.isDefault) ?? pool[0];
}

// unsupported pair or network is the caller's mistake: 400, not 500
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

async function resolvePair({ from, to, sendNetwork, receiveNetwork }) {
  const currencies = await loadCurrencies();
  const fromMeta = findCurrency(currencies, from, sendNetwork, "send");
  const toMeta = findCurrency(currencies, to, receiveNetwork, "receive");
  if (!fromMeta) throw badRequest(`${from} is not sendable${sendNetwork ? ` on ${sendNetwork}` : ""}`);
  if (!toMeta) throw badRequest(`${to} is not receivable${receiveNetwork ? ` on ${receiveNetwork}` : ""}`);
  return {
    fromMeta,
    toMeta,
    sendNetwork: sendNetwork ?? fromMeta.network,
    receiveNetwork: receiveNetwork ?? toMeta.network,
  };
}

function parseRate(data) {
  const sendAmount = parseFloat(data.sendAmount);
  const receiveAmount = parseFloat(data.receiveAmount);
  if (!sendAmount) return 0;
  return receiveAmount / sendAmount;
}

export const husherProvider = {
  name: "husher",

  async getCurrencies() {
    return loadCurrencies();
  },

  async getRate({
    from,
    to,
    amountUnits,
    sendNetwork,
    receiveNetwork,
    amountType = "send",
    provider = "floating",
    markup,
    externalUserId,
  }) {
    const pair = await resolvePair({ from, to, sendNetwork, receiveNetwork });
    const { fromMeta, toMeta } = pair;

    const params = {
      sendToken: from,
      receiveToken: to,
      sendNetwork: pair.sendNetwork,
      receiveNetwork: pair.receiveNetwork,
      amountType,
      provider,
      markup,
      externalUserId,
    };

    if (amountType === "receive") {
      params.receiveAmount = fromUnits(amountUnits, toMeta.decimals);
    } else {
      params.sendAmount = fromUnits(amountUnits, fromMeta.decimals);
    }

    const data = await husher.getRate(params);
    const toAmountUnits = toUnits(data.receiveAmount, toMeta.decimals);

    return {
      rate: parseRate(data),
      toAmountUnits,
      provider: this.name,
      raw: data,
    };
  },

  async createExchange({
    from,
    to,
    amountUnits,
    payoutAddress,
    sendNetwork,
    receiveNetwork,
    ipAddress,
    externalUserId,
  }) {
    const pair = await resolvePair({ from, to, sendNetwork, receiveNetwork });

    const amount = fromUnits(amountUnits, pair.fromMeta.decimals);
    const { rate, toAmountUnits } = await this.getRate({
      from,
      to,
      amountUnits,
      sendNetwork: pair.sendNetwork,
      receiveNetwork: pair.receiveNetwork,
    });

    const data = await husher.createExchange({
      send: from,
      sendNetwork: pair.sendNetwork,
      receive: to,
      receiveNetwork: pair.receiveNetwork,
      receiveAddress: payoutAddress,
      amount,
      ipAddress: ipAddress ?? "127.0.0.1",
      externalUserId,
    });

    return {
      providerOrderId: data.id,
      depositAddress: data.sendAddress,
      rate,
      toAmountUnits,
      raw: data,
    };
  },

  async getStatus(providerOrderId) {
    const data = await husher.getStatus(providerOrderId);

    const currencies = await loadCurrencies();
    const toMeta = findCurrency(currencies, data.receiveToken, data.receiveNetwork);
    const decimals = toMeta?.decimals ?? inferDecimals(data.receiveToken);

    return {
      status: normalizeStatus(data.status),
      toAmountUnits: data.receiveAmount ? toUnits(data.receiveAmount, decimals) : null,
      txHash: data.hashOut ?? null,
      raw: data,
    };
  },
  // multi/private/batch: shapes are from the docs, not tested live (it would spend real funds)

  async createMulti({ from, to, amount, recipients, ipAddress, externalUserId, ...networks }) {
    const { sendNetwork, receiveNetwork } = await resolvePair({ from, to, ...networks });
    const n = { sendNetwork, receiveNetwork };
    const d = await husher.createMultiExchange({
      send: from,
      receive: to,
      totalAmount: Number(amount),
      ...n,
      recipients,
      ipAddress: ipAddress ?? "127.0.0.1",
      externalUserId,
    });
    return { providerOrderId: d.id, depositAddress: d.depositAddress ?? d.sendAddress ?? null, raw: d };
  },

  async getMultiStatus(providerOrderId) {
    const d = await husher.getMultiExchangeOrder(providerOrderId);
    return { status: normalizeStatus(d.status), raw: d };
  },

  async createPrivate({ from, to, amount, payoutAddress, ipAddress, externalUserId, ...networks }) {
    const { sendNetwork, receiveNetwork } = await resolvePair({ from, to, ...networks });
    const n = { sendNetwork, receiveNetwork };
    const id = await husher.createPrivateExchange({
      send: from,
      receive: to,
      ...n,
      amount,
      receiveAddress: payoutAddress,
      ipAddress: ipAddress ?? "127.0.0.1",
      externalUserId,
    });
    const d = await husher.getPrivateExchangeStatus(id);
    return { providerOrderId: id, depositAddress: d.sendAddress ?? null, raw: d };
  },

  async getPrivateStatus(providerOrderId) {
    const d = await husher.getPrivateExchangeStatus(providerOrderId);
    return { status: normalizeStatus(d.status), txHash: d.hashOut ?? null, raw: d };
  },

  async createBatch({ from, to, addressCount, payoutAddress, autoProcess, ipAddress, externalUserId, ...networks }) {
    const { sendNetwork, receiveNetwork } = await resolvePair({ from, to, ...networks });
    const n = { sendNetwork, receiveNetwork };
    const res = await husher.createBatchOrder({
      addressCount,
      sendToken: from,
      sendNetwork: n.sendNetwork,
      receiveToken: to,
      receiveNetwork: n.receiveNetwork,
      receiveAddress: payoutAddress,
      ipAddress: ipAddress ?? "127.0.0.1",
      externalUserId,
      autoProcess,
    });
    const d = res?.data ?? res; // this endpoint isn't unwrapped by the client
    return { providerOrderId: d.id ?? d.orderId, raw: d };
  },

  async getBatchStatus(providerOrderId) {
    const d = await husher.getBatchOrder(providerOrderId);
    return { status: normalizeStatus(d.status), raw: d };
  },

  async addBatchAddresses(providerOrderId, addressCount) {
    const res = await husher.addBatchAddresses(providerOrderId, addressCount);
    const d = res?.data ?? res;
    return { status: normalizeStatus(d.status), raw: d };
  },

  async executeBatch(providerOrderId) {
    const res = await husher.executeBatchOrder(providerOrderId);
    const d = res?.data ?? res;
    return { status: normalizeStatus(d.status), raw: d };
  },
};
