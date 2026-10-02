import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { assertNoSecretFields, seal, utcTimestampSchema } from "../../../shared/trading/ids.ts";
import { XAUUSD_INSTRUMENT } from "../../../shared/trading/instrument.ts";
import type { ExecutionAttemptRecord } from "../execution/ledger.ts";
import type { ExecutionDecision } from "../execution/result.ts";
import type { ExecutionReceiptWrite, TradingOccurrence } from "../persistence/occurrences.ts";
import type { TradingStore } from "../persistence/store.ts";
import { reconcileExecution, type ReconciliationResult } from "../reconciliation/engine.ts";
import type { BrokerAccountSnapshot } from "../reconciliation/snapshot.ts";
import { recordPostTradeReview } from "../review/record.ts";

/**
 * Execution result and reconciliation correlation for one trading occurrence.
 * Version `xauusd-occurrence-lifecycle-1`.
 *
 * This calls the existing reconciliation engine. It does not submit, retry,
 * repair, or infer a fill from an acknowledgement.
 */
export const OCCURRENCE_LIFECYCLE_VERSION = "xauusd-occurrence-lifecycle-1" as const;

export interface OccurrenceLifecycle {
  readonly schemaVersion: typeof OCCURRENCE_LIFECYCLE_VERSION;
  readonly occurrence: TradingOccurrence;
  readonly reconciliation: ReconciliationResult;
  readonly retried: false;
  readonly repairAttempted: false;
}

export interface OccurrenceReconciliationInput {
  readonly store: TradingStore;
  readonly occurrenceId: string;
  readonly snapshot: BrokerAccountSnapshot;
  readonly reconciledAt: string;
  readonly killSwitch?: unknown;
}

/** Maps one execution result onto the occurrence receipt. Unknown stays
 * unknown. Accepted and fill-reported stay distinct and are not reconciliation. */
export function executionReceiptFor(
  occurrence: TradingOccurrence,
  execution: ExecutionDecision,
): ExecutionReceiptWrite | null {
  if (execution.state === "NOT_SUBMITTED" || execution.executionIdentity === null) return null;
  if (execution.agentRunId !== occurrence.agentRunId) {
    throw new TradingDomainError(
      "agent_run_mismatch",
      "Execution result agent run does not match the occurrence. Failing closed.",
    );
  }
  if (execution.environment !== null && execution.environment !== occurrence.environment) {
    throw new TradingDomainError(
      "trading_store_rejected",
      "Execution result environment does not match the occurrence. Failing closed.",
    );
  }
  if (execution.decisionId !== null && execution.decisionId !== occurrence.decisionId) {
    throw new TradingDomainError("trading_store_rejected", "Execution result decision does not match the occurrence. Failing closed.");
  }
  if (execution.orderIntentId !== null && execution.orderIntentId !== occurrence.orderIntentId) {
    throw new TradingDomainError("trading_store_rejected", "Execution result intent does not match the occurrence. Failing closed.");
  }
  if (execution.humanApprovalId !== null && occurrence.approvalId !== null && execution.humanApprovalId !== occurrence.approvalId) {
    throw new TradingDomainError("trading_store_rejected", "Execution result approval does not match the occurrence. Failing closed.");
  }
  const failureCode = execution.state === "SUBMISSION_ACCEPTED" || execution.state === "FILL_REPORTED"
    ? null
    : execution.reasons[0] ?? null;
  return {
    occurrenceId: occurrence.occurrenceId,
    agentRunId: occurrence.agentRunId,
    environment: occurrence.environment,
    executionRequestId: execution.id,
    executionState: execution.state,
    failureCode,
    domainStatus: execution.state === "SUBMISSION_UNKNOWN" ? "submitted_unknown" : null,
  };
}

/** Compares the reserved request with one broker snapshot and records that
 * existing reconciliation on the same occurrence. */
