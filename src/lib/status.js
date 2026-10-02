const MAP = {
  pending: "awaiting_deposit",
  awaiting_deposit: "awaiting_deposit",
  awaiting_deposits: "awaiting_deposit", // batch
  confirmed: "confirming",
  confirming: "confirming",
  deposits_arriving: "confirming", // batch
  exchanging: "exchanging",
  withdraw: "exchanging",
  processing: "exchanging", // multi / batch
  completed: "completed",
  expired: "expired",
  failed: "failed",
};

export const TERMINAL_STATUSES = ["completed", "failed", "expired"];

export function normalizeStatus(status) {
  return MAP[String(status ?? "").toLowerCase()] ?? String(status);
}

export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}
