import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { assertNoSecretFields } from "../../../shared/trading/ids.ts";
import { XAUUSD_INSTRUMENT } from "../../../shared/trading/instrument.ts";
import type { ExecutionLedger } from "../execution/ledger.ts";
import type { XauUsdExecutionProvider } from "../execution/provider.ts";
import type { ExecutionDecision } from "../execution/result.ts";
import {
  submitAuthorizedExecution,
  type ExecutionQuote,
  type ExecutionSubmitInput,
} from "../execution/submit.ts";
import type { OccurrenceRepository, TradingOccurrence } from "../persistence/occurrences.ts";
import {
  evaluateExecutionEligibility,
  type EligibilityHandoff,
  type EligibilityHandoffInput,
} from "./handoff.ts";

/**
 * Eligible proposal → existing execution boundary.
 * Version `xauusd-execution-handoff-1`.
 *
 * `submitAuthorizedExecution` remains the only submit path. It reserves the
 * existing execution identity, calls the existing MetaApi adapter, and
 * persists the existing attempt states. This module does not retry, does
 * not mint a provider turn id, and does not read broker credentials.
 */
export const EXECUTION_HANDOFF_VERSION = "xauusd-execution-handoff-1" as const;

export interface EligibleExecutionInput extends EligibilityHandoffInput {
  readonly provider: XauUsdExecutionProvider;
  readonly ledger: ExecutionLedger;
  readonly accountBinding: unknown;
  readonly occurrence?: {
    readonly repository: Pick<OccurrenceRepository, "attachEligibilityReferences" | "readByOccurrenceId" | "attachExecutionReceipt">;
    readonly occurrenceId: string;
  } | null;
}

export interface EligibleExecutionResult {
  readonly schemaVersion: typeof EXECUTION_HANDOFF_VERSION;
  readonly eligibility: EligibilityHandoff | null;
  readonly execution: ExecutionDecision | null;
  readonly brokerCalled: boolean;
  readonly retried: false;
}

export async function submitEligibleExecution(input: EligibleExecutionInput): Promise<EligibleExecutionResult> {
  try {
    assertNoSecretFields(input, "authorized execution handoff");
  } catch (error) {
    if (error instanceof TradingDomainError && error.code === "credentials_forbidden") {
      return closed(null);
    }
    return closed(null);
  }
  const eligibility = evaluateExecutionEligibility(input);
  if (eligibility.gate?.state !== "ELIGIBLE_FOR_EXECUTION" || eligibility.proposal === null || eligibility.proposal.policy === null || eligibility.approval === null || eligibility.gate === null) {
    return closed(eligibility);
  }
  const row = authorizedOccurrence(input, eligibility);
  if (row === null) return closed(eligibility);
  const execution = await submitAuthorizedExecution(executionInput(input, eligibility));
  recordReceipt(input, row, execution);
  return Object.freeze({
    schemaVersion: EXECUTION_HANDOFF_VERSION,
    eligibility,
    execution,
    brokerCalled: execution.brokerCalled,
    retried: false,
  });
}

function executionInput(input: EligibleExecutionInput, eligibility: EligibilityHandoff): ExecutionSubmitInput {
  const proposal = eligibility.proposal;
  const policy = proposal?.policy ?? null;
  const gate = eligibility.gate;
  const approval = eligibility.approval;
  if (proposal === null || policy === null || gate === null || approval === null) {
    throw new TradingDomainError("trading_store_rejected", "Authorized execution was rejected. Failing closed.");
  }
  return {
    instrument: input.instrument,
    decision: input.decision,
    orderIntent: input.orderIntent,
    risk: proposal.risk,
    policy,
    approval,
    gate,
    binding: input.accountBinding,
    quote: quoteFromMarket(input.market, proposal.risk.snapshotId),
    killSwitch: input.killSwitch,
    environment: input.environment,
    provenance: input.provenance,
    requestedQuantity: input.requestedQuantity ?? null,
    provider: input.provider,
    ledger: input.ledger,
    submittedAt: input.assessedAt,
    agentRunId: input.agentRunId,
    evaluationRunId: input.evaluationRunId,
    runtimeThreadId: input.runtimeThreadId,
    runtimeTurnId: input.runtimeTurnId,
  };
}

function quoteFromMarket(market: unknown, snapshotId: string | null): ExecutionQuote | null {
  if (market === null || typeof market !== "object" || Array.isArray(market) || snapshotId === null) return null;
  const record = market as Record<string, unknown>;
  if (record.snapshotId !== snapshotId) return null;
  if (typeof record.bid !== "number" || typeof record.ask !== "number") return null;
  return { bid: record.bid, ask: record.ask, snapshotId };
}

function authorizedOccurrence(input: EligibleExecutionInput, eligibility: EligibilityHandoff): TradingOccurrence | null {
  const occurrence = input.occurrence;
  if (occurrence == null) return null;
  const row = occurrence.repository.readByOccurrenceId(occurrence.occurrenceId);
  const proposal = eligibility.proposal;
  const decision = input.decision;
  const intent = input.orderIntent;
  if (row === null || proposal === null || proposal.policy === null || decision === null || intent === null) return null;
  if (row.occurrenceId !== occurrence.occurrenceId || row.agentRunId !== input.agentRunId) return null;
  if (row.environment !== input.environment) return null;
  if (row.providerTurnId === null || input.runtimeTurnId == null || row.providerTurnId !== input.runtimeTurnId) return null;
  if (input.instrument !== XAUUSD_INSTRUMENT || decision.instrument !== XAUUSD_INSTRUMENT || intent.instrument !== XAUUSD_INSTRUMENT) return null;
  if (row.decisionId !== decision.id || row.orderIntentId !== intent.id) return null;
  if (row.riskDecisionId !== proposal.risk.id || row.policyDecisionId !== proposal.policy.id) return null;
  if (eligibility.binding === null || row.proposalBindingHash !== eligibility.binding) return null;
  if (eligibility.approval?.humanApprovalId != null && row.approvalId !== eligibility.approval.humanApprovalId) return null;
  if (intent.entry === undefined || intent.stop === undefined) return null;
  if (intent.entry !== proposal.risk.trace.entry || intent.stop !== proposal.risk.trace.stop) return null;
  if (proposal.risk.trace.acceptedQuantity === null) return null;
  if (input.requestedQuantity != null && proposal.risk.trace.acceptedQuantity !== input.requestedQuantity) return null;
  return row;
}

function recordReceipt(input: EligibleExecutionInput, row: TradingOccurrence, execution: ExecutionDecision): void {
  const occurrence = input.occurrence;
  if (occurrence == null || execution.executionIdentity === null || execution.state === "NOT_SUBMITTED") return;
  if (row.executionRequestId !== null && row.executionRequestId !== execution.id) return;
  const failureCode = execution.state === "SUBMISSION_ACCEPTED" || execution.state === "FILL_REPORTED"
    ? null
    : execution.reasons[0] ?? null;
  occurrence.repository.attachExecutionReceipt({
    occurrenceId: row.occurrenceId,
    agentRunId: row.agentRunId,
    environment: row.environment,
    executionRequestId: execution.id,
    failureCode,
    domainStatus: execution.state === "SUBMISSION_UNKNOWN" ? "submitted_unknown" : null,
  });
}

function closed(eligibility: EligibilityHandoff | null): EligibleExecutionResult {
  return Object.freeze({
    schemaVersion: EXECUTION_HANDOFF_VERSION,
    eligibility,
    execution: null,
    brokerCalled: false,
    retried: false,
  });
}
