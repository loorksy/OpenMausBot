/** Phase 1 contracts, the Phase 2 market-data boundary, and the Phase 3
 * XAUUSD tool catalog. The catalog is mounted by the existing chat tool
 * loop when a turn carries an opt-in grant. This package does not submit orders. */

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
export {
  FORBIDDEN_EXECUTION_TOOL_NAMES,
  XAUUSD_TOOL_CATALOG_VERSION,
  createXauUsdToolSession,
  selectTradingModel,
} from "./agent/index.ts";
export type { XauUsdToolSession, XauUsdTurnGrant } from "./agent/index.ts";
