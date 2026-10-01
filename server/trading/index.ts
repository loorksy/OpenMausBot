/** Phase 1 contracts, the Phase 2 market-data boundary, the Phase 3 XAUUSD
 * tool catalog, the Phase 4 replay clock, and the Phase 5 evaluation
 * foundation. The catalog is mounted by the existing chat tool loop when a
 * turn carries an opt-in grant. Replay changes market time and market data
 * only. Evaluation records that same tool session. This package does not
 * submit orders. */

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
export {
  REPLAY_CLOCK_VERSION,
  REPLAY_CONFIG_VERSION,
  REPLAY_ORDERING_RULE,
  bindReplayGrant,
  createReplayClock,
  createReplayDataset,
  createReplaySession,
} from "./replay/index.ts";
export type { MarketObservation, ReplayDataset, ReplaySession } from "./replay/index.ts";
export {
  EVALUATION_RULES_VERSION,
  assessRecordedCalls,
  compareEvaluationRuns,
  createEvaluationArchive,
  createEvaluationConfiguration,
  createEvaluationRun,
  executeEvaluationRun,
} from "./evaluation/index.ts";
export type {
  EvaluationConfiguration,
  EvaluationPlayer,
  EvaluationResult,
  EvaluationRun,
  EvaluationStatus,
} from "./evaluation/index.ts";
