import { mockProvider } from "./mockProvider.js";
import { husherProvider } from "./husherProvider.js";

const PROVIDERS = {
  mock: mockProvider,
  husher: husherProvider,
};

const mode = (process.env.EXCHANGE_PROVIDER || "mock").toLowerCase();
const selected = PROVIDERS[mode];

if (!selected) {
  throw new Error(
    `Unknown EXCHANGE_PROVIDER "${mode}", expected one of: ${Object.keys(PROVIDERS).join(", ")}`,
  );
}

export const provider = selected;
