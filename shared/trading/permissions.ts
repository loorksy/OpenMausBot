/** Model-facing XAUUSD permissions. There is no execution permission. */
export const TRADING_PERMISSIONS = [
  "market.read",
  "account.read",
  "position.read",
  "decision.propose",
  "intent.propose",
  "specialist.consult",
] as const;

export type TradingPermission = (typeof TRADING_PERMISSIONS)[number];
