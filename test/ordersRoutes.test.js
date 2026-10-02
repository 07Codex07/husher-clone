import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createFakePrisma } from "./fakePrisma.js";

process.env.EXCHANGE_PROVIDER = "mock";
delete process.env.ORDERS_API_KEYS;
globalThis.prisma = createFakePrisma();

const { app } = await import("../src/app.js");

const ADDR = "0x1234567890123456789012345678901234567890";
let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function call(method, path, body, headers = { "x-api-key": "test" }) {
  const res = await fetch(base + path, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

test("missing x-api-key is rejected", async () => {
  const r = await call("GET", "/api/orders/currencies", null, {});
  assert.equal(r.status, 401);
});

test("currencies are listed one row per (symbol, network)", async () => {
  const r = await call("GET", "/api/orders/currencies");
  assert.equal(r.status, 200);
  const usdt = r.body.data.filter((c) => c.symbol === "USDT").map((c) => c.network);
  assert.deepEqual(usdt.sort(), ["BSC", "ETH", "TRX"]);
});

test("rate quote returns BigInt amounts as strings", async () => {
  const r = await call("GET", "/api/orders/rate?from=BTC&to=ETH&amount=0.1");
  assert.equal(r.status, 200);
  assert.equal(r.body.data.toAmountUnits, "1902205880000000000");
});

test("create exchange persists the order and can be fetched back", async () => {
  const created = await call("POST", "/api/orders", {
    fromCurrency: "btc",
    toCurrency: "ETH",
    amount: "0.1",
    payoutAddress: ADDR,
    externalUserId: "user-1",
  });
  assert.equal(created.status, 201);
  const order = created.body.data;
  assert.equal(order.type, "exchange");
  assert.equal(order.fromCurrency, "BTC");
  assert.equal(order.fromAmountUnits, "10000000");
  assert.equal(order.status, "awaiting_deposit");
  assert.ok(order.depositAddress);

  const fetched = await call("GET", `/api/orders/${order.id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.data.id, order.id);
  assert.ok(fetched.body.data.lastPolledAt, "GET /:id refreshes from the provider");
});

test("a token on a non-default network is accepted", async () => {
  const r = await call("POST", "/api/orders", {
    fromCurrency: "USDT",
    toCurrency: "ETH",
    amount: "100",
    sendNetwork: "BSC",
    payoutAddress: ADDR,
  });
  assert.equal(r.status, 201);
});

test("a network the currency isn't on is a 400, for every order type", async () => {
  const exchange = await call("POST", "/api/orders", {
    fromCurrency: "BTC",
    toCurrency: "ETH",
    amount: "0.1",
    sendNetwork: "BSC",
    payoutAddress: ADDR,
  });
  assert.equal(exchange.status, 400);
  assert.match(exchange.body.message, /BTC is not available on BSC/);

  const batch = await call("POST", "/api/orders/batch", {
    fromCurrency: "BTC",
    toCurrency: "ETH",
    addressCount: 2,
    receiveNetwork: "SOL",
    payoutAddress: ADDR,
  });
  assert.equal(batch.status, 400);
});

test("unsupported currency is a 400, not a 500", async () => {
  const r = await call("GET", "/api/orders/rate?from=DOGE&to=ETH&amount=1");
  assert.equal(r.status, 400);
});

test("validation errors list each problem", async () => {
  const neg = await call("POST", "/api/orders", { fromCurrency: "BTC", toCurrency: "ETH", amount: "-1", payoutAddress: ADDR });
  assert.equal(neg.status, 400);
  assert.equal(neg.body.issues[0].path, "amount");

  const pct = await call("POST", "/api/orders/multi", {
    fromCurrency: "BTC",
    toCurrency: "ETH",
    amount: "0.2",
    recipients: [{ address: ADDR, percent: 70 }],
  });
  assert.equal(pct.status, 400);
  assert.match(pct.body.issues[0].message, /add up to 100/);
});

test("multi, private and batch orders are created and typed", async () => {
  const pair = { fromCurrency: "BTC", toCurrency: "ETH", externalUserId: "user-2" };
  const multi = await call("POST", "/api/orders/multi", {
    ...pair,
    amount: "0.2",
    recipients: [
      { address: ADDR, percent: 60 },
      { address: ADDR, percent: 40 },
    ],
  });
  const priv = await call("POST", "/api/orders/private", { ...pair, amount: "0.05", payoutAddress: ADDR });
  const batch = await call("POST", "/api/orders/batch", { ...pair, addressCount: 3, payoutAddress: ADDR });

  assert.deepEqual(
    [multi, priv, batch].map((r) => [r.status, r.body.data.type]),
    [
      [201, "multi"],
      [201, "private"],
      [201, "batch"],
    ],
  );
});

test("list filters by user and type, with pagination totals", async () => {
  const r = await call("GET", "/api/orders?externalUserId=user-2&type=multi");
  assert.equal(r.status, 200);
  assert.equal(r.body.data.total, 1);
  assert.equal(r.body.data.orders[0].type, "multi");

  const bad = await call("GET", "/api/orders?status=nonsense");
  assert.equal(bad.status, 400);
});

test("unknown or malformed ids are 404", async () => {
  assert.equal((await call("GET", "/api/orders/not-an-id")).status, 404);
  assert.equal((await call("GET", "/api/orders/aaaaaaaaaaaaaaaaaaaaaaaa")).status, 404);
});

test("batch actions refuse non-batch orders", async () => {
  const { body } = await call("POST", "/api/orders", { fromCurrency: "BTC", toCurrency: "ETH", amount: "0.1", payoutAddress: ADDR });
  const r = await call("POST", `/api/orders/${body.data.id}/batch/execute`);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /not "batch"/);
});

test("executing a batch before any deposit arrives is a 400", async () => {
  const { body } = await call("POST", "/api/orders/batch", {
    fromCurrency: "BTC",
    toCurrency: "ETH",
    addressCount: 1,
    payoutAddress: ADDR,
  });
  const r = await call("POST", `/api/orders/${body.data.id}/batch/execute`);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /no deposits/);
});

test("every response carries a request id, echoed from the caller when valid", async () => {
  const fresh = await fetch(`${base}/health`);
  assert.match(fresh.headers.get("x-request-id"), /^[\w-]{12}$/);

  const echoed = await fetch(`${base}/health`, { headers: { "x-request-id": "ticket-4821" } });
  assert.equal(echoed.headers.get("x-request-id"), "ticket-4821");

  const junk = await fetch(`${base}/health`, { headers: { "x-request-id": "<script>" } });
  assert.notEqual(junk.headers.get("x-request-id"), "<script>");
});

test("error bodies include the request id so support can find the log line", async () => {
  const res = await fetch(`${base}/api/orders/aaaaaaaaaaaaaaaaaaaaaaaa`, {
    headers: { "x-api-key": "test", "x-request-id": "support-123" },
  });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).requestId, "support-123");
});

test("malformed JSON is a 400, not a 500", async () => {
  const res = await fetch(`${base}/api/orders`, {
    method: "POST",
    headers: { "x-api-key": "test", "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
});
