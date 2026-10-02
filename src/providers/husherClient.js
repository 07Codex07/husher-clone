const DEFAULT_BASE_URL = "https://api.husher.net";

function getBaseUrl() {
  return process.env.HUSHER_API_URL || DEFAULT_BASE_URL;
}

function getApiKey() {
  const key = process.env.HUSHER_API_KEY;
  if (!key) {
    throw new Error("HUSHER_API_KEY is not set");
  }
  return key;
}

async function request(path, { method = "GET", query, body } = {}) {
  const url = new URL(path, getBaseUrl());
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const res = await fetch(url, {
    method,
    headers: {
      "x-api-key": getApiKey(),
      ...(body != null ? { "Content-Type": "application/json" } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });

  let payload;
  const text = await res.text();
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Husher API returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok || payload.success === false) {
    const message = payload.message || payload.error || `Husher API error (${res.status})`;
    const err = new Error(message);
    // a bad upstream key is our problem, not the caller's, so 502
    err.status = res.status >= 500 || res.status === 401 || res.status === 403 ? 502 : res.status;
    err.upstreamStatus = res.status;
    err.payload = payload;
    throw err;
  }

  return payload;
}

export async function getRate({
  sendToken,
  receiveToken,
  amountType = "send",
  sendAmount,
  receiveAmount,
  sendNetwork,
  receiveNetwork,
  externalUserId,
  provider = "floating",
  markup,
}) {
  const query = {
    sendToken,
    receiveToken,
    amountType,
    sendNetwork,
    receiveNetwork,
    externalUserId,
    provider,
    markup,
  };

  if (amountType === "receive") {
    query.receiveAmount = receiveAmount;
  } else {
    query.sendAmount = sendAmount;
  }

  const result = await request("/api/v1/husher/rate", { query });
  return result.data;
}

export async function getCurrencies() {
  const result = await request("/api/v1/husher/currencies");
  return result.data ?? result;
}

export async function createExchange(body) {
  const result = await request("/api/v1/husher/create", {
    method: "POST",
    body,
  });
  return result.data;
}

export async function getStatus(transactionId) {
  const result = await request(`/api/v1/husher/status/${encodeURIComponent(transactionId)}`);
  return result.data;
}

export async function getMultiExchangeRate(body) {
  const result = await request("/api/v1/multi-exchange/rate", { method: "POST", body });
  return result.data;
}

export async function createMultiExchange(body) {
  const result = await request("/api/v1/multi-exchange", { method: "POST", body });
  return result.data;
}

export async function getMultiExchangeOrder(multiExchangeOrderId) {
  const result = await request(
    `/api/v1/multi-exchange/${encodeURIComponent(multiExchangeOrderId)}`
  );
  return result.data;
}

// only works after the deposit is confirmed
export async function executeRecipientInstantly(recipientId) {
  const result = await request(
    `/api/v1/multi-exchange/recipient/${encodeURIComponent(recipientId)}/execute-instantly`,
    { method: "POST" }
  );
  return result.data;
}

export async function getMultiExchangeProviders() {
  const result = await request("/api/v1/multi-exchange/providers");
  return result.data;
}

export async function getMinimumWithdrawals({ token, network }) {
  const result = await request("/api/v1/multi-exchange/minimum-withdrawals", {
    query: { token, network },
  });
  return result;
}

// data is just the id string here, not an object
export async function createPrivateExchange(body) {
  const result = await request("/api/v1/exchange/private/create", { method: "POST", body });
  return result.data;
}

export async function getPrivateExchangeStatus(orderId) {
  const result = await request(`/api/v1/exchange/private/order/${encodeURIComponent(orderId)}`);
  return result.data;
}

export async function createBatchOrder(body) {
  return request("/api/v1/batch-order/create", { method: "POST", body });
}

export async function getBatchOrder(orderId) {
  const result = await request(`/api/v1/batch-order/${encodeURIComponent(orderId)}`);
  return result.data;
}

export async function addBatchAddresses(orderId, addressCount) {
  return request(`/api/v1/batch-order/${encodeURIComponent(orderId)}/add-addresses`, {
    method: "POST",
    body: { addressCount },
  });
}

// fails until at least one deposit has arrived
export async function executeBatchOrder(orderId) {
  return request(`/api/v1/batch-order/${encodeURIComponent(orderId)}/execute`, {
    method: "POST",
  });
}

export async function getOrdersForExternalUser(externalUserId, { page = 1, limit = 10 } = {}) {
  const result = await request(
    `/api/v1/user/api-key-orders/external-user/${encodeURIComponent(externalUserId)}`,
    { query: { page, limit } }
  );
  return result.data;
}

export async function createExternalUser(body) {
  const result = await request("/api/v1/api-key/external-users", { method: "POST", body });
  return result.data;
}

export async function listExternalUsers() {
  const result = await request("/api/v1/api-key/external-users");
  return result.data;
}

export async function getExternalUser(externalUserId) {
  const result = await request(`/api/v1/api-key/external-users/${encodeURIComponent(externalUserId)}`);
  return result.data;
}

export async function updateExternalUser(externalUserId, body) {
  const result = await request(`/api/v1/api-key/external-users/${encodeURIComponent(externalUserId)}`, {
    method: "PATCH",
    body,
  });
  return result.data;
}

// also deletes all of the user's orders, no undo
export async function deleteExternalUser(externalUserId) {
  return request(`/api/v1/api-key/external-users/${encodeURIComponent(externalUserId)}`, {
    method: "DELETE",
  });
}
