import type { Decision } from "../../../shared/trading/decision.ts";
import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { assertNoSecretFields } from "../../../shared/trading/ids.ts";
import type { OrderIntent } from "../../../shared/trading/order-intent.ts";
import { autonomousOrdersBlocked, parseReconciliationState, type ReconciliationState } from "../../../shared/trading/reconciliation.ts";
import { assessApproval, bindingFromProposal, type ApprovalAssessmentInput } from "../approval/assess.ts";
import { proposalBinding } from "../approval/binding.ts";
import type { ApprovalDecision, ApprovalState } from "../approval/result.ts";
import { evaluateFireTimeGate, type FireTimeGateInput, type GateMarketFact } from "../gate/evaluate.ts";
import type { GateDecision, GateState } from "../gate/result.ts";
import type { AuthoritativeReferenceWrite, EligibilityReferenceWrite, OccurrenceRepository } from "../persistence/occurrences.ts";
import { evaluateXauUsdProposal, type ProposalEvaluation, type ProposalInput, type ProposalOutcome } from "../proposal/evaluate.ts";

/**
 * Decision → execution eligibility. Version `xauusd-eligibility-handoff-1`.
 *
 * The existing risk, policy, approval, `xauusd-proposal-binding-1`, and
 * fire-time gate engines stay authoritative. This module only sequences
 * them. `ELIGIBLE_FOR_EXECUTION` means the exact proposal may be handed to
 * the existing execution boundary later. It does not submit, open a
 * position, or create an execution attempt.
 *
 * Phase 7 `FireTimeGateInput` has no reconciliation field. DESYNCED and
 * UNKNOWN already block autonomous orders through `autonomousOrdersBlocked`.
 * Those states stop here, before `evaluateFireTimeGate`, so this handoff
 * does not add a second gate or a second hash.
 */
export const ELIGIBILITY_HANDOFF_VERSION = "xauusd-eligibility-handoff-1" as const;

export type EligibilityStop =
  | "risk"
  | "non_execution"
  | "policy"
  | "approval"
  | "proposal_binding"
  | "reconciliation"
  | "gate";

export interface EligibilityHandoffInput {
  readonly instrument: unknown;
  readonly decision: Decision | null;
  readonly orderIntent: OrderIntent | null;
  readonly market: unknown;
  readonly account: unknown;
  readonly riskConfig: unknown;
  readonly policyConfig: unknown;
  readonly approvalConfig: unknown;
  readonly gateConfig: unknown;
  readonly environment: unknown;
  readonly provenance: unknown;
  readonly assessedAt: string;
  readonly agentRunId: string;
  readonly evaluationRunId?: string | null;
  readonly runtimeThreadId?: string | null;
  readonly runtimeTurnId?: string | null;
  readonly requestedQuantity?: number | null;
  readonly autonomy: unknown;
  readonly permissions: unknown;
  /** Existing policy approval token (`absent`, `pending`, `granted`, `denied`). */
  readonly policyApproval: unknown;
  /** Existing ApprovalFact. Null is absent. This is not inferred from policy. */
  readonly approval: unknown;
  readonly approvalRequestId: string;
  /** Existing reconciliation state. Absence fails closed. */
  readonly reconciliation: unknown;
  readonly killSwitch: unknown;
  readonly occurrence?: {
    readonly repository: Pick<OccurrenceRepository, "attachEligibilityReferences"> & Partial<Pick<OccurrenceRepository, "attachAuthoritativeRecords">>;
    readonly occurrenceId: string;
  } | null;
}

export interface EligibilityHandoff {
  readonly schemaVersion: typeof ELIGIBILITY_HANDOFF_VERSION;
  readonly stoppedAt: EligibilityStop;
  readonly state: GateState | ProposalOutcome | ApprovalState | "BLOCKED";
  readonly reasons: readonly string[];
  readonly proposal: ProposalEvaluation | null;
  readonly approval: ApprovalDecision | null;
  readonly binding: string | null;
  readonly gate: GateDecision | null;
  readonly reconciliation: ReconciliationState | null;
  readonly liveExecutionEnabled: false;
  readonly orderSubmitted: false;
  readonly executionAttemptCreated: false;
  readonly brokerCalled: false;
  readonly metaApiCalled: false;
}

