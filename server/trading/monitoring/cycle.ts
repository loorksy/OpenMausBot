import { AUTONOMY_NAMES, parseAutonomyState } from "../../../shared/trading/autonomy.ts";
import { parseDecision, type Decision, type DecisionDirection } from "../../../shared/trading/decision.ts";
import { assertProvenanceForEnvironment, type ProvenanceStatus } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import type { TradingEvent, TradingEventType } from "../../../shared/trading/events.ts";
import { assertNoSecretFields, recordIdSchema, seal, utcTimestampSchema } from "../../../shared/trading/ids.ts";
import { XAUUSD_INSTRUMENT } from "../../../shared/trading/instrument.ts";
import { parseOrderIntent, type OrderIntent } from "../../../shared/trading/order-intent.ts";
import type { TradingPermission } from "../../../shared/trading/permissions.ts";
import type { ReconciliationState } from "../../../shared/trading/reconciliation.ts";
import type { XauUsdRoutineMarker } from "../../../shared/trading/routine-marker.ts";
import { tradingFact } from "../audit.ts";
import { readAccountRiskState, readMarketRiskFacts, type MarketRiskFacts } from "../risk/account.ts";
import type { TradingOccurrence } from "../persistence/occurrences.ts";
import type { TradingStore } from "../persistence/store.ts";
import { assessXauUsdPolicy } from "../policy/assess.ts";
import type { PolicyDecision } from "../policy/result.ts";
import { evaluateXauUsdProposal, type ProposalEvaluation } from "../proposal/evaluate.ts";
import { contentHash } from "../replay/hash.ts";
import type { BrokerAccountSnapshot, BrokerPositionObservation } from "../reconciliation/snapshot.ts";

/**
 * One native routine turn's monitoring record.
 * Version `xauusd-monitoring-cycle-1`.
 *
 * The caller is RoutineManager's turn. This module does not schedule, poll,
 * or submit. An exit proposal stays non-executable. A close, when one is
 * authorized later, uses authorizeExit and POSITION_CLOSE_ID.
 */
export const MONITORING_CYCLE_VERSION = "xauusd-monitoring-cycle-1" as const;

const STALE_AFTER_MS = 60_000;

export const MONITORING_DECISIONS = [
  "NO_ACTION",
  "CONTINUE_MONITORING",
  "WAIT",
  "EXIT",
  "PAUSE",
  "BLOCKED",
  "REQUIRES_RECONCILIATION",
] as const;

export type MonitoringDecisionName = (typeof MONITORING_DECISIONS)[number];

export const MONITORING_SEMANTICS = [
  "WATCHING",
  "DATA_STALE",
  "POSITION_PRESENT",
  "NO_POSITION",
  "RISK_CHANGED",
  "EXIT_REQUIRED",
  "PAUSED",
  "BLOCKED",
  "RECONCILIATION_REQUIRED",
] as const;

export type MonitoringSemantic = (typeof MONITORING_SEMANTICS)[number];

export type BrokerHealth = "HEALTHY" | "DEGRADED" | "UNAVAILABLE" | "UNKNOWN";

export interface MonitoringExitProposal {
  readonly instrument: "XAUUSD";
  readonly positionId: string | null;
  readonly direction: "LONG" | "SHORT" | null;
  readonly positionQuantity: number | null;
  readonly proposedExitQuantity: number | null;
  readonly reason: string;
  readonly entry: number | null;
  readonly stop: number | null;
  readonly environment: TradingOccurrence["environment"];
  readonly provenance: ProvenanceStatus | null;
  readonly executable: false;
  readonly brokerSubmit: false;
}

export interface MonitoringCycleInput {
  readonly store: TradingStore;
  readonly occurrenceId: string;
  readonly marker: XauUsdRoutineMarker;
  readonly observedAt: string;
  readonly market: unknown;
  readonly account: unknown;
  readonly snapshot: BrokerAccountSnapshot | null;
  readonly killSwitch: unknown;
  readonly paused: boolean;
  readonly decision: MonitoringDecisionName;
  readonly exitReason?: string | null;
  readonly proposedExitQuantity?: number | null;
  readonly exitEntry?: number | null;
  readonly exitStop?: number | null;
  readonly riskConfig: unknown;
  readonly policyConfig: unknown;
}

