import { z } from "zod";

const currencyCode = z.string().trim().min(1).max(20).toUpperCase();
const decimalAmount = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, 'amount must be a positive decimal string, e.g. "1.5"')
  .refine((v) => Number(v) > 0, "amount must be greater than zero");
const optionalId = z.string().trim().min(1).max(200).optional();
const address = z.string().trim().min(1).max(500);

export const rateQuerySchema = z.object({
  from: currencyCode,
  to: currencyCode,
  amount: decimalAmount,
  amountType: z.enum(["send", "receive"]).default("send"),
  sendNetwork: currencyCode.optional(),
  receiveNetwork: currencyCode.optional(),
  externalUserId: optionalId,
});

export const createOrderSchema = z.object({
  fromCurrency: currencyCode,
  toCurrency: currencyCode,
  amount: decimalAmount,
  payoutAddress: address,
  sendNetwork: currencyCode.optional(),
  receiveNetwork: currencyCode.optional(),
  externalUserId: optionalId,
  ipAddress: z.string().trim().max(64).optional(),
});

export const createMultiOrderSchema = z.object({
  fromCurrency: currencyCode,
  toCurrency: currencyCode,
  amount: decimalAmount,
  recipients: z
    .array(
      z.object({
        address,
        percent: z.number().positive().max(100),
        provider: z.string().trim().min(1).max(50).optional(),
        timeDelay: z.number().int().min(0).optional(),
      }),
    )
    .min(1)
    .max(20)
    .refine(
      (rs) => Math.abs(rs.reduce((sum, r) => sum + r.percent, 0) - 100) < 0.01,
      "recipient percents must add up to 100",
    ),
  sendNetwork: currencyCode.optional(),
  receiveNetwork: currencyCode.optional(),
  externalUserId: optionalId,
  ipAddress: z.string().trim().max(64).optional(),
});

export const createBatchOrderSchema = z.object({
  fromCurrency: currencyCode,
  toCurrency: currencyCode,
  addressCount: z.number().int().min(1).max(50),
  payoutAddress: address,
  autoProcess: z.boolean().optional(),
  sendNetwork: currencyCode.optional(),
  receiveNetwork: currencyCode.optional(),
  externalUserId: optionalId,
  ipAddress: z.string().trim().max(64).optional(),
});

export const addAddressesSchema = z.object({
  addressCount: z.number().int().min(1).max(50),
});

export const listOrdersQuerySchema = z.object({
  externalUserId: optionalId,
  type: z.enum(["exchange", "multi", "private", "batch"]).optional(),
  status: z
    .enum(["awaiting_deposit", "confirming", "exchanging", "completed", "failed", "expired"])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function validate(schema, source = "body") {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: "validation failed",
        issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    req[source] = result.data;
    next();
  };
}
