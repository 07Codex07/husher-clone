import crypto from "node:crypto";

const configuredKeys = () =>
  (process.env.ORDERS_API_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

const digest = (s) => crypto.createHash("sha256").update(s).digest();

export function assertAuthConfigured() {
  if (process.env.NODE_ENV === "production" && configuredKeys().length === 0) {
    throw new Error("ORDERS_API_KEYS must be set when NODE_ENV=production");
  }
}

export function isValidOrdersKey(key) {
  if (!key) return false;
  const keys = configuredKeys();
  if (keys.length === 0) return true;

  const given = digest(String(key));
  // hash first so timingSafeEqual gets equal lengths
  return keys.some((k) => crypto.timingSafeEqual(digest(k), given));
}

export function requireOrdersKey(req, res, next) {
  if (!isValidOrdersKey(req.header("x-api-key"))) {
    return res.status(401).json({ success: false, message: "invalid api key" });
  }
  next();
}