export interface MonitoringCycle {
  readonly schemaVersion: typeof MONITORING_CYCLE_VERSION;
  readonly occurrenceId: string;
  readonly routineId: string;
  readonly routineRunId: string;
  readonly threadId: string;
  readonly providerTurnId: string;
  readonly agentRunId: string;
  readonly instrument: "XAUUSD";
  readonly environment: TradingOccurrence["environment"];
  readonly observedAt: string;
  readonly market: {
    readonly provenance: ProvenanceStatus;
    readonly source: string | null;
    readonly timestamp: string | null;
    readonly ageMs: number | null;
    readonly bid: number | null;
    readonly ask: number | null;
    readonly snapshotId: string | null;
  };
  readonly account: {
    readonly balance: number | null;
    readonly equity: number | null;
    readonly currency: string | null;
    readonly accountIdentity: string | null;
    readonly brokerHealth: BrokerHealth;
  };
  readonly position: {
    readonly state: "POSITION_PRESENT" | "NO_POSITION" | "AMBIGUOUS" | "UNKNOWN";
    readonly positionId: string | null;
    readonly direction: "LONG" | "SHORT" | null;
    readonly quantity: number | null;
    readonly entry: null;
  };
  readonly foreignSymbols: readonly string[];
  readonly reconciliationState: ReconciliationState | null;
  readonly executionState: TradingOccurrence["executionState"];
  readonly semantics: readonly MonitoringSemantic[];
  readonly decision: MonitoringDecisionName;
  readonly failureCodes: readonly string[];
  readonly exitProposal: MonitoringExitProposal | null;
  readonly proposal: ProposalEvaluation | null;
  readonly policy: PolicyDecision;
  readonly autonomousExecutionBlocked: boolean;
  readonly brokerCalled: false;
  readonly executionSubmitted: false;
  readonly retried: false;
  readonly modelContext: Readonly<Record<string, unknown>>;
  readonly events: readonly TradingEvent[];
}

const INPUT_KEYS = new Set([
  "store",
  "occurrenceId",
  "marker",
  "observedAt",
  "market",
  "account",
  "snapshot",
  "killSwitch",
  "paused",
  "decision",
  "exitReason",
  "proposedExitQuantity",
  "exitEntry",
  "exitStop",
  "riskConfig",
  "policyConfig",
]);

/** Observes one already-bound routine occurrence and records the result.
 * It does not create a routine, a turn, or a broker request. */
