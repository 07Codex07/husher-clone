import "dotenv/config";
import { spawn } from "node:child_process";
import { io } from "socket.io-client";
import { setTimeout as sleep } from "node:timers/promises";
import { prisma } from "../src/lib/prisma.js";

const FULL = process.argv.includes("--full");
const LIVE = process.argv.includes("--live");
const PORT = 3100;
const BASE = `http://localhost:${PORT}`;
const KEY = { "x-api-key": "demo-key" };
const USER = "demo-run";
const ADDR = "0x1234567890123456789012345678901234567890";

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const step = (n, title) => console.log(`\n${bold(`${n}. ${title}`)}`);
const show = (label, value) => console.log(`   ${dim(label.padEnd(16))} ${value}`);

async function call(method, path, body, headers = KEY) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const colour = (s) => (s === "completed" ? green(s) : s === "failed" || s === "expired" ? red(s) : s);

async function main() {
  const server = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, PORT: String(PORT), EXCHANGE_PROVIDER: "mock", WORKER_INTERVAL_MS: "2000", NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLog = [];
  server.stdout.on("data", (d) => serverLog.push(String(d)));
  server.stderr.on("data", (d) => serverLog.push(String(d)));

  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try {
        up = (await fetch(`${BASE}/health`)).ok;
      } catch {}
      if (!up) await sleep(300);
    }
    if (!up) throw new Error(`server did not answer /health on :${PORT} within 18s`);

    step(1, "Server is up, and auth is enforced");
    show("GET /health", JSON.stringify((await call("GET", "/health", null, {})).body));
    const noKey = await call("GET", "/api/orders/currencies", null, {});
    show("no x-api-key", `${noKey.status} ${noKey.body.message}`);

    step(2, "Live Husher rate (read-only, no order created)");
    if (LIVE) {
      const { husherProvider } = await import("../src/providers/husherProvider.js");
      const { toUnits } = await import("../src/lib/units.js");
      const cur = await husherProvider.getCurrencies();
      const usdt = cur.find((c) => c.symbol === "USDT" && c.network === "BSC");
      const r = await husherProvider.getRate({
        from: "USDT",
        to: "BNB",
        amountUnits: toUnits("100", usdt.decimals),
        sendNetwork: "BSC",
        receiveNetwork: "BSC",
      });
      show("currencies", `${cur.length} (symbol, network) pairs loaded`);
      show("100 USDT ->", `${r.raw.receiveAmount} BNB  (rate ${r.rate.toFixed(8)})`);
    } else {
      console.log(dim("   skipped, run with --live to include"));
    }

    step(3, "Realtime: subscribe to this user's orders over socket.io");
    const socket = io(BASE, { auth: { apiKey: KEY["x-api-key"] }, transports: ["websocket"] });
    const pushed = [];
    socket.on("order:update", (o) => pushed.push(o));
    const sub = await socket.timeout(5000).emitWithAck("subscribe", { externalUserId: USER });
    show("subscribed", sub.rooms.join(", "));

    step(4, "Quote through the persisted API (mock provider)");
    const rate = (await call("GET", "/api/orders/rate?from=BTC&to=ETH&amount=0.1")).body.data;
    show("0.1 BTC ->", `${Number(rate.toAmountUnits) / 1e18} ETH  (rate ${rate.rate})`);
    show("provider", rate.provider);

    step(5, "Create one order of every type");
    const make = async (label, path, body) => {
      const r = await call("POST", path, { ...body, externalUserId: USER });
      if (r.status !== 201) throw new Error(`${label} failed: ${r.status} ${JSON.stringify(r.body)}`);
      show(label, `${r.body.data.id}  ${dim(r.body.data.depositAddress ?? "")}`);
      return r.body.data;
    };
    const pair = { fromCurrency: "BTC", toCurrency: "ETH" };
    const exchange = await make("exchange", "/api/orders", { ...pair, amount: "0.1", payoutAddress: ADDR });
    const failing = await make("exchange (fail)", "/api/orders", { ...pair, amount: "0.1", payoutAddress: "0xfail" });
    const priv = await make("private", "/api/orders/private", { ...pair, amount: "0.05", payoutAddress: ADDR });
    const multi = await make("multi 60/40", "/api/orders/multi", {
      ...pair,
      amount: "0.2",
      recipients: [
        { address: ADDR, percent: 60 },
        { address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", percent: 40 },
      ],
    });
    const batch = await make("batch x3", "/api/orders/batch", { ...pair, addressCount: 3, payoutAddress: ADDR });

    step(6, "Validation rejects bad input");
    const bad = await call("POST", "/api/orders/multi", {
      ...pair,
      amount: "0.2",
      recipients: [{ address: ADDR, percent: 70 }],
    });
    show("60% total", `${bad.status} ${bad.body.issues?.[0]?.message}`);
    const bad2 = await call("POST", "/api/orders", { ...pair, amount: "-1", payoutAddress: ADDR });
    show("negative amount", `${bad2.status} ${bad2.body.issues?.[0]?.message}`);

    step(7, `Background worker moves statuses (the demo only lists orders, never refreshes them)`);
    const deadline = Date.now() + (FULL ? 80_000 : 22_000);
    let batchExecuted = false;
    let rows = [];
    while (Date.now() < deadline) {
      const list = await call("GET", `/api/orders?externalUserId=${USER}&limit=20`);
      rows = list.body.data.orders.reverse();
      console.log(
        "   " +
          rows.map((o) => `${o.type}${o.id === failing.id ? "(fail)" : ""}: ${colour(o.status)}`).join(dim("  |  ")),
      );

      const b = rows.find((o) => o.id === batch.id);
      if (!batchExecuted && b.status === "confirming") {
        const ex = await call("POST", `/api/orders/${batch.id}/batch/execute`);
        show("batch execute", `deposits arrived -> ${ex.status} ${colour(ex.body.data.status)}`);
        batchExecuted = true;
      }
      const watched = FULL ? rows : rows.filter((o) => o.type === "exchange");
      if (watched.every((o) => ["completed", "failed", "expired"].includes(o.status))) break;
      await sleep(3000);
    }

    step(8, "Final state");
    const ok = rows.find((o) => o.id === exchange.id);
    const bads = rows.find((o) => o.id === failing.id);
    show("exchange", `${colour(ok.status)}  tx ${ok.txHash ?? "-"}`);
    show("failing exchange", `${colour(bads.status)}  reason: ${bads.failureReason}`);
    show("private", colour(rows.find((o) => o.id === priv.id).status) + (FULL ? "" : dim("  (needs ~65s; --full waits)")));
    show("multi", colour(rows.find((o) => o.id === multi.id).status) + (FULL ? "" : dim("  (needs ~60s; --full waits)")));
    show("batch", colour(rows.find((o) => o.id === batch.id).status) + (FULL ? "" : dim("  (needs ~45s; --full waits)")));

    step(9, "Filtering");
    const failed = await call("GET", `/api/orders?externalUserId=${USER}&status=failed`);
    show("?status=failed", `${failed.body.data.total} order(s)`);
    const multis = await call("GET", `/api/orders?externalUserId=${USER}&type=multi`);
    show("?type=multi", `${multis.body.data.total} order(s)`);

    step(10, "Pushed over socket.io while this ran (no polling on the client)");
    socket.disconnect();
    show("events", `${pushed.length} order:update events`);
    for (const o of pushed.filter((o) => o.id === exchange.id)) show(`  ${o.type} ${o.id.slice(-6)}`, colour(o.status));
    const err = await call("GET", "/api/orders/000000000000000000000000", null, { ...KEY, "x-request-id": "demo-ticket-1" });
    show("request id", `${err.status} ${err.body.message} -> requestId ${err.body.requestId} (same id in server log)`);
  } catch (err) {
    console.error(dim(`
--- server log ---
${serverLog.join("").trim()}
------------------`));
    throw err;
  } finally {
    // wait for the worker to stop, otherwise its last writes conflict with the delete
    if (server.exitCode === null) await new Promise((r) => (server.once("exit", r), server.kill()));
    let count = 0;
    for (let attempt = 1; ; attempt++) {
      try {
        ({ count } = await prisma.order.deleteMany({ where: { externalUserId: USER } }));
        break;
      } catch (err) {
        if (attempt >= 10 || !/write conflict|deadlock/i.test(err.message)) throw err;
        await sleep(1000);
      }
    }
    console.log(`\n${dim(`cleaned up ${count} demo orders`)}`);
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(red(`\ndemo failed: ${err.message}`));
  process.exit(1);
});
