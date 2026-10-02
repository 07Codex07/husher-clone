import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { io as connect } from "socket.io-client";
import { createFakePrisma } from "./fakePrisma.js";

process.env.EXCHANGE_PROVIDER = "mock";
delete process.env.ORDERS_API_KEYS;
globalThis.prisma = createFakePrisma();

const { app } = await import("../src/app.js");
const { attachRealtime } = await import("../src/realtime.js");

const ADDR = "0x1234567890123456789012345678901234567890";
let server;
let realtime;
let base;
const sockets = [];

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  realtime = attachRealtime(server);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  sockets.forEach((s) => s.disconnect());
  await realtime.close();
});

function open(auth) {
  const socket = connect(base, { auth, transports: ["websocket"], reconnection: false });
  sockets.push(socket);
  return socket;
}

const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));

const createOrder = (body) =>
  fetch(`${base}/api/orders`, {
    method: "POST",
    headers: { "x-api-key": "test", "content-type": "application/json" },
    body: JSON.stringify({ fromCurrency: "BTC", toCurrency: "ETH", amount: "0.1", payoutAddress: ADDR, ...body }),
  }).then((r) => r.json());

test("connecting without an api key is refused", async () => {
  const err = await once(open({}), "connect_error");
  assert.match(err.message, /invalid api key/);
});

test("subscribe needs an orderId or externalUserId", async () => {
  const socket = open({ apiKey: "test" });
  await once(socket, "connect");
  const ack = await socket.emitWithAck("subscribe", {});
  assert.equal(ack.ok, false);
});

test("a user subscriber is pushed their new orders, and nobody else's", async () => {
  const socket = open({ apiKey: "test" });
  await once(socket, "connect");
  const ack = await socket.emitWithAck("subscribe", { externalUserId: "alice" });
  assert.deepEqual(ack.rooms, ["user:alice"]);

  const received = [];
  socket.on("order:update", (o) => received.push(o));

  await createOrder({ externalUserId: "bob" });
  const { data } = await createOrder({ externalUserId: "alice" });

  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, 1);
  assert.equal(received[0].id, data.id);
  assert.equal(received[0].status, "awaiting_deposit");
  assert.equal(typeof received[0].fromAmountUnits, "string");
});

test("an order subscriber gets that order only once even if also in the user room", async () => {
  const { data } = await createOrder({ externalUserId: "carol" });
  const socket = open({ apiKey: "test" });
  await once(socket, "connect");
  await socket.emitWithAck("subscribe", { orderId: data.id, externalUserId: "carol" });

  const received = [];
  socket.on("order:update", (o) => received.push(o));

  // simulate the worker moving the order
  const { publishOrderUpdate } = await import("../src/lib/events.js");
  publishOrderUpdate({ ...data, status: "confirming", fromAmountUnits: 1n, toAmountUnits: null });

  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, 1);
  assert.equal(received[0].status, "confirming");
});
