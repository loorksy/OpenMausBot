import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import type { TradingEvent, TradingEventType } from "../../../shared/trading/events.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { assertNoSecretFields, recordIdSchema, seal, utcTimestampSchema } from "../../../shared/trading/ids.ts";
import { parseKillSwitchState } from "../../../shared/trading/kill-switch.ts";
import type { ReconciliationState } from "../../../shared/trading/reconciliation.ts";
import { tradingFact } from "../audit.ts";
import type { ExecutionAttemptRecord } from "../execution/ledger.ts";
import { executionAttemptKey } from "../execution/identity.ts";
import type { ExecutionState } from "../execution/result.ts";
import type { PersistedExecutionRequest } from "../persistence/record.ts";
import { contentHash } from "../replay/hash.ts";
import { scale } from "../risk/math.ts";
import type {
  BrokerAccountSnapshot,
  BrokerDealObservation,
  BrokerOrderObservation,
} from "./snapshot.ts";

/** Pure comparison of one internal execution against one broker snapshot.
 * It does not call MetaApi, submit an order, or rewrite the ledger. */
export const RECONCILIATION_ENGINE_VERSION = "xauusd-reconciliation-1" as const;

export const RECONCILIATION_CONFIG_VERSION = "xauusd-reconciliation-config-1" as const;

export const RECONCILIATION_FINDING_CODES = [
  "ORDER_MATCHED",
  "UNKNOWN_RESOLVED_ORDER_FOUND",
  "BROKER_ORDER_NOT_FOUND",
  "ORDER_MISSING",
  "SYMBOL_MISMATCH",
  "QUANTITY_MISMATCH",
  "DIRECTION_MISMATCH",
  "STOP_MISMATCH",
  "TARGET_MISMATCH",
  "PARTIAL_FILL",
  "FILL_MATCHED",
  "OVERFILL",
  "FILL_NOT_FOUND",
  "FILL_VOLUME_MISMATCH",
  "BROKER_UNAVAILABLE",
  "SNAPSHOT_INCOMPLETE",
  "ACCOUNT_MISMATCH",
  "ENVIRONMENT_MISMATCH",
  "PROVIDER_MISMATCH",
  "ACCOUNT_IDENTITY_MISSING",
  "FOREIGN_SYMBOL_OBSERVED",
  "POSITION_UNCORRELATED",
  "DEAL_OBSERVED",
  "AMBIGUOUS_CORRELATION",
  "BROKER_DATA_INVALID",
  "NON_EXECUTABLE_ENVIRONMENT",
  "NO_ATTEMPT",
  "INTERNAL_RECORD_MISMATCH",
  "ATTEMPT_SEQUENCE_AMBIGUOUS",
  "REJECTION_CONTRADICTED",
  "REJECTION_CONSISTENT",
  "NOT_SUBMITTED_CONSISTENT",
  "NOT_SUBMITTED_CONTRADICTED",
] as const;

export type ReconciliationFindingCode = (typeof RECONCILIATION_FINDING_CODES)[number];

export type ReconciliationResolution = "UNKNOWN_TO_BROKER_ORDER_FOUND";

export interface ReconciliationFinding {
  readonly code: ReconciliationFindingCode;
  readonly orderId: string | null;
  readonly dealId: string | null;
  readonly positionId: string | null;
  readonly symbol: string | null;
  readonly brokerVolume: number | null;
}

export interface ReconciliationResult {
  readonly schemaVersion: typeof RECONCILIATION_ENGINE_VERSION;
  readonly configVersion: typeof RECONCILIATION_CONFIG_VERSION;
  readonly reconciliationRunId: string;
  readonly state: ReconciliationState;
  readonly resolution: ReconciliationResolution | null;
  readonly findings: readonly ReconciliationFinding[];
  readonly snapshotId: string;
  readonly executionRequestId: string;
  readonly executionAttemptId: string | null;
  readonly executionIdentity: string;
  readonly internalState: ExecutionState | null;
  readonly agentRunId: string;
  readonly executionAgentRunId: string;
  readonly accountBindingId: string;
  readonly environment: TradingEnvironment;
  readonly provider: "metaapi-cloud";
  readonly reconciledAt: string;
  readonly repairAttempted: false;
  readonly retried: false;
  readonly killSwitchEngaged: boolean | null;
  readonly events: readonly TradingEvent[];
}

