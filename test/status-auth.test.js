import test from "node:test";
import assert from "node:assert/strict";
import { normalizeStatus, isTerminal } from "../src/lib/status.js";
import { requireOrdersKey, assertAuthConfigured } from "../src/lib/auth.js";

test("upstream status words from every product map to one vocabulary", () => {
  assert.equal(normalizeStatus("pending"), "awaiting_deposit");
  assert.equal(normalizeStatus("awaiting_deposits"), "awaiting_deposit"); // batch
  assert.equal(normalizeStatus("deposits_arriving"), "confirming"); // batch
  assert.equal(normalizeStatus("processing"), "exchanging"); // multi
  assert.equal(normalizeStatus("withdraw"), "exchanging");
  assert.equal(normalizeStatus("COMPLETED"), "completed");
  assert.equal(normalizeStatus("something_new"), "something_new");
});

test("terminal statuses stop polling", () => {
  for (const s of ["completed", "failed", "expired"]) assert.ok(isTerminal(s));
  for (const s of ["awaiting_deposit", "confirming", "exchanging"]) assert.ok(!isTerminal(s));
});

function run(headers = {}) {
  const req = { header: (n) => headers[n.toLowerCase()] };
  const out = { nexted: false, status: null };
  const res = {
    status(c) {
      out.status = c;
      return this;
    },
    json() {
      return this;
    },
  };
  requireOrdersKey(req, res, () => (out.nexted = true));
  return out;
}

test("auth: with ORDERS_API_KEYS set, only listed keys pass", () => {
  process.env.ORDERS_API_KEYS = "key-one, key-two";
  assert.equal(run({ "x-api-key": "key-two" }).nexted, true);
  assert.equal(run({ "x-api-key": "nope" }).status, 401);
  assert.equal(run({}).status, 401);
  delete process.env.ORDERS_API_KEYS;
});

test("auth: unset in dev is open, unset in production refuses to start", () => {
  delete process.env.ORDERS_API_KEYS;
  assert.equal(run({ "x-api-key": "anything" }).nexted, true);

  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  assert.throws(() => assertAuthConfigured(), /ORDERS_API_KEYS/);
  process.env.ORDERS_API_KEYS = "k";
  assert.doesNotThrow(() => assertAuthConfigured());
  delete process.env.ORDERS_API_KEYS;
  process.env.NODE_ENV = prev;
});
