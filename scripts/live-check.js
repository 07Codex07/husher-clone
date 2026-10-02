import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

// load .env relative to this file so it runs from any folder
config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env") });

const husher = await import("../src/providers/husherClient.js");
const { husherProvider } = await import("../src/providers/husherProvider.js");
const { toUnits } = await import("../src/lib/units.js");

const currencies = await husherProvider.getCurrencies();
console.log(`currencies: ${currencies.length} (symbol, network) pairs`, currencies.slice(0, 3));

const usdtBsc = currencies.find((c) => c.symbol === "USDT" && c.network === "BSC");
const rate = await husherProvider.getRate({
  from: "USDT",
  to: "BNB",
  amountUnits: toUnits("100", usdtBsc.decimals),
  sendNetwork: "BSC",
  receiveNetwork: "BSC",
});
console.log(`rate: 100 USDT -> ${rate.raw.receiveAmount} BNB (${rate.rate})`);

console.log("multi-exchange providers:", await husher.getMultiExchangeProviders());
console.log("minimum withdrawal USDT/BSC:", await husher.getMinimumWithdrawals({ token: "USDT", network: "BSC" }));
console.log(
  "multi-exchange rate:",
  await husher.getMultiExchangeRate({
    sendToken: "USDT",
    sendNetwork: "BSC",
    totalAmount: 100,
    receiveNetwork: "BSC",
    receiveToken: "BNB",
    recipients: [{ percent: 100, provider: "husher" }],
  }),
);
