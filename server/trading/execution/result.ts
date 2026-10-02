import type { ProvenanceStatus, TradingEnvironment } from "../../../shared/trading/environment.ts";
import type { TradingEvent } from "../../../shared/trading/events.ts";

/** Execution schema. Acknowledgement, fill, and position are separate facts. */
export const EXECUTION_ENGINE_VERSION = "xauusd-execution-1" as const;

export const EXECUTION_STATES = [
  "NOT_SUBMITTED",
  "SUBMISSION_REJECTED",
  "SUBMISSION_ACCEPTED",
  "SUBMISSION_UNKNOWN",
  "FILL_REPORTED",
] as const;

export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const EXECUTION_REASON_CODES = [
  "SUBMITTED",
  "ACKNOWLEDGED",
  "FILL_EXPLICIT",
  "GATE_NOT_ELIGIBLE",
  "AUTHORIZATION_MISMATCH",
  "PROPOSAL_MISMATCH",
  "SILENT_REPAIR_REJECTED",
  "INVALID_INSTRUMENT",
  "INVALID_INPUT",
  "REPLAY_RESEARCH_ONLY",
  "PROVENANCE_REJECTED",
  "ENVIRONMENT_NOT_EXECUTABLE",
  "ACCOUNT_BINDING_MISSING",
  "ACCOUNT_BINDING_MISMATCH",
  "KILL_SWITCH_ENGAGED",
  "KILL_SWITCH_UNKNOWN",
  "ORDER_NOT_REPRESENTABLE",
  "POSITION_IDENTITY_AMBIGUOUS",
  "PAUSED",
  "INTENT_FLAGS_INVALID",
  "CREDENTIALS_MISSING",
  "CREDENTIALS_FORBIDDEN",
  "DUPLICATE_EXECUTION",
  "RECONCILIATION_REQUIRED",
  "BROKER_REJECTED",
  "BROKER_UNKNOWN",
  "BROKER_TERMS_MISMATCH",
  "SYSTEM_ERROR",
] as const;

export type ExecutionReason = (typeof EXECUTION_REASON_CODES)[number];

export interface ExecutionFill {
  readonly brokerFillId: string;
  readonly price: number;
  readonly volume: number;
}

export interface ExecutionDecision {
  readonly schemaVersion: typeof EXECUTION_ENGINE_VERSION;
  readonly id: string;
  readonly executionIdentity: string | null;
  readonly state: ExecutionState;
  readonly reasons: readonly [ExecutionReason, ...ExecutionReason[]];
  readonly agentRunId: string;
  readonly decisionId: string | null;
  readonly orderIntentId: string | null;
  readonly riskDecisionId: string | null;
  readonly policyDecisionId: string | null;
  readonly approvalDecisionId: string | null;
  readonly humanApprovalId: string | null;
  readonly gateId: string | null;
  readonly bindingId: string | null;
  readonly environment: TradingEnvironment | null;
  readonly provenance: ProvenanceStatus | null;
  readonly direction: "LONG" | "SHORT" | null;
  readonly entry: number | null;
  readonly stop: number | null;
  readonly takeProfit: number | null;
  readonly quantity: number | null;
  readonly closePositionId: string | null;
  readonly brokerRequestId: string | null;
  readonly brokerCode: string | null;
  readonly fill: ExecutionFill | null;
  readonly submittedAt: string | null;
  readonly brokerCalled: boolean;
  readonly simulatorFallback: false;
  readonly retried: false;
  readonly events: readonly TradingEvent[];
}

/** Infrastructure fact. Acceptance is not a fill and not a quality score. */
export function executionInfrastructureFact(
  state: ExecutionState,
): "execution_not_submitted" | "execution_rejected" | "execution_accepted" | "execution_unknown" | "execution_filled" {
  switch (state) {
    case "NOT_SUBMITTED":
      return "execution_not_submitted";
    case "SUBMISSION_REJECTED":
      return "execution_rejected";
    case "SUBMISSION_ACCEPTED":
      return "execution_accepted";
    case "SUBMISSION_UNKNOWN":
      return "execution_unknown";
    case "FILL_REPORTED":
      return "execution_filled";
  }
}
