import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";

/** No trading database is opened or migrated in this phase. Schema version 0
 * means the store has not been created. Partition keys keep SIMULATOR, PAPER,
 * and LIVE from sharing a namespace. */

export const TRADING_STORE_SCHEMA_VERSION = 0 as const;

export function tradingPartitionKey(environment: TradingEnvironment): `xauusd/${TradingEnvironment}` {
  return `xauusd/${environment}`;
}

export function applyTradingMigrations(): never {
  throw new TradingDomainError(
    "trading_store_not_implemented",
    "Trading database migrations are not implemented. Failing closed.",
  );
}

export function openTradingStore(): never {
  throw new TradingDomainError(
    "trading_store_not_implemented",
    "The trading store is not implemented. Failing closed.",
  );
}
