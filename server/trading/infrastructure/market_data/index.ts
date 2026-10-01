/** XAUUSD market-data boundary. No orders, sizing, or broker calls. */

export {
  MarketDataProviderError,
  PROVIDER_FAILURE_KINDS,
  failureProvenance,
  redactMarketText,
} from "./model.ts";
export type {
  MarketClock,
  MarketClockLimits,
  MarketDataFailure,
  MarketDataResult,
  MarketDataSuccess,
  MarketRequest,
  ProviderFailureKind,
  RawProviderResult,
  XauUsdCandleSeries,
  XauUsdQuote,
} from "./model.ts";

export { TIMEFRAME_MS, normalizeTimeframe } from "./timeframe.ts";
export { assessClock, canonicalizeUtc } from "./clock.ts";
export { createDeterministicXauUsdProvider } from "./provider.ts";
export type { CandleRange, DeterministicXauUsdProvider, XauUsdMarketDataProvider } from "./provider.ts";
export { readXauUsdCandles, readXauUsdQuote } from "./read.ts";
export { buildXauUsdMarketContext, createXauUsdMarketSnapshot } from "./snapshot.ts";
