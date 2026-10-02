import type { AutonomyLevel } from "../../../shared/trading/autonomy.ts";
import type { ProvenanceStatus, TradingEnvironment } from "../../../shared/trading/environment.ts";
import type { TradingEvent } from "../../../shared/trading/events.ts";
import { APPROVAL_ENGINE_VERSION } from "./config.ts";

export const APPROVAL_STATES = ["APPROVED", "REJECTED", "BLOCKED", "INVALID"] as const;

export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const APPROVAL_REASON_CODES = [
  "APPROVAL_GRANTED",
  "APPROVAL_NOT_REQUIRED",
  "APPROVAL_REQUIRED",
  "APPROVAL_DENIED",
  "APPROVAL_MISMATCH",
  "APPROVAL_STALE",
  "APPROVAL_FUTURE",
  "APPROVAL_FRESHNESS_UNCONFIGURED",
  "APPROVAL_CONFIG_INVALID",
  "RISK_NOT_ACCEPTED",
  "POLICY_NOT_ELIGIBLE",
  "AUTONOMY_INSUFFICIENT",
  "AUTONOMY_MISMATCH",
  "PERMISSION_MISSING",
  "KILL_SWITCH_ENGAGED",
  "KILL_SWITCH_UNKNOWN",
  "INVALID_INSTRUMENT",
  "INVALID_INPUT",
  "CREDENTIALS_FORBIDDEN",
  "SYSTEM_ERROR",
] as const;

export type ApprovalReason = (typeof APPROVAL_REASON_CODES)[number];

export interface ApprovalDecision {
  readonly schemaVersion: typeof APPROVAL_ENGINE_VERSION;
  readonly id: string;
  readonly state: ApprovalState;
  readonly reasons: readonly [ApprovalReason, ...ApprovalReason[]];
  readonly binding: string | null;
  readonly humanApprovalId: string | null;
  readonly approvalRequestId: string | null;
  readonly decisionId: string | null;
  readonly orderIntentId: string | null;
  readonly riskDecisionId: string | null;
  readonly policyDecisionId: string | null;
  readonly environment: TradingEnvironment | null;
  readonly provenance: ProvenanceStatus | null;
  readonly autonomyLevel: AutonomyLevel | null;
  readonly configId: string | null;
  readonly configVersion: string | null;
  readonly agentRunId: string;
  readonly evaluationRunId: string | null;
  readonly liveExecutionEnabled: false;
  readonly events: readonly TradingEvent[];
}

/** Infrastructure fact. Not a quality score and not an execution. */
export function approvalInfrastructureFact(
  state: ApprovalState,
): "approval_approved" | "approval_rejected" | "approval_blocked" | "approval_invalid" {
  switch (state) {
    case "APPROVED":
      return "approval_approved";
    case "REJECTED":
      return "approval_rejected";
    case "BLOCKED":
      return "approval_blocked";
    case "INVALID":
      return "approval_invalid";
  }
}
