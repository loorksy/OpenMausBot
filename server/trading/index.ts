/** Phase 1 contracts and the Phase 2 XAUUSD market-data boundary.
 * Not wired into the harness HTTP server. This package does not submit orders. */

export * from "./domain/index.ts";
export { foundationControl } from "./control/boundaries.ts";
export {
  TRADING_STORE_SCHEMA_VERSION,
  applyTradingMigrations,
  openTradingStore,
  tradingPartitionKey,
} from "./persistence/store.ts";
export {
  MarketDataProviderError,
  PROVIDER_FAILURE_KINDS,
  TIMEFRAME_MS,
  assessClock,
  buildXauUsdMarketContext,
  canonicalizeUtc,
  createDeterministicXauUsdProvider,
  createXauUsdMarketSnapshot,
  failureProvenance,
  normalizeTimeframe,
  readXauUsdCandles,
  readXauUsdQuote,
  redactMarketText,
} from "./infrastructure/market_data/index.ts";
export type {
  MarketClock,
  MarketClockLimits,
  MarketDataResult,
  MarketRequest,
  XauUsdCandleSeries,
  XauUsdMarketDataProvider,
  XauUsdQuote,
} from "./infrastructure/market_data/index.ts";