export interface ReconcileInput {
  readonly request: PersistedExecutionRequest;
  readonly attempts: readonly ExecutionAttemptRecord[];
  readonly snapshot: BrokerAccountSnapshot;
  readonly killSwitch?: unknown;
  readonly reconciledAt: string;
  readonly agentRunId: string;
}

interface Verdict {
  readonly state: ReconciliationState;
  readonly resolution: ReconciliationResolution | null;
  readonly findings: readonly ReconciliationFinding[];
}

/** Deterministic given the same request, attempts, snapshot, config, and
 * caller-supplied reconciledAt. reconciledAt distinguishes a later audit run.
 * It is not used to decide whether the facts agree. */
export function reconcileExecution(input: ReconcileInput): ReconciliationResult {
  assertNoSecretFields(input, "reconciliation input");
  if (!utcTimestampSchema.safeParse(input.reconciledAt).success || !recordIdSchema.safeParse(input.agentRunId).success) {
    throw new TradingDomainError("trading_store_rejected", "Reconciliation input was rejected. Failing closed.");
  }
  const verdict = compare(input.request, input.attempts, input.snapshot);
  const latest = selectLatest(input.attempts);
  const attempt = latest.kind === "one" ? latest.attempt : null;
  const runId = reconciliationRunId(input, attempt);
  const events = eventsFor(input, verdict, attempt, runId);
  return seal({
    schemaVersion: RECONCILIATION_ENGINE_VERSION,
    configVersion: RECONCILIATION_CONFIG_VERSION,
    reconciliationRunId: runId,
    state: verdict.state,
    resolution: verdict.resolution,
    findings: verdict.findings,
    snapshotId: input.snapshot.snapshotId,
    executionRequestId: input.request.executionRequestId,
    executionAttemptId: attempt?.executionAttemptId ?? null,
    executionIdentity: input.request.executionIdentity,
    internalState: attempt?.state ?? null,
    agentRunId: input.agentRunId,
    executionAgentRunId: input.request.agentRunId,
    accountBindingId: input.request.bindingId,
    environment: input.request.environment,
    provider: "metaapi-cloud",
    reconciledAt: input.reconciledAt,
    repairAttempted: false,
    retried: false,
    killSwitchEngaged: readKillSwitch(input.killSwitch, input.request.environment, input.request.agentRunId),
    events,
  });
}

function reconciliationRunId(input: ReconcileInput, attempt: ExecutionAttemptRecord | null): string {
  return `rec.${contentHash({
    schema: RECONCILIATION_ENGINE_VERSION,
    config: RECONCILIATION_CONFIG_VERSION,
    executionIdentity: input.request.executionIdentity,
    executionAttemptId: attempt?.executionAttemptId ?? null,
    internalState: attempt?.state ?? null,
    sequence: attempt?.sequence ?? null,
    snapshotId: input.snapshot.snapshotId,
    reconciledAt: input.reconciledAt,
  }).slice(0, 40)}`;
}

