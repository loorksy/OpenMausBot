/** Phase 1 contracts, the Phase 2 market-data boundary, the Phase 3 XAUUSD
 * tool catalog, the Phase 4 replay clock, the Phase 5 evaluation foundation,
 * the Phase 6 risk and policy engines, the Phase 7 approval engine and
 * fire-time gate, the Phase 8 MetaApi execution boundary, and the Phase 9
 * trading ledger and reconciliation. The catalog is mounted by the existing
 * chat tool loop when a turn carries an opt-in grant. Replay changes market
 * time and market data only. Evaluation records that same tool session. The
 * model has no execution tool. Phase 10.3 step 4 sequences the existing
 * risk, policy, approval, proposal-binding, and fire-time gate engines.
 * A broker submit happens only through the execution boundary after
 * ELIGIBLE_FOR_EXECUTION. Reconciliation reads a broker snapshot and does
 * not submit. Phase 10.3 step 6 records that submission result and the
 * reconciliation run on the same trading occurrence. Phase 10.4 records
 * one monitoring cycle for that native routine turn. It does not schedule
 * and it does not submit. */

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
export { evaluateExecutionEligibility, ELIGIBILITY_HANDOFF_VERSION, submitEligibleExecution, EXECUTION_HANDOFF_VERSION } from "./eligibility/index.ts";
export { executionReceiptFor, OCCURRENCE_LIFECYCLE_VERSION, reconcileOccurrenceLifecycle } from "./occurrence/lifecycle.ts";
export { MONITORING_CYCLE_VERSION, runMonitoringCycle } from "./monitoring/cycle.ts";
export type { EligibilityHandoff, EligibilityHandoffInput, EligibleExecutionResult } from "./eligibility/index.ts";
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
export {
  EXECUTION_ENGINE_VERSION,
  createMemoryExecutionLedger,
  createMetaApiExecutionAdapter,
  executionInfrastructureFact,
  parseMetaApiAccountBinding,
  submitAuthorizedExecution,
  translateMetaApiTradeResponse,
} from "./execution/index.ts";
export type {
  ExecutionAttemptRecord,
  ExecutionDecision,
  ExecutionState,
  MetaApiAccountBinding,
  XauUsdExecutionProvider,
} from "./execution/index.ts";
export {
  RECONCILIATION_CONFIG_VERSION,
  RECONCILIATION_ENGINE_VERSION,
  buildBrokerSnapshot,
  captureBrokerSnapshot,
  createMetaApiReconciliationAdapter,
  reconcileExecution,
} from "./reconciliation/index.ts";
export type {
  BrokerAccountSnapshot,
  MetaApiReconciliationReader,
  ReconciliationResult,
} from "./reconciliation/index.ts";
export {
  XAUUSD_JOB_DEFAULT_INTERVAL_MINUTES,
  XAUUSD_JOB_MAX_DURATION_MS,
  XAUUSD_JOB_VERSION,
  authorizeJobExecution,
  cancelJob,
  dispatchDueJobs,
  holdForApproval,
  interpretMonitoringRequest,
  noteReconciliation,
  pauseJob,
  rememberJob,
} from "./jobs/index.ts";
export type { XauUsdJob, XauUsdJobStatus, XauUsdTurnRequest } from "./jobs/index.ts";