export function runMonitoringCycle(input: MonitoringCycleInput): MonitoringCycle {
  assertNoSecretFields(input, "monitoring cycle");
  rejectInput(input);
  if (!utcTimestampSchema.safeParse(input.observedAt).success || typeof input.paused !== "boolean") {
    throw new TradingDomainError("trading_store_rejected", "Monitoring cycle was rejected. Failing closed.");
  }
  if (!(MONITORING_DECISIONS as readonly string[]).includes(input.decision)) {
    throw new TradingDomainError("trading_store_rejected", "Monitoring decision was rejected. Failing closed.");
  }
  const occurrence = input.store.occurrences.readByOccurrenceId(input.occurrenceId);
  if (occurrence === null || occurrence.providerTurnId === null || occurrence.instrument !== XAUUSD_INSTRUMENT) {
    throw new TradingDomainError("trading_store_rejected", "Monitoring matched no bound occurrence. Failing closed.");
  }
  if (occurrence.environment !== input.marker.environment || occurrence.environment !== input.store.environment) {
    throw new TradingDomainError("environment_isolation", "Monitoring environment does not match the occurrence. Failing closed.");
  }
  const marketRead = readMarketRiskFacts(input.market, false);
  const market = marketView(marketRead.ok ? marketRead.market : null, input.observedAt);
  const accountRead = readAccountRiskState(input.account);
  const health = brokerHealth(input.snapshot, occurrence.environment);
  const positions = readPositions(input.snapshot, occurrence.environment);
  const reconciliationState = occurrence.reconciliationState;
  const kill = readStoredKill(input.store, occurrence.environment, occurrence.agentRunId);
  const blocks = new Set<string>();
  if (!market.usable) blocks.add(market.failure);
  if (market.provenance === "STALE" || market.agedOut) blocks.add("MARKET_DATA_STALE");
  if (market.provenance === "UNAVAILABLE") blocks.add("MARKET_DATA_UNAVAILABLE");
  if (market.provenance === "SIMULATOR" || market.provenance === "REPLAY") blocks.add("PROVENANCE_REJECTED");
  if (!accountRead.ok) blocks.add(accountRead.reason === "ACCOUNT_STATE_STALE" ? "ACCOUNT_STATE_STALE" : "ACCOUNT_STATE_UNAVAILABLE");
  if (health === "UNAVAILABLE") blocks.add("BROKER_UNAVAILABLE");
  if (health === "DEGRADED") blocks.add("BROKER_DEGRADED");
  if (health === "UNKNOWN") blocks.add("BROKER_UNKNOWN");
  if (positions.ambiguous) blocks.add("POSITION_IDENTITY_AMBIGUOUS");
  if (reconciliationState === null || reconciliationState === "UNKNOWN") blocks.add("RECONCILIATION_UNKNOWN");
  if (reconciliationState === "DESYNCED") blocks.add("RECONCILIATION_DESYNCED");
  if (reconciliationState === "DEGRADED") blocks.add("RECONCILIATION_DEGRADED");
  if (occurrence.executionState === "SUBMISSION_UNKNOWN") blocks.add("RECONCILIATION_UNKNOWN");
  if (kill === "unknown") blocks.add("KILL_SWITCH_UNKNOWN");
  if (kill === "engaged") blocks.add("KILL_SWITCH_ENGAGED");
  if (input.paused || input.decision === "PAUSE") blocks.add("PAUSED");
  if (input.decision === "BLOCKED") blocks.add("BLOCKED");
  if (input.decision === "REQUIRES_RECONCILIATION") blocks.add("RECONCILIATION_REQUIRED");
  const exitProposal = input.decision === "EXIT"
    ? exitFor(occurrence, positions, market.provenance, input)
    : null;
  if (exitProposal !== null && positions.position?.quantity != null && exitProposal.proposedExitQuantity != null && exitProposal.proposedExitQuantity > positions.position.quantity) {
    blocks.add("POSITION_QUANTITY_EXCEEDED");
  }
  const evaluated = evaluateProposal(input, occurrence, market.provenance, market.snapshotId);
  const proposal = evaluated.proposal;
  const policy = evaluated.policy;
  if (proposal.risk.state !== "ACCEPT") blocks.add("RISK_BLOCKED");
  if (policy.state !== "ALLOW") blocks.add("POLICY_BLOCKED");
  if (input.decision === "EXIT") {
    const quantityMatches = exitProposal?.proposedExitQuantity != null
      && positions.position?.quantity != null
      && exitProposal.proposedExitQuantity === positions.position.quantity;
    const representable = exitProposal?.positionId != null && quantityMatches && !positions.ambiguous;
    blocks.add(representable ? "EXIT_AUTHORIZATION_REQUIRED" : "EXIT_CLOSE_NOT_REPRESENTABLE");
  }
  const failureCodes = [...blocks].sort();
  const semantics = semanticsFor(input, market, positions, reconciliationState, proposal.risk.state !== "ACCEPT", failureCodes);
  const events = eventsFor(input, occurrence, market, health, positions, kill, failureCodes, semantics);
  const cycle: MonitoringCycle = seal({
    schemaVersion: MONITORING_CYCLE_VERSION,
    occurrenceId: occurrence.occurrenceId,
    routineId: occurrence.routineId,
    routineRunId: occurrence.routineRunId,
    threadId: occurrence.threadId,
    providerTurnId: occurrence.providerTurnId,
    agentRunId: occurrence.agentRunId,
    instrument: XAUUSD_INSTRUMENT,
    environment: occurrence.environment,
    observedAt: input.observedAt,
    market: {
      provenance: market.provenance,
      source: marketRead.ok ? "caller-observation" : null,
      timestamp: market.timestamp,
      ageMs: market.ageMs,
      bid: market.bid,
      ask: market.ask,
      snapshotId: market.snapshotId,
    },
    account: {
      balance: input.snapshot?.account.balance ?? null,
      equity: accountRead.ok ? accountRead.account.equity : null,
      currency: input.snapshot?.account.currency ?? (accountRead.ok ? accountRead.account.currency : null),
      accountIdentity: input.snapshot?.bindingId ?? null,
      brokerHealth: health,
    },
    position: {
      state: positions.state,
      positionId: positions.position?.positionId ?? null,
      direction: positions.position?.direction ?? null,
      quantity: positions.position?.quantity ?? null,
      entry: null,
    },
    foreignSymbols: positions.foreignSymbols,
    reconciliationState,
    executionState: occurrence.executionState,
    semantics,
    decision: input.decision,
    failureCodes,
    exitProposal,
    proposal,
    policy,
    autonomousExecutionBlocked: failureCodes.length > 0,
    brokerCalled: false,
    executionSubmitted: false,
    retried: false,
    modelContext: modelContext(input.marker.permissions, market, accountRead.ok ? accountRead.account.equity : null, health, positions, reconciliationState, input.decision),
    events,
  });
  assertNoSecretFields(cycle, "monitoring cycle");
  input.store.monitoringCycles.record(cycle, events);
  return cycle;
}

