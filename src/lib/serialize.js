export function serializeOrder(order) {
  return {
    ...order,
    fromAmountUnits: order.fromAmountUnits != null ? order.fromAmountUnits.toString() : null,
    toAmountUnits: order.toAmountUnits != null ? order.toAmountUnits.toString() : null,
  };
}