function compare(
  request: PersistedExecutionRequest,
  attempts: readonly ExecutionAttemptRecord[],
  snapshot: BrokerAccountSnapshot,
): Verdict {
  if (attempts.length === 0) return verdict("UNKNOWN", null, [finding("NO_ATTEMPT")]);
  const selected = selectLatest(attempts);
  if (selected.kind === "ambiguous") return verdict("UNKNOWN", null, [finding("ATTEMPT_SEQUENCE_AMBIGUOUS")]);
  const latest = selected.attempt;
  if (request.environment === "SIMULATOR" || request.provenance !== "LIVE") {
    return verdict("UNKNOWN", null, [finding("NON_EXECUTABLE_ENVIRONMENT")]);
  }
  if (request.clientId.length === 0 || attempts.some((item) => item.clientId !== request.clientId)) {
    return verdict("DESYNCED", null, [finding("INTERNAL_RECORD_MISMATCH")]);
  }
  if (snapshot.bindingId.length === 0 || request.bindingId.length === 0) {
    return verdict("UNKNOWN", null, [finding("ACCOUNT_IDENTITY_MISSING")]);
  }
  if (snapshot.bindingId !== request.bindingId) return verdict("DESYNCED", null, [finding("ACCOUNT_MISMATCH")]);
  if (snapshot.environment !== request.environment) return verdict("DESYNCED", null, [finding("ENVIRONMENT_MISMATCH")]);
  if (snapshot.provider !== "metaapi-cloud") return verdict("DESYNCED", null, [finding("PROVIDER_MISMATCH")]);
  if (snapshot.invalid) return verdict("UNKNOWN", null, [finding("BROKER_DATA_INVALID")]);
  const passive = passiveFindings(snapshot, request.clientId);
  if (snapshot.unavailable || snapshot.brokerCallSkipped) {
    const state = latest.state === "SUBMISSION_UNKNOWN" ? "UNKNOWN" : "DEGRADED";
    return verdict(state, null, sortFindings([finding("BROKER_UNAVAILABLE"), ...passive]));
  }
  if (snapshot.channels.orders !== "read") {
    const state = latest.state === "SUBMISSION_UNKNOWN" || latest.state === "FILL_REPORTED" ? "UNKNOWN" : "DEGRADED";
    return verdict(state, null, sortFindings([finding("SNAPSHOT_INCOMPLETE"), ...passive]));
  }
  const matches = snapshot.orders.filter((order) => order.clientId === request.clientId);
  if (matches.length > 1) {
    return verdict("DESYNCED", null, sortFindings([finding("AMBIGUOUS_CORRELATION"), ...passive]));
  }
  const match = matches[0] ?? null;
  if (match === null) return absent(latest, snapshot, passive);
  return matched(request, latest, match, snapshot, passive);
}

function absent(
  latest: ExecutionAttemptRecord,
  snapshot: BrokerAccountSnapshot,
  passive: readonly ReconciliationFinding[],
): Verdict {
  if (latest.state === "SUBMISSION_UNKNOWN") {
    const code = snapshot.complete ? "BROKER_ORDER_NOT_FOUND" : "SNAPSHOT_INCOMPLETE";
    return verdict("UNKNOWN", null, sortFindings([finding(code), ...passive]));
  }
  if (!snapshot.complete) return verdict("DEGRADED", null, sortFindings([finding("SNAPSHOT_INCOMPLETE"), ...passive]));
  if (latest.state === "SUBMISSION_ACCEPTED") return verdict("DESYNCED", null, sortFindings([finding("ORDER_MISSING"), ...passive]));
  if (latest.state === "FILL_REPORTED") return verdict("DESYNCED", null, sortFindings([finding("FILL_NOT_FOUND"), ...passive]));
  if (latest.state === "SUBMISSION_REJECTED") {
    return verdict("RECONCILED", null, sortFindings([finding("REJECTION_CONSISTENT"), ...passive]));
  }
  return verdict("RECONCILED", null, sortFindings([finding("NOT_SUBMITTED_CONSISTENT"), ...passive]));
}