function rejectInput(input: MonitoringCycleInput): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TradingDomainError("trading_store_rejected", "Monitoring cycle was rejected. Failing closed.");
  }
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.has(key)) {
      throw new TradingDomainError("trading_store_rejected", "Monitoring cycle contains an unsupported field. Failing closed.");
    }
  }
}

function marketView(market: MarketRiskFacts | null, observedAt: string): {
  usable: boolean;
  failure: string;
  provenance: ProvenanceStatus;
  timestamp: string | null;
  ageMs: number | null;
  agedOut: boolean;
  bid: number | null;
  ask: number | null;
  snapshotId: string | null;
} {
  if (market === null) {
    return {
      usable: false,
      failure: "MARKET_DATA_UNAVAILABLE",
      provenance: "UNAVAILABLE",
      timestamp: null,
      ageMs: null,
      agedOut: false,
      bid: null,
      ask: null,
      snapshotId: null,
    };
  }
  const ageMs = ageBetween(market.providerTimestamp, observedAt);
  const agedOut = ageMs === null || ageMs > STALE_AFTER_MS;
  const unusable = market.provenance === "UNAVAILABLE" || market.freshness === "unavailable" || market.freshness === "invalid" || market.freshness === "future_dated";
  return {
    usable: !unusable,
    failure: unusable ? "MARKET_DATA_UNAVAILABLE" : "MARKET_DATA_STALE",
    provenance: market.provenance,
    timestamp: market.providerTimestamp,
    ageMs,
    agedOut,
    bid: market.bid,
    ask: market.ask,
    snapshotId: market.snapshotId,
  };
}