export function reconcileOccurrenceLifecycle(input: OccurrenceReconciliationInput): OccurrenceLifecycle {
  assertNoSecretFields(input, "occurrence reconciliation");
  if (!utcTimestampSchema.safeParse(input.reconciledAt).success) {
    throw new TradingDomainError("trading_store_rejected", "Reconciliation time was rejected. Failing closed.");
  }
  const occurrence = input.store.occurrences.readByOccurrenceId(input.occurrenceId);
  if (occurrence === null || occurrence.executionRequestId === null || occurrence.executionState === null) {
    throw new TradingDomainError("trading_store_rejected", "Reconciliation matched no submitted occurrence. Failing closed.");
  }
  if (occurrence.executionState === "NOT_SUBMITTED" || occurrence.instrument !== XAUUSD_INSTRUMENT) {
    throw new TradingDomainError("trading_store_rejected", "Reconciliation matched no submitted occurrence. Failing closed.");
  }
  const request = input.store.readRequestById(occurrence.executionRequestId);
  if (
    request === null
    || request.executionRequestId !== occurrence.executionRequestId
    || request.agentRunId !== occurrence.agentRunId
    || request.environment !== occurrence.environment
    || request.instrument !== XAUUSD_INSTRUMENT
    || request.decisionId !== occurrence.decisionId
    || request.orderIntentId !== occurrence.orderIntentId
    || (occurrence.proposalBindingHash !== null && request.proposalBinding !== occurrence.proposalBindingHash)
  ) {
    throw new TradingDomainError("trading_store_rejected", "Reconciliation request does not match the occurrence. Failing closed.");
  }
  if (input.snapshot.environment !== occurrence.environment) {
    throw new TradingDomainError(
      "trading_store_rejected",
      "Reconciliation environment does not match the occurrence. Failing closed.",
    );
  }
  const attempts = input.store.readAttempts(request.executionIdentity);
  const latest = latestAttempt(attempts);
  if (latest === null || latest.state !== occurrence.executionState || latest.executionRequestId !== occurrence.executionRequestId) {
    throw new TradingDomainError("trading_store_rejected", "Reconciliation attempt does not match the occurrence. Failing closed.");
  }
  const reconciliation = reconcileExecution({
    request,
    attempts,
    snapshot: input.snapshot,
    killSwitch: input.killSwitch,
    reconciledAt: input.reconciledAt,
    agentRunId: occurrence.agentRunId,
  });
  if (
    reconciliation.executionRequestId !== occurrence.executionRequestId
    || reconciliation.executionAgentRunId !== occurrence.agentRunId
    || reconciliation.agentRunId !== occurrence.agentRunId
    || reconciliation.environment !== occurrence.environment
    || reconciliation.internalState !== occurrence.executionState
    || reconciliation.retried !== false
    || reconciliation.repairAttempted !== false
  ) {
    throw new TradingDomainError("trading_store_rejected", "Reconciliation result does not match the occurrence. Failing closed.");
  }
  if (
    occurrence.reconciliationState !== null
    && occurrence.reconciliationState !== "UNKNOWN"
    && (
      occurrence.reconciliationRunId !== reconciliation.reconciliationRunId
      || occurrence.reconciliationState !== reconciliation.state
    )
  ) {
    throw new TradingDomainError("immutable_revision", "Reconciliation correlation already differs. Failing closed.");
  }
  input.store.saveSnapshot(input.snapshot);
  input.store.saveReconciliation(reconciliation);
  const recorded = input.store.occurrences.attachReconciliationReceipt({
    occurrenceId: occurrence.occurrenceId,
    agentRunId: occurrence.agentRunId,
    environment: occurrence.environment,
    executionRequestId: occurrence.executionRequestId,
    reconciliationRunId: reconciliation.reconciliationRunId,
    reconciliationState: reconciliation.state,
    reconciledAt: reconciliation.reconciledAt,
    snapshotId: input.snapshot.snapshotId,
  });
  recordPostTradeReview(input.store, {
    occurrenceId: recorded.occurrenceId,
    recordedAt: reconciliation.reconciledAt,
  });
  return seal({
    schemaVersion: OCCURRENCE_LIFECYCLE_VERSION,
    occurrence: recorded,
    reconciliation,
    retried: false,
    repairAttempted: false,
  });
}

function latestAttempt(attempts: readonly ExecutionAttemptRecord[]): ExecutionAttemptRecord | null {
  let latest: ExecutionAttemptRecord | null = null;
  for (const attempt of attempts) {
    if (latest === null || attempt.sequence > latest.sequence) latest = attempt;
  }
  return latest;
}
