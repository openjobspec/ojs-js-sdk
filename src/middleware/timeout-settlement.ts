export interface TimeoutSettlement {
  settlement: Promise<void>;
  settlementGraceMs: number;
}

const timeoutSettlements = new WeakMap<object, TimeoutSettlement>();

export function registerTimeoutSettlement(
  error: object,
  settlement: Promise<void>,
  settlementGraceMs: number,
): void {
  timeoutSettlements.set(error, { settlement, settlementGraceMs });
}

export function getTimeoutSettlement(
  error: unknown,
): TimeoutSettlement | undefined {
  return typeof error === 'object' && error !== null
    ? timeoutSettlements.get(error)
    : undefined;
}
