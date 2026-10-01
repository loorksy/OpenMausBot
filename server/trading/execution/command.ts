/** Broker command after the proposal has been checked. Prices are copied, not recomputed. */
export const METAAPI_CLIENT_ID_LENGTH = 26;

export const PENDING_ACTION_TYPES = [
  "ORDER_TYPE_BUY_LIMIT",
  "ORDER_TYPE_BUY_STOP",
  "ORDER_TYPE_SELL_LIMIT",
  "ORDER_TYPE_SELL_STOP",
] as const;

export type PendingActionType = (typeof PENDING_ACTION_TYPES)[number];

export interface BrokerOrderCommand {
  readonly instrument: "XAUUSD";
  readonly symbol: "XAUUSD";
  readonly direction: "LONG" | "SHORT";
  readonly actionType: PendingActionType;
  readonly volume: number;
  readonly openPrice: number;
  readonly stopLoss: number;
  readonly takeProfit: number | null;
  readonly clientId: string;
  readonly executionRequestId: string;
}

/** MetaApi pending type for an exact open price. A market order is not used.
 * Equal-to-market prices are not representable and return null. */
export function pendingAction(
  direction: "LONG" | "SHORT",
  entry: number,
  bid: number,
  ask: number,
): PendingActionType | null {
  if (!(bid > 0) || !(ask > 0) || !(ask >= bid) || !(entry > 0)) return null;
  if (direction === "LONG") {
    if (entry < ask) return "ORDER_TYPE_BUY_LIMIT";
    if (entry > ask) return "ORDER_TYPE_BUY_STOP";
    return null;
  }
  if (entry > bid) return "ORDER_TYPE_SELL_LIMIT";
  if (entry < bid) return "ORDER_TYPE_SELL_STOP";
  return null;
}

export function metaApiTradeBody(command: BrokerOrderCommand): Record<string, string | number> | null {
  if (!(PENDING_ACTION_TYPES as readonly string[]).includes(command.actionType)) return null;
  if (command.symbol !== "XAUUSD" || command.instrument !== "XAUUSD") return null;
  if (!/^[a-f0-9]{26}$/.test(command.clientId)) return null;
  if (!Number.isFinite(command.volume) || command.volume <= 0) return null;
  if (!Number.isFinite(command.openPrice) || command.openPrice <= 0) return null;
  if (!Number.isFinite(command.stopLoss) || command.stopLoss <= 0) return null;
  const body: Record<string, string | number> = {
    actionType: command.actionType,
    symbol: command.symbol,
    volume: command.volume,
    openPrice: command.openPrice,
    stopLoss: command.stopLoss,
    clientId: command.clientId,
  };
  if (command.takeProfit !== null) {
    if (!Number.isFinite(command.takeProfit) || command.takeProfit <= 0) return null;
    body.takeProfit = command.takeProfit;
  }
  return body;
}
