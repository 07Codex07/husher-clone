import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";

import * as engine from "./mock/engine.js";
import { ordersRouter } from "./routes/orders.js";
import { requireOrdersKey } from "./lib/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();

app.use(cors({ exposedHeaders: ["x-request-id"] }));
app.use(express.json());

// same id goes in the error log, so a support ticket can quote it
const REQUEST_ID = /^[\w-]{1,64}$/;
app.use((req, res, next) => {
  const given = req.header("x-request-id");
  req.id = given && REQUEST_ID.test(given) ? given : nanoid(12);
  res.setHeader("x-request-id", req.id);
  next();
});

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, data) => res.json({ success: true, data });

const api = express.Router();

api.use((req, res, next) => {
  if (req.path === "/v1/_mock/reset") return next();
  if (!req.header("x-api-key")) {
    return res.status(401).json({ success: false, message: "missing x-api-key header" });
  }
  next();
});

api.post("/v1/_mock/reset", (req, res) => send(res, engine.resetAll()));

// the real order API; the /v1 routes below are an in-memory mock for Postman
api.use("/orders", requireOrdersKey, ordersRouter);

// exchange
api.get("/v1/husher/rate", h((req, res) => send(res, engine.getRate(req.query))));
api.get("/v1/husher/currencies", h((req, res) => send(res, engine.getCurrencies())));
api.post("/v1/husher/create", h((req, res) => send(res, engine.createExchange(req.body))));
api.get("/v1/husher/status/:id", h((req, res) => send(res, engine.getOrderStatus(req.params.id))));

// multi exchange (specific paths before /:id)
api.post("/v1/multi-exchange/rate", h((req, res) => send(res, engine.getMultiRate(req.body))));
api.get("/v1/multi-exchange/providers", h((req, res) => send(res, engine.getMultiExchangeProviders())));
api.get(
  "/v1/multi-exchange/minimum-withdrawals",
  h((req, res) => send(res, engine.getMinimumWithdrawals(req.query))),
);
api.post(
  "/v1/multi-exchange/recipient/:id/execute-instantly",
  h((req, res) => send(res, engine.executeRecipientInstantly(req.params.id))),
);
api.post("/v1/multi-exchange", h((req, res) => send(res, engine.createMultiExchange(req.body))));
api.get("/v1/multi-exchange/:id", h((req, res) => send(res, engine.getMultiExchangeOrder(req.params.id))));

// private exchange
api.post(
  "/v1/exchange/private/create",
  h((req, res) => send(res, engine.createPrivateExchange(req.body))),
);
api.get(
  "/v1/exchange/private/order/:id",
  h((req, res) => send(res, engine.getOrderStatus(req.params.id))),
);

// user orders
api.get(
  "/v1/user/api-key-orders/external-user/:id",
  h((req, res) =>
    send(res, engine.getOrdersForExternalUser(req.params.id, req.query)),
  ),
);

// external users
api.post("/v1/api-key/external-users", h((req, res) => send(res, engine.createExternalUser(req.body))));
api.get("/v1/api-key/external-users", h((req, res) => send(res, engine.listExternalUsers())));
api.get("/v1/api-key/external-users/:id", h((req, res) => send(res, engine.getExternalUser(req.params.id))));
api.patch(
  "/v1/api-key/external-users/:id",
  h((req, res) => send(res, engine.updateExternalUser(req.params.id, req.body))),
);
api.delete(
  "/v1/api-key/external-users/:id",
  h((req, res) => send(res, engine.deleteExternalUser(req.params.id))),
);

// batch orders (specific paths before /:id)
api.post("/v1/batch-order/create", h((req, res) => send(res, engine.createBatchOrder(req.body))));
api.post(
  "/v1/batch-order/:id/add-addresses",
  h((req, res) => send(res, engine.addBatchAddresses(req.params.id, req.body?.addressCount))),
);
api.post("/v1/batch-order/:id/execute", h((req, res) => send(res, engine.executeBatchOrder(req.params.id))));
api.get("/v1/batch-order/:id", h((req, res) => send(res, engine.getBatchOrder(req.params.id))));

app.use("/api", api);

app.get("/health", (req, res) => res.json({ success: true, status: "ok" }));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "..", "HusherApi.html")));

app.use((req, res) => {
  res.status(404).json({ success: false, message: `no route for ${req.method} ${req.path}` });
});

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error(`[${req.id}] ${req.method} ${req.originalUrl} ->`, err);
    // don't leak DB errors or stack traces
    const message =
      process.env.NODE_ENV === "production" && status === 500 ? "internal server error" : err.message;
    return res.status(status).json({ success: false, message, requestId: req.id });
  }
  res.status(status).json({ success: false, message: err.message, requestId: req.id });
});
