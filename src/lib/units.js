export function fromUnits(amountUnits, decimals) {
  const negative = amountUnits < 0n;
  const abs = negative ? -amountUnits : amountUnits;
  const padded = abs.toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals) || "0";
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  const result = fraction ? `${whole}.${fraction}` : whole;
  return negative ? `-${result}` : result;
}

export function toUnits(amount, decimals) {
  const trimmed = String(amount).trim();
  if (!trimmed) throw new Error("Amount required");

  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const fractionPadded = fraction.padEnd(decimals, "0").slice(0, decimals);
  const combined = whole.replace(/^0+(?=\d)/, "") + fractionPadded;
  const units = BigInt(combined || "0");
  return negative ? -units : units;
}
