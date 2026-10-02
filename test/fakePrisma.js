import { randomBytes } from "node:crypto";

function matches(order, where = {}) {
  return Object.entries(where).every(([key, cond]) => {
    if (cond && typeof cond === "object" && "notIn" in cond) return !cond.notIn.includes(order[key]);
    return order[key] === cond;
  });
}

// Prisma ignores undefined fields in `data`
const defined = (data) => Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));

export function createFakePrisma() {
  const rows = new Map();

  const order = {
    async create({ data }) {
      const now = new Date();
      const row = {
        id: randomBytes(12).toString("hex"),
        toAmountUnits: null,
        providerOrderId: null,
        depositAddress: null,
        payoutAddress: null,
        txHash: null,
        externalUserId: null,
        failureReason: null,
        meta: null,
        expiresAt: null,
        lastPolledAt: null,
        status: "pending",
        ...defined(data),
        createdAt: now,
        updatedAt: now,
      };
      rows.set(row.id, row);
      return { ...row };
    },
    async findUnique({ where }) {
      const row = rows.get(where.id);
      return row ? { ...row } : null;
    },
    async findMany({ where, orderBy, skip = 0, take = Infinity } = {}) {
      let list = [...rows.values()].filter((r) => matches(r, where));
      if (orderBy?.createdAt === "desc") list.sort((a, b) => b.createdAt - a.createdAt);
      return list.slice(skip, skip + take).map((r) => ({ ...r }));
    },
    async count({ where } = {}) {
      return [...rows.values()].filter((r) => matches(r, where)).length;
    },
    async update({ where, data }) {
      const row = rows.get(where.id);
      if (!row) throw new Error("record not found");
      Object.assign(row, defined(data), { updatedAt: new Date() });
      return { ...row };
    },
  };

  return { order, _rows: rows };
}