function matched(
  request: PersistedExecutionRequest,
  latest: ExecutionAttemptRecord,
  match: BrokerOrderObservation,
  snapshot: BrokerAccountSnapshot,
  passive: readonly ReconciliationFinding[],
): Verdict {
  const orderId = match.orderId;
  if (match.symbol !== "XAUUSD") {
    return verdict("DESYNCED", null, sortFindings([
      finding("SYMBOL_MISMATCH", { orderId, symbol: match.symbol }),
      ...passive,
    ]));
  }
  if (!sameNumber(match.volume, request.acceptedQuantity)) {
    return verdict("DESYNCED", null, sortFindings([
      finding("QUANTITY_MISMATCH", { orderId, brokerVolume: match.volume }),
      ...passive,
    ]));
  }
  if (match.direction !== null && match.direction !== request.direction) {
    return verdict("DESYNCED", null, sortFindings([
      finding("DIRECTION_MISMATCH", { orderId, symbol: match.symbol }),
      ...passive,
    ]));
  }
  if (match.stopLoss !== null && !sameNumber(match.stopLoss, request.stop)) {
    return verdict("DESYNCED", null, sortFindings([finding("STOP_MISMATCH", { orderId }), ...passive]));
  }
  if (request.takeProfit !== null && match.takeProfit !== null && !sameNumber(match.takeProfit, request.takeProfit)) {
    return verdict("DESYNCED", null, sortFindings([finding("TARGET_MISMATCH", { orderId }), ...passive]));
  }
  if (latest.state === "SUBMISSION_REJECTED") {
    return verdict("DESYNCED", null, sortFindings([finding("REJECTION_CONTRADICTED", { orderId }), ...passive]));
  }
  if (latest.state === "NOT_SUBMITTED") {
    return verdict("DESYNCED", null, sortFindings([finding("NOT_SUBMITTED_CONTRADICTED", { orderId }), ...passive]));
  }
  if (snapshot.channels.deals !== "read") {
    if (latest.state === "FILL_REPORTED") {
      return verdict("UNKNOWN", null, sortFindings([finding("SNAPSHOT_INCOMPLETE"), finding("ORDER_MATCHED", { orderId }), ...passive]));
    }
    return resolved(latest, [finding("ORDER_MATCHED", { orderId }), ...passive]);
  }
  const deals = relatedDeals(snapshot.deals, request.clientId, orderId);
  const foreignDeal = deals.find((deal) => deal.symbol !== "XAUUSD");
  if (foreignDeal !== undefined) {
    return verdict("DESYNCED", null, sortFindings([
      finding("SYMBOL_MISMATCH", { orderId, dealId: foreignDeal.dealId, symbol: foreignDeal.symbol }),
      ...passive,
    ]));
  }
  const volume = sumVolumes(deals.map((deal) => deal.volume));
  const authorized = quantityScale(request.acceptedQuantity);
  if (volume === null || authorized === null) {
    return verdict("UNKNOWN", null, sortFindings([finding("BROKER_DATA_INVALID"), ...passive]));
  }
  if (volume === 0n) {
    if (latest.state === "FILL_REPORTED") {
      return verdict("DESYNCED", null, sortFindings([finding("FILL_NOT_FOUND", { orderId }), ...passive]));
    }
    return resolved(latest, [finding("ORDER_MATCHED", { orderId }), ...passive]);
  }
  const brokerVolume = unscaled(volume);
  if (brokerVolume === null) return verdict("UNKNOWN", null, sortFindings([finding("BROKER_DATA_INVALID"), ...passive]));
  if (volume < authorized) {
    if (latest.state === "FILL_REPORTED") {
      return verdict("DESYNCED", null, sortFindings([
        finding("FILL_VOLUME_MISMATCH", { orderId, brokerVolume }),
        ...passive,
      ]));
    }
    return verdict("DEGRADED", null, sortFindings([
      finding("ORDER_MATCHED", { orderId }),
      finding("PARTIAL_FILL", { orderId, brokerVolume }),
      ...passive,
    ]));
  }
  if (volume > authorized) {
    return verdict("DESYNCED", null, sortFindings([finding("OVERFILL", { orderId, brokerVolume }), ...passive]));
  }
  return resolved(latest, [
    finding("ORDER_MATCHED", { orderId }),
    finding("FILL_MATCHED", { orderId, brokerVolume }),
    ...passive,
  ]);
}

