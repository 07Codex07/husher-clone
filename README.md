# Husher Integration Backend

Express service built on the Husher exchange API. It gives an integrator a validated,
persisted order layer (exchange, private, multi and batch), a BullMQ/Redis worker that
keeps order status current, socket.io push updates so clients don't have to poll, and a
full in-memory mock so everything can be tested without spending real funds.

## Run

    cp .env.example .env      # set DATABASE_URL (MongoDB); HUSHER_API_KEY only for live mode
    npm install
    npx prisma generate && npx prisma db push
    docker compose up -d redis  # optional: BullMQ worker; set REDIS_URL=redis://localhost:6379
    npm run dev               # http://localhost:3000  (tester page at /)
    npm test                  # unit, HTTP route and socket tests, no DB or network needed
    REDIS_URL=redis://localhost:6379 npm test   # ...plus the BullMQ integration test
    npm run demo              # ~25s guided walkthrough (mock provider, cleans up after itself)
    npm run demo -- --live    # ...plus a read-only live Husher quote
    npm run demo -- --full    # ...and wait for multi + batch orders to finish (~75s)
    npm run demo:full         # same as --full; use this in PowerShell, which swallows the `--`
    npm run demo:live         # --full plus the live quote
    npm run live-check        # read-only calls to the live Husher API (needs HUSHER_API_KEY)

## Modes

`EXCHANGE_PROVIDER=mock` (default) never contacts Husher. `husher` uses the real API with `HUSHER_API_KEY`.

## Endpoints

Persisted layer, `x-api-key` required (allow-list via `ORDERS_API_KEYS`):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/orders/currencies` | currencies, one row per (symbol, network) |
| GET | `/api/orders/rate?from&to&amount` | quote |
| POST | `/api/orders` | plain exchange |
| POST | `/api/orders/private` | non-custodial exchange |
| POST | `/api/orders/multi` | one deposit split across recipients (percents must sum to 100) |
| POST | `/api/orders/batch` | many deposit addresses, one pair |
| POST | `/api/orders/:id/batch/add-addresses`, `/execute` | batch actions |
| GET | `/api/orders?externalUserId&type&status&page&limit` | list / filter |
| GET | `/api/orders/:id` | one order, refreshed from the provider |

`/api/v1/*` is an in-memory mock of the Husher API itself (Postman collection and `HusherApi.html` included).

Every response has an `x-request-id` header (a caller-supplied one is echoed back), and error bodies
include `requestId`. The same id is on the server's error log line, so a ticket can quote it.

## Realtime updates (socket.io)

Same port, same API keys. `order:update` fires on create and on every status change.

```js
const socket = io("http://localhost:3000", { auth: { apiKey: "..." } });
await socket.emitWithAck("subscribe", { externalUserId: "user-42" }); // or { orderId }
socket.on("order:update", (order) => console.log(order.id, order.status));
```

## How status stays current

`src/worker.js` refreshes open orders with the same `refreshOrder` logic as `GET /:id`:

- **With Redis (BullMQ):** a job scheduler fires one `scan` job every `WORKER_INTERVAL_MS`
  across all instances. The scan enqueues a `refresh` job per open order with
  `jobId = refresh-<orderId>`, so an order is never queued twice. Refreshes run
  `WORKER_CONCURRENCY` at a time and retry 3 times with exponential backoff. Status
  changes are published on Redis pub/sub, so the socket server on every instance hears them.
- **Without Redis:** the same scan + refresh run on an in-process interval, and events go
  through a local EventEmitter. If `REDIS_URL` is set but unreachable, development falls back
  with a warning; production refuses to start.

Statuses from every product are normalised (`src/lib/status.js`) to: `awaiting_deposit`,
`confirming`, `exchanging`, `completed`, `failed`, `expired`. Unfunded orders past
`ORDER_EXPIRY_MINUTES` become `expired`. SIGINT/SIGTERM let in-flight jobs finish before exit.

Mock test hooks: a payout address containing `fail` ends `failed`; containing `expire` ends `expired`.

## Design notes

- Amounts are BigInt smallest-units end to end; decimal strings appear only at the API boundary (`src/lib/units.js`).
- Currencies are flattened per (symbol, network) with send/receive flags, matching Husher's `networkList`.
- The provider adapter interface keeps routes independent of mock vs live. Both providers
  return currencies one row per (symbol, network); routes resolve the exact row for the
  requested network, so decimals and send/receive availability are per network.
- `src/app.js` builds the Express app; `src/server.js` only listens and starts the worker,
  so route tests mount the real app with an in-memory Prisma stand-in (`test/fakePrisma.js`).
- Upstream 5xx/401/403 are surfaced as 502: a bad upstream key is the server's problem, not the caller's.
- Production refuses to start without `ORDERS_API_KEYS`.

## Common integration issues

Gathered from reading the API and building against it. Add real ticket patterns from support here.

1. **Wrong network.** The same token exists on several networks (USDT on TRX, BSC, ETH). Sending on one and
   specifying another loses the deposit. Always pass `sendNetwork` and `receiveNetwork` explicitly.
2. **Currency listed but not usable.** A row can exist with `sendStatus` or `receiveStatus` false. Check the
   direction before quoting (`findCurrency` does; a raw integration must).
3. **Below-minimum amounts.** Minimums differ per provider (e.g. USDT on BSC: 3.3 to 11 by provider). The rate
   response includes `minimum`; validate before creating.
4. **Percents that do not sum to 100** on multi-exchange are rejected.
5. **`execute` before funds arrive.** Batch `execute` and multi `execute-instantly` fail until a deposit is confirmed.
6. **Private exchange returns a bare id string**, not an object, unlike the other create calls.
7. **Batch create is not unwrapped** by the client (`data` vs top level); handle both shapes.
8. **Missing `x-api-key`** returns 401, and browsers cannot call the API directly (CORS): go through a backend.
9. **Non-JSON error bodies** from upstream happen (proxies, gateway errors); do not assume `.json()` succeeds.

## Open questions for the Husher team

- `receiveDecimals` from `/husher/currencies` reads 4 for USDT and 8 for ETH. Is that display precision or
  the token's real decimals? Amounts here are consistent (same value used both directions) but are
  precision-capped rather than true on-chain smallest units.
- Multi, private and batch create responses were built from the client's documented shapes. They are
  exercised against the mock and unit tests, not against live (creating orders spends real funds).

## Not built

Webhook delivery to integrators, per-key order ownership (any valid key can read or subscribe
to any order).