function ageBetween(earlier: string, later: string): number | null {
  const start = Date.parse(earlier);
  const end = Date.parse(later);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function brokerHealth(snapshot: BrokerAccountSnapshot | null, environment: TradingOccurrence["environment"]): BrokerHealth {
  if (snapshot === null) return "UNKNOWN";
  if (snapshot.environment !== environment) return "UNKNOWN";
  if (snapshot.unavailable || snapshot.brokerCallSkipped) return "UNAVAILABLE";
  if (snapshot.invalid) return "UNKNOWN";
  if (!snapshot.complete) return "DEGRADED";
  return "HEALTHY";
}

function readPositions(snapshot: BrokerAccountSnapshot | null, environment: TradingOccurrence["environment"]): {
  state: "POSITION_PRESENT" | "NO_POSITION" | "AMBIGUOUS" | "UNKNOWN";
  position: { positionId: string; direction: "LONG" | "SHORT"; quantity: number } | null;
  foreignSymbols: readonly string[];
  ambiguous: boolean;
} {
  if (snapshot === null || snapshot.environment !== environment || snapshot.channels.positions !== "read") {
    return { state: "UNKNOWN", position: null, foreignSymbols: [], ambiguous: false };
  }
  const foreign = [...new Set(snapshot.positions.filter((item) => item.symbol !== XAUUSD_INSTRUMENT).map((item) => item.symbol))].sort();
  const own = snapshot.positions.filter((item) => item.symbol === XAUUSD_INSTRUMENT);
  if (own.length > 1 || own.some((item) => !usablePosition(item))) {
    return { state: "AMBIGUOUS", position: null, foreignSymbols: foreign, ambiguous: true };
  }
  const one = own[0];
  if (one === undefined) return { state: "NO_POSITION", position: null, foreignSymbols: foreign, ambiguous: false };
  return {
    state: "POSITION_PRESENT",
    position: { positionId: one.positionId, direction: one.direction as "LONG" | "SHORT", quantity: one.volume },
    foreignSymbols: foreign,
    ambiguous: false,
  };
}

function usablePosition(position: BrokerPositionObservation): boolean {
  return position.positionId.trim().length > 0
    && (position.direction === "LONG" || position.direction === "SHORT")
    && Number.isFinite(position.volume)
    && position.volume > 0;
}

function readStoredKill(
  store: MonitoringCycleInput["store"],
  environment: TradingOccurrence["environment"],
  agentRunId: string,
): "open" | "engaged" | "unknown" {
  if (store.environment !== environment) return "unknown";
  const read = store.killSwitches.read(agentRunId);
  return read.status === "open" || read.status === "engaged" ? read.status : "unknown";
}

function exitFor(
  occurrence: TradingOccurrence,
  positions: ReturnType<typeof readPositions>,
  provenance: ProvenanceStatus | null,
  input: MonitoringCycleInput,
): MonitoringExitProposal {
  const reason = typeof input.exitReason === "string" && input.exitReason.trim().length > 0
    ? input.exitReason.trim().slice(0, 500)
    : "exit proposed";
  return {
    instrument: "XAUUSD",
    positionId: positions.position?.positionId ?? null,
    direction: positions.position?.direction ?? null,
    positionQuantity: positions.position?.quantity ?? null,
    proposedExitQuantity: typeof input.proposedExitQuantity === "number" && Number.isFinite(input.proposedExitQuantity)
      ? input.proposedExitQuantity
      : null,
    reason,
    entry: typeof input.exitEntry === "number" && input.exitEntry > 0 ? input.exitEntry : null,
    stop: typeof input.exitStop === "number" && input.exitStop > 0 ? input.exitStop : null,
    environment: occurrence.environment,
    provenance,
    executable: false,
    brokerSubmit: false,
  };
}

function evaluateProposal(
  input: MonitoringCycleInput,
  occurrence: TradingOccurrence,
  provenance: ProvenanceStatus,
  snapshotId: string | null,
): { proposal: ProposalEvaluation; policy: PolicyDecision } {
  const direction = decisionDirection(input.decision);
  const decision = monitoringDecision(occurrence, input.observedAt, direction, provenance, snapshotId);
  const intent = direction === "EXIT_EXISTING_POSITION"
    ? monitoringIntent(occurrence, decision, input)
    : null;
  let proposal: ProposalEvaluation;
  try {
    if (provenance !== "UNAVAILABLE") assertProvenanceForEnvironment(occurrence.environment, provenance);
    proposal = evaluateXauUsdProposal(proposalInput(input, occurrence, decision, intent, provenance));
  } catch {
    proposal = evaluateXauUsdProposal(proposalInput(input, occurrence, decision, null, "UNAVAILABLE"));
  }
  if (proposal.policy !== null) return { proposal, policy: proposal.policy };
  return {
    proposal,
    policy: assessXauUsdPolicy({
      instrument: XAUUSD_INSTRUMENT,
      decision,
      orderIntent: intent,
      risk: proposal.risk,
      environment: occurrence.environment,
      provenance,
      marketFreshness: proposal.risk.trace.marketFreshness ?? "unavailable",
      autonomy: parseAutonomyState({
        schemaVersion: 1,
        environment: occurrence.environment,
        level: input.marker.autonomyLevel,
        name: AUTONOMY_NAMES[input.marker.autonomyLevel],
        agentRunId: occurrence.agentRunId,
        updatedAt: input.observedAt,
      }),
      permissions: input.marker.permissions,
      approval: "absent",
      killSwitch: input.killSwitch,
      config: input.policyConfig,
      assessedAt: input.observedAt,
      agentRunId: occurrence.agentRunId,
      runtimeThreadId: occurrence.threadId,
      runtimeTurnId: occurrence.providerTurnId,
    }),
  };
}

function decisionDirection(decision: MonitoringDecisionName): DecisionDirection {
  if (decision === "WAIT" || decision === "CONTINUE_MONITORING") return "WAIT";
  if (decision === "EXIT") return "EXIT_EXISTING_POSITION";
  return "NO_TRADE";
}

function monitoringDecision(
  occurrence: TradingOccurrence,
  observedAt: string,
  direction: DecisionDirection,
  provenance: ProvenanceStatus,
  snapshotId: string | null,
): Decision {
  const id = `dec.${contentHash({
    schema: MONITORING_CYCLE_VERSION,
    occurrenceId: occurrence.occurrenceId,
    observedAt,
    direction,
    role: "decision",
  }).slice(0, 40)}`;
  const boundSnapshot = snapshotId !== null && recordIdSchema.safeParse(snapshotId).success
    ? snapshotId
    : `mon.${contentHash({ schema: MONITORING_CYCLE_VERSION, occurrenceId: occurrence.occurrenceId, observedAt, provenance, role: "missing-snapshot" }).slice(0, 40)}`;
  return parseDecision({
    schemaVersion: 1,
    id,
    agentRunId: occurrence.agentRunId,
    environment: occurrence.environment,
    instrument: "XAUUSD",
    createdAt: observedAt,
    status: "DRAFT",
    thesis: "Monitoring observation for the current XAUUSD routine turn.",
    contextId: occurrence.occurrenceId,
    snapshotId: boundSnapshot,
    evidenceIds: [],
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingInformation: ["monitoring does not invent missing broker facts"],
    direction,
    targets: [],
    expiry: observedAt,
    evidenceQuality: "insufficient",
    versionManifestId: "monitoring-cycle",
  });
}

function monitoringIntent(
  occurrence: TradingOccurrence,
  decision: Decision,
  input: MonitoringCycleInput,
): OrderIntent | null {
  if (typeof input.exitEntry !== "number" || typeof input.exitStop !== "number") return null;
  const id = `int.${contentHash({
    schema: MONITORING_CYCLE_VERSION,
    occurrenceId: occurrence.occurrenceId,
    decisionId: decision.id,
    role: "exit-intent",
  }).slice(0, 40)}`;
  return parseOrderIntent({
    schemaVersion: 1,
    kind: "order-intent",
    id,
    agentRunId: occurrence.agentRunId,
    environment: occurrence.environment,
    instrument: "XAUUSD",
    decisionId: decision.id,
    createdAt: input.observedAt,
    direction: "EXIT_EXISTING_POSITION",
    executable: false,
    brokerSubmit: false,
    entry: input.exitEntry,
    stop: input.exitStop,
    targets: [],
  });
}

function proposalInput(
  input: MonitoringCycleInput,
  occurrence: TradingOccurrence,
  decision: Decision,
  intent: OrderIntent | null,
  provenance: ProvenanceStatus,
) {
  return {
    instrument: XAUUSD_INSTRUMENT,
    decision,
    orderIntent: intent,
    market: input.market,
    account: input.account,
    riskConfig: input.riskConfig,
    policyConfig: input.policyConfig,
    environment: occurrence.environment,
    provenance,
    assessedAt: input.observedAt,
    agentRunId: occurrence.agentRunId,
    runtimeThreadId: occurrence.threadId,
    runtimeTurnId: occurrence.providerTurnId,
    requestedQuantity: input.proposedExitQuantity ?? null,
    autonomy: parseAutonomyState({
      schemaVersion: 1,
      environment: occurrence.environment,
      level: input.marker.autonomyLevel,
      name: AUTONOMY_NAMES[input.marker.autonomyLevel],
      agentRunId: occurrence.agentRunId,
      updatedAt: input.observedAt,
    }),
    permissions: input.marker.permissions,
    approval: "absent",
    killSwitch: input.killSwitch,
  };
}

function semanticsFor(
  input: MonitoringCycleInput,
  market: ReturnType<typeof marketView>,
  positions: ReturnType<typeof readPositions>,
  reconciliationState: ReconciliationState | null,
  riskChanged: boolean,
  failureCodes: readonly string[],
): readonly MonitoringSemantic[] {
  const semantics = new Set<MonitoringSemantic>(["WATCHING"]);
  if (market.provenance === "STALE" || market.agedOut) semantics.add("DATA_STALE");
  if (positions.state === "POSITION_PRESENT") semantics.add("POSITION_PRESENT");
  if (positions.state === "NO_POSITION") semantics.add("NO_POSITION");
  if (riskChanged) semantics.add("RISK_CHANGED");
  if (input.decision === "EXIT") semantics.add("EXIT_REQUIRED");
  if (input.paused || input.decision === "PAUSE") semantics.add("PAUSED");
  if (failureCodes.length > 0) semantics.add("BLOCKED");
  if (
    reconciliationState === null
    || reconciliationState === "UNKNOWN"
    || reconciliationState === "DESYNCED"
    || positions.ambiguous
    || input.decision === "REQUIRES_RECONCILIATION"
  ) semantics.add("RECONCILIATION_REQUIRED");
  return [...semantics];
}

function eventsFor(
  input: MonitoringCycleInput,
  occurrence: TradingOccurrence,
  market: ReturnType<typeof marketView>,
  health: BrokerHealth,
  positions: ReturnType<typeof readPositions>,
  kill: "open" | "engaged" | "unknown",
  failureCodes: readonly string[],
  semantics: readonly MonitoringSemantic[],
): readonly TradingEvent[] {
  const correlation = {
    occurrenceId: occurrence.occurrenceId,
    routineId: occurrence.routineId,
    routineRunId: occurrence.routineRunId,
    threadId: occurrence.threadId,
    providerTurnId: occurrence.providerTurnId,
    executionRequestId: occurrence.executionRequestId,
  };
  const rows: Array<{ type: TradingEventType; nextState: string }> = [
    { type: "monitoring.started", nextState: "WATCHING" },
  ];
  if (market.provenance === "UNAVAILABLE") rows.push({ type: "market.unavailable", nextState: "UNAVAILABLE" });
  else if (market.provenance === "STALE" || market.agedOut) rows.push({ type: "market.stale", nextState: "STALE" });
  else rows.push({ type: "market.updated", nextState: market.provenance });
  rows.push({ type: "account.observed", nextState: health });
  rows.push({ type: "position.observed", nextState: positions.state });
  rows.push({ type: "decision.created", nextState: input.decision });
  if (kill === "engaged") rows.push({ type: "emergency.stop", nextState: "ENGAGED" });
  rows.push({
    type: failureCodes.length > 0 ? "monitoring.blocked" : "monitoring.completed",
    nextState: semantics.includes("EXIT_REQUIRED") ? "EXIT_REQUIRED" : semantics.includes("PAUSED") ? "PAUSED" : "WATCHING",
  });
  return rows.flatMap((row) => {
    const event = tradingFact({
      type: row.type,
      eventId: eventId(occurrence.occurrenceId, row.type, input.observedAt, input.decision),
      at: input.observedAt,
      agentRunId: occurrence.agentRunId,
      correlationId: occurrence.occurrenceId,
      environment: occurrence.environment,
      actor: "xauusd-monitoring",
      nextState: row.nextState,
      runtimeThreadId: occurrence.threadId,
      runtimeTurnId: occurrence.providerTurnId,
      payload: { ...correlation, decision: input.decision, failureCodes, brokerCalled: false, retried: false },
    });
    return event === null ? [] : [event];
  });
}

function eventId(occurrenceId: string, type: string, observedAt: string, decision: string): string {
  return `mon.${contentHash({
    schema: MONITORING_CYCLE_VERSION,
    occurrenceId,
    type,
    observedAt,
    decision,
  }).slice(0, 40)}`;
}

function modelContext(
  permissions: readonly TradingPermission[],
  market: ReturnType<typeof marketView>,
  equity: number | null,
  health: BrokerHealth,
  positions: ReturnType<typeof readPositions>,
  reconciliationState: ReconciliationState | null,
  decision: MonitoringDecisionName,
): Readonly<Record<string, unknown>> {
  const allowed = new Set(permissions);
  return {
    instrument: "XAUUSD",
    decision,
    market: allowed.has("market.read")
      ? { provenance: market.provenance, timestamp: market.timestamp, ageMs: market.ageMs, bid: market.bid, ask: market.ask }
      : { provenance: "UNAVAILABLE" },
    account: allowed.has("account.read") ? { equity, brokerHealth: health, reconciliationState } : null,
    position: allowed.has("position.read")
      ? {
        state: positions.state,
        positionId: positions.position?.positionId ?? null,
        direction: positions.position?.direction ?? null,
        quantity: positions.position?.quantity ?? null,
        foreignSymbols: positions.foreignSymbols,
      }
      : null,
  };
}