function resolved(latest: ExecutionAttemptRecord, findings: readonly ReconciliationFinding[]): Verdict {
  if (latest.state === "SUBMISSION_UNKNOWN") {
    return verdict("RECONCILED", "UNKNOWN_TO_BROKER_ORDER_FOUND", sortFindings([
      finding("UNKNOWN_RESOLVED_ORDER_FOUND"),
      ...findings,
    ]));
  }
  return verdict("RECONCILED", null, sortFindings(findings));
}

function relatedDeals(
  deals: readonly BrokerDealObservation[],
  clientId: string,
  orderId: string,
): readonly BrokerDealObservation[] {
  return deals.filter((deal) => {
    if (deal.clientId !== null && deal.clientId !== clientId) return false;
    if (deal.clientId === clientId) return true;
    return deal.orderId === orderId;
  });
}

function passiveFindings(snapshot: BrokerAccountSnapshot, clientId: string): ReconciliationFinding[] {
  const findings: ReconciliationFinding[] = [];
  if (snapshot.channels.orders === "read") {
    for (const order of snapshot.orders) {
      if (order.clientId === clientId) continue;
      if (order.symbol !== "XAUUSD") {
        findings.push(finding("FOREIGN_SYMBOL_OBSERVED", { orderId: order.orderId, symbol: order.symbol }));
      }
    }
  }
  if (snapshot.channels.deals === "read") {
    for (const deal of snapshot.deals) {
      const correlated = deal.clientId === clientId;
      if (correlated) continue;
      if (deal.symbol !== "XAUUSD") {
        findings.push(finding("FOREIGN_SYMBOL_OBSERVED", { dealId: deal.dealId, symbol: deal.symbol }));
      }
    }
  }
  if (snapshot.channels.positions === "read") {
    for (const position of snapshot.positions) {
      if (position.symbol !== "XAUUSD") {
        findings.push(finding("FOREIGN_SYMBOL_OBSERVED", {
          positionId: position.positionId,
          symbol: position.symbol,
          brokerVolume: position.volume,
        }));
        continue;
      }
      findings.push(finding("POSITION_UNCORRELATED", {
        positionId: position.positionId,
        symbol: position.symbol,
        brokerVolume: position.volume,
      }));
    }
  }
  return findings;
}

function selectLatest(
  attempts: readonly ExecutionAttemptRecord[],
): { kind: "one"; attempt: ExecutionAttemptRecord } | { kind: "ambiguous" } {
  const seen = new Set<number>();
  let best: ExecutionAttemptRecord | null = null;
  for (const attempt of attempts) {
    if (!Number.isInteger(attempt.sequence) || attempt.sequence < 1 || seen.has(attempt.sequence)) {
      return { kind: "ambiguous" };
    }
    seen.add(attempt.sequence);
    if (
      best === null
      || attempt.sequence > best.sequence
      || attempt.executionAttemptId !== executionAttemptKey({
        executionIdentity: attempt.executionIdentity,
        executionRequestId: attempt.executionRequestId,
        sequence: attempt.sequence,
        state: attempt.state,
      })
    ) {
      if (
        attempt.executionAttemptId !== executionAttemptKey({
          executionIdentity: attempt.executionIdentity,
          executionRequestId: attempt.executionRequestId,
          sequence: attempt.sequence,
          state: attempt.state,
        })
      ) {
        return { kind: "ambiguous" };
      }
      best = attempt;
    }
  }
  return best === null ? { kind: "ambiguous" } : { kind: "one", attempt: best };
}