export function evaluateExecutionEligibility(input: EligibilityHandoffInput): EligibilityHandoff {
  try {
    assertNoSecretFields(input, "execution eligibility input");
  } catch (error) {
    const reason = error instanceof TradingDomainError && error.code === "credentials_forbidden"
      ? "CREDENTIALS_FORBIDDEN"
      : "SYSTEM_ERROR";
    return publish(input, {
      stoppedAt: "risk",
      state: "INVALID",
      reasons: [reason],
      proposal: null,
      approval: null,
      binding: null,
      gate: null,
      reconciliation: null,
    });
  }
  const proposal = evaluateXauUsdProposal(proposalInput(input));
  if (proposal.outcome !== "ELIGIBLE_FOR_FUTURE_EXECUTION") {
    const stoppedAt: EligibilityStop = proposal.risk.state !== "ACCEPT" || proposal.policy === null
      ? "risk"
      : proposal.policy.state === "ALLOW"
        ? "non_execution"
        : "policy";
    return publish(input, {
      stoppedAt,
      state: proposal.outcome,
      reasons: proposal.reasons,
      proposal,
      approval: null,
      binding: null,
      gate: null,
      reconciliation: null,
    });
  }
  const policy = proposal.policy;
  if (policy === null || policy.state !== "ALLOW") {
    return publish(input, {
      stoppedAt: "policy",
      state: proposal.outcome,
      reasons: proposal.reasons,
      proposal,
      approval: null,
      binding: null,
      gate: null,
      reconciliation: null,
    });
  }
  const assessment = approvalInput(input, proposal, policy);
  const approval = assessApproval(assessment);
  if (approval.state !== "APPROVED") {
    return publish(input, {
      stoppedAt: "approval",
      state: approval.state,
      reasons: approval.reasons,
      proposal,
      approval,
      binding: approval.binding,
      gate: null,
      reconciliation: null,
    });
  }
  const facts = proposal.risk.configId === null || policy.configId === null
    ? null
    : bindingFromProposal(assessment, proposal.risk.configId, policy.configId);
  const binding = facts === null ? null : proposalBinding(facts);
  if (binding === null || approval.binding !== binding) {
    return publish(input, {
      stoppedAt: "proposal_binding",
      state: "BLOCKED",
      reasons: ["PROPOSAL_CHANGED"],
      proposal,
      approval,
      binding,
      gate: null,
      reconciliation: null,
    });
  }
  const reconciliation = readReconciliation(input.reconciliation);
  if (reconciliation.ok === false) {
    return publish(input, {
      stoppedAt: "reconciliation",
      state: "BLOCKED",
      reasons: [reconciliation.reason],
      proposal,
      approval,
      binding,
      gate: null,
      reconciliation: reconciliation.state,
    });
  }
  const gate = evaluateFireTimeGate(gateInput(input, proposal, policy, approval));
  return publish(input, {
    stoppedAt: "gate",
    state: gate.state,
    reasons: gate.reasons,
    proposal,
    approval,
    binding: gate.binding ?? binding,
    gate,
    reconciliation: reconciliation.state,
  });
}

function proposalInput(input: EligibilityHandoffInput): ProposalInput {
  return {
    instrument: input.instrument,
    decision: input.decision,
    orderIntent: input.orderIntent,
    market: input.market,
    account: input.account,
    riskConfig: input.riskConfig,
    policyConfig: input.policyConfig,
    environment: input.environment,
    provenance: input.provenance,
    assessedAt: input.assessedAt,
    agentRunId: input.agentRunId,
    evaluationRunId: input.evaluationRunId,
    runtimeThreadId: input.runtimeThreadId,
    runtimeTurnId: input.runtimeTurnId,
    requestedQuantity: input.requestedQuantity ?? null,
    autonomy: input.autonomy,
    permissions: input.permissions,
    approval: input.policyApproval,
    killSwitch: input.killSwitch,
  };
}

function approvalInput(
  input: EligibilityHandoffInput,
  proposal: ProposalEvaluation,
  policy: NonNullable<ProposalEvaluation["policy"]>,
): ApprovalAssessmentInput {
  return {
    instrument: input.instrument,
    decision: input.decision,
    orderIntent: input.orderIntent,
    risk: proposal.risk,
    policy,
    environment: input.environment,
    provenance: input.provenance,
    autonomy: input.autonomy,
    permissions: input.permissions,
    killSwitch: input.killSwitch,
    approval: input.approval,
    config: input.approvalConfig,
    evaluatedAt: input.assessedAt,
    agentRunId: input.agentRunId,
    approvalRequestId: input.approvalRequestId,
    requestedQuantity: input.requestedQuantity ?? null,
    evaluationRunId: input.evaluationRunId,
    runtimeThreadId: input.runtimeThreadId,
    runtimeTurnId: input.runtimeTurnId,
  };
}

