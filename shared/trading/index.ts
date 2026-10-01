/** XAUUSD trading contracts shared by later server phases and, eventually, the desk.
 * OpenMausBot's harness remains the agent runtime. These types do not start
 * turns, select tools, or submit orders. */

export {
  TRADING_ERROR_CODES,
  TradingDomainError,
  tradingError,
} from "./errors.ts";
export type { TradingErrorCode } from "./errors.ts";

export {
  TRADING_SCHEMA_VERSION,
  assertNoSecretFields,
  recordIdSchema,
  utcTimestampSchema,
} from "./ids.ts";
export type { AgentRunId, RecordId, UtcTimestamp } from "./ids.ts";

export {
  XAUUSD_INSTRUMENT,
  assertXauUsdBoundary,
  parseXauUsdInstrument,
  xauUsdInstrumentSchema,
} from "./instrument.ts";
export type { XauUsdInstrument } from "./instrument.ts";

export {
  PROVENANCE_STATUSES,
  TRADING_ENVIRONMENTS,
  assertCredentialSlot,
  assertProvenanceForEnvironment,
  continueInEnvironment,
  environmentBinding,
  parseEnvironmentBinding,
  parseProvenanceStatus,
  parseTradingEnvironment,
} from "./environment.ts";
export type { CredentialSlot, EnvironmentBinding, ProvenanceStatus, TradingEnvironment } from "./environment.ts";

export { requireAgentRun, reviseImmutable } from "./immutable.ts";
export type { ImmutableIdentity } from "./immutable.ts";

export { EVIDENCE_KINDS, parseEvidence } from "./evidence.ts";
export type { Evidence, EvidenceKind } from "./evidence.ts";

export { XAUUSD_TIMEFRAMES, parseMarketSnapshot } from "./snapshot.ts";
export type { MarketSnapshot, XauUsdCandle, XauUsdTimeframe } from "./snapshot.ts";

export { parseXauUsdContext } from "./context.ts";
export type { XauUsdContext } from "./context.ts";

export {
  DECISION_DIRECTIONS,
  DECISION_STATUSES,
  EVIDENCE_QUALITIES,
  parseDecision,
  transitionDecision,
} from "./decision.ts";
export type { Decision, DecisionDirection, DecisionStatus, EvidenceQuality } from "./decision.ts";

export { CHECK_STATUSES, parseRiskCheck } from "./risk.ts";
export type { CheckStatus, RiskCheck } from "./risk.ts";

export { parsePolicyCheck } from "./policy.ts";
export type { PolicyCheck } from "./policy.ts";

export {
  ORDER_INTENT_DIRECTIONS,
  orderIntentCannotExecute,
  orderIntentCannotSubmit,
  parseOrderIntent,
} from "./order-intent.ts";
export type { OrderIntent, OrderIntentDirection } from "./order-intent.ts";

export {
  TRADING_EVENT_SOURCE,
  TRADING_EVENT_TYPES,
  isTradingEvent,
  parseTradingEvent,
  tradingEventsAreNotRuntimeEvents,
} from "./events.ts";
export type { TradingEvent, TradingEventType } from "./events.ts";

export { assertReplayDataset, parseVersionManifest } from "./version-manifest.ts";
export type { VersionManifest } from "./version-manifest.ts";

export {
  RECONCILIATION_STATES,
  assertAutonomousOrdersAllowed,
  autonomousOrdersBlocked,
  parseReconciliationState,
} from "./reconciliation.ts";
export type { ReconciliationState } from "./reconciliation.ts";

export {
  AUTONOMY_LEVELS,
  AUTONOMY_NAMES,
  autonomyAllowsDirectSubmit,
  parseAutonomyState,
} from "./autonomy.ts";
export type { AutonomyLevel, AutonomyName, AutonomyState } from "./autonomy.ts";

export {
  assertSubmitNotBlockedByKnownSwitch,
  parseKillSwitchState,
  unknownKillSwitchBlocks,
} from "./kill-switch.ts";
export type { KillSwitchState } from "./kill-switch.ts";