function verdict(
  state: ReconciliationState,
  resolution: ReconciliationResolution | null,
  findings: readonly ReconciliationFinding[],
): Verdict {
  return { state, resolution, findings: sortFindings(findings) };
}

function finding(
  code: ReconciliationFindingCode,
  extra: Partial<Omit<ReconciliationFinding, "code">> = {},
): ReconciliationFinding {
  return {
    code,
    orderId: extra.orderId ?? null,
    dealId: extra.dealId ?? null,
    positionId: extra.positionId ?? null,
    symbol: extra.symbol ?? null,
    brokerVolume: extra.brokerVolume ?? null,
  };
}

function sortFindings(findings: readonly ReconciliationFinding[]): ReconciliationFinding[] {
  return [...findings].sort((left, right) => {
    const key = (item: ReconciliationFinding) => [
      item.code,
      item.orderId ?? "",
      item.dealId ?? "",
      item.positionId ?? "",
      item.symbol ?? "",
      item.brokerVolume === null ? "" : String(item.brokerVolume),
    ].join("|");
    const a = key(left);
    const b = key(right);
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}

function sameNumber(left: number, right: number): boolean {
  const a = quantityScale(left);
  const b = quantityScale(right);
  return a !== null && b !== null && a === b;
}

function quantityScale(value: number): bigint | null {
  try {
    return scale(value);
  } catch {
    return null;
  }
}

function sumVolumes(values: readonly number[]): bigint | null {
  try {
    return values.reduce((total, value) => total + scale(value), 0n);
  } catch {
    return null;
  }
}

function unscaled(value: bigint): number | null {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const text = `${abs / 100_000_000n}.${(abs % 100_000_000n).toString().padStart(8, "0")}`;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

function readKillSwitch(value: unknown, environment: TradingEnvironment, agentRunId: string): boolean | null {
  if (value === undefined) return null;
  try {
    const state = parseKillSwitchState(value);
    if (state.environment !== environment || state.agentRunId !== agentRunId) return null;
    return state.engaged;
  } catch {
    return null;
  }
}

function eventsFor(
  input: ReconcileInput,
  verdictResult: Verdict,
  attempt: ExecutionAttemptRecord | null,
  runId: string,
): TradingEvent[] {
  const types: TradingEventType[] = ["reconciliation.started", outcomeEvent(verdictResult.state)];
  if (verdictResult.resolution !== null) types.push("execution.resolved");
  const correlationId = recordIdSchema.safeParse(input.request.executionRequestId).success
    ? input.request.executionRequestId
    : input.agentRunId;
  return types.map((type) => tradingFact({
    type,
    eventId: `tev.${contentHash({
      schema: RECONCILIATION_ENGINE_VERSION,
      runId,
      type,
    }).slice(0, 40)}`,
    at: input.reconciledAt,
    agentRunId: input.agentRunId,
    correlationId,
    environment: input.request.environment,
    actor: "xauusd-reconciliation",
    nextState: verdictResult.state,
    payload: {
      reconciliationRunId: runId,
      state: verdictResult.state,
      resolution: verdictResult.resolution,
      findings: verdictResult.findings.map((item) => item.code),
      executionRequestId: input.request.executionRequestId,
      executionAttemptId: attempt?.executionAttemptId ?? null,
      executionIdentity: input.request.executionIdentity,
      accountBindingId: input.request.bindingId,
      snapshotId: input.snapshot.snapshotId,
      provider: "metaapi-cloud",
      repairAttempted: false,
      retried: false,
      previousState: attempt?.state ?? null,
    },
  })).filter((event): event is TradingEvent => event !== null);
}

function outcomeEvent(state: ReconciliationState): TradingEventType {
  switch (state) {
    case "RECONCILED":
      return "reconciliation.completed";
    case "DEGRADED":
      return "reconciliation.degraded";
    case "DESYNCED":
      return "reconciliation.desynced";
    case "UNKNOWN":
      return "reconciliation.unknown";
  }
}