function gateInput(
  input: EligibilityHandoffInput,
  proposal: ProposalEvaluation,
  policy: NonNullable<ProposalEvaluation["policy"]>,
  approval: ApprovalDecision,
): FireTimeGateInput {
  return {
    instrument: input.instrument,
    decision: input.decision,
    orderIntent: input.orderIntent,
    risk: proposal.risk,
    policy,
    approval,
    market: gateMarket(input.market),
    accountEquity: numberField(input.account, "equity"),
    exposureLots: numberField(input.account, "exposureLots"),
    environment: input.environment,
    provenance: input.provenance,
    autonomy: input.autonomy,
    permissions: input.permissions,
    killSwitch: input.killSwitch,
    approvalFact: input.approval,
    requestedQuantity: input.requestedQuantity ?? null,
    riskConfig: input.riskConfig,
    policyConfig: input.policyConfig,
    approvalConfig: input.approvalConfig,
    gateConfig: input.gateConfig,
    evaluatedAt: input.assessedAt,
    agentRunId: input.agentRunId,
    evaluationRunId: input.evaluationRunId,
    runtimeThreadId: input.runtimeThreadId,
    runtimeTurnId: input.runtimeTurnId,
  };
}

function gateMarket(value: unknown): GateMarketFact | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.snapshotId !== "string" || typeof record.providerTimestamp !== "string") return null;
  return {
    snapshotId: record.snapshotId,
    provenance: record.provenance,
    freshness: record.freshness,
    marketTimestamp: record.providerTimestamp,
  };
}

function numberField(value: unknown, key: string): number | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" ? field : null;
}

function readReconciliation(value: unknown):
  | { ok: true; state: ReconciliationState }
  | { ok: false; state: ReconciliationState | null; reason: "reconciliation_blocks_autonomous" | "reconciliation_unknown" } {
  try {
    const state = parseReconciliationState(value);
    if (autonomousOrdersBlocked(state)) {
      return { ok: false, state, reason: "reconciliation_blocks_autonomous" };
    }
    return { ok: true, state };
  } catch (error) {
    if (error instanceof TradingDomainError && error.code === "reconciliation_unknown") {
      return { ok: false, state: null, reason: "reconciliation_unknown" };
    }
    return { ok: false, state: null, reason: "reconciliation_unknown" };
  }
}

function publish(
  input: EligibilityHandoffInput,
  draft: Omit<EligibilityHandoff, "schemaVersion" | "liveExecutionEnabled" | "orderSubmitted" | "executionAttemptCreated" | "brokerCalled" | "metaApiCalled">,
): EligibilityHandoff {
  const result: EligibilityHandoff = Object.freeze({
    schemaVersion: ELIGIBILITY_HANDOFF_VERSION,
    stoppedAt: draft.stoppedAt,
    state: draft.state,
    reasons: Object.freeze([...draft.reasons]),
    proposal: draft.proposal,
    approval: draft.approval,
    binding: draft.binding,
    gate: draft.gate,
    reconciliation: draft.reconciliation,
    liveExecutionEnabled: false,
    orderSubmitted: false,
    executionAttemptCreated: false,
    brokerCalled: false,
    metaApiCalled: false,
  });
  const occurrence = input.occurrence;
  if (occurrence != null) {
    const eligible = result.gate?.state === "ELIGIBLE_FOR_EXECUTION";
    const reference: EligibilityReferenceWrite = {
      occurrenceId: occurrence.occurrenceId,
      agentRunId: input.agentRunId,
      environment: occurrenceEnvironment(input.environment),
      decisionId: input.decision?.id ?? null,
      orderIntentId: input.orderIntent?.id ?? null,
      riskDecisionId: result.proposal?.risk.id ?? null,
      policyDecisionId: result.proposal?.policy?.id ?? null,
      approvalId: result.approval?.humanApprovalId ?? null,
      proposalBindingHash: result.binding,
      failureCode: eligible ? null : result.reasons[0] ?? null,
    };
    if (occurrence.repository.attachAuthoritativeRecords) {
      const authoritative: AuthoritativeReferenceWrite = {
        ...reference,
        gateDecisionId: result.gate?.id ?? null,
        decision: input.decision,
        risk: result.proposal?.risk ?? null,
        policy: result.proposal?.policy ?? null,
        gate: result.gate,
      };
      occurrence.repository.attachAuthoritativeRecords(authoritative);
    } else {
      occurrence.repository.attachEligibilityReferences(reference);
    }
  }
  return result;
}

function occurrenceEnvironment(value: unknown): TradingEnvironment {
  if (value === "PAPER" || value === "LIVE" || value === "SIMULATOR") return value;
  throw new TradingDomainError("trading_store_rejected", "Eligibility correlation environment was rejected. Failing closed.");
}
