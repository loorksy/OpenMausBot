/** Phase 1 contracts, the Phase 2 market-data boundary, the Phase 3 XAUUSD
 * tool catalog, the Phase 4 replay clock, the Phase 5 evaluation foundation,
 * the Phase 6 risk and policy engines, and the Phase 7 approval engine and
 * fire-time gate. The catalog is mounted by the existing chat tool loop when
 * a turn carries an opt-in grant. Replay changes market time and market data
 * only. Evaluation records that same tool session. Nothing here submits an
 * order. */

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
export {
  assessXauUsdRisk,
  parseRiskConfig,
  RISK_ENGINE_VERSION,
  XAUUSD_CONTRACT_VERSION,
  XAUUSD_OUNCES_PER_LOT,
  riskInfrastructureFact,
} from "./risk/index.ts";
export type { AccountRiskState, RiskConfig, RiskDecision, RiskState } from "./risk/index.ts";
export {
  assessXauUsdPolicy,
  parsePolicyConfig,
  POLICY_ENGINE_VERSION,
  policyInfrastructureFact,
} from "./policy/index.ts";
export type { PolicyConfig, PolicyDecision, PolicyState } from "./policy/index.ts";
export { evaluateXauUsdProposal, PROPOSAL_ENGINE_VERSION } from "./proposal/index.ts";
export type { ProposalEvaluation, ProposalOutcome } from "./proposal/index.ts";
export {
  assessApproval,
  parseApprovalConfig,
  APPROVAL_ENGINE_VERSION,
  approvalInfrastructureFact,
  proposalBinding,
} from "./approval/index.ts";
export type { ApprovalConfig, ApprovalDecision, ApprovalState } from "./approval/index.ts";
export {
  evaluateFireTimeGate,
  parseGateConfig,
  GATE_ENGINE_VERSION,
  gateInfrastructureFact,
} from "./gate/index.ts";
export type { GateConfig, GateDecision, GateState } from "./gate/index.ts";
