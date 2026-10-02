import type { ProvenanceStatus, TradingEnvironment } from "../../../shared/trading/environment.ts";
import type { TradingEvent } from "../../../shared/trading/events.ts";
import { GATE_ENGINE_VERSION } from "./config.ts";

export const GATE_STATES = [
  "ELIGIBLE_FOR_EXECUTION",
  "REJECTED",
  "BLOCKED",
  "INVALID",
  "REQUIRES_RISK_REASSESSMENT",
  "REQUIRES_POLICY_REASSESSMENT",
  "REQUIRES_APPROVAL",
] as const;

export type GateState = (typeof GATE_STATES)[number];

export const GATE_REASON_CODES = [
  "ELIGIBLE",
  "INVALID_INSTRUMENT",
  "INVALID_INPUT",
  "INVALID_DIRECTION",
  "INTENT_NOT_ALLOWED",
  "DIRECTION_MISMATCH",
  "INTENT_FLAGS_INVALID",
  "MISSING_ENTRY",
  "MISSING_STOP",
  "KILL_SWITCH_ENGAGED",
  "KILL_SWITCH_UNKNOWN",
  "PROVENANCE_REJECTED",
  "REPLAY_RESEARCH_ONLY",
  "MARKET_DATA_UNAVAILABLE",
  "MARKET_DATA_STALE",
  "MARKET_TIMESTAMP_FUTURE",
  "ENVIRONMENT_REJECTED",
  "RISK_NOT_ACCEPTED",
  "RISK_FACTS_UNAVAILABLE",
  "REQUIRES_RISK_REASSESSMENT",
  "POLICY_NOT_ELIGIBLE",
  "REQUIRES_POLICY_REASSESSMENT",
  "REQUIRES_APPROVAL",
  "APPROVAL_REJECTED",
  "APPROVAL_MISMATCH",
  "APPROVAL_STALE",
  "APPROVAL_FUTURE",
  "APPROVAL_FRESHNESS_UNCONFIGURED",
  "APPROVAL_CONFIG_INVALID",
  "PROPOSAL_CHANGED",
  "SILENT_REPAIR_REJECTED",
  "PERMISSION_MISSING",
  "AUTONOMY_INSUFFICIENT",
  "GATE_FRESHNESS_UNCONFIGURED",
  "GATE_CONFIG_INVALID",
  "CREDENTIALS_FORBIDDEN",
  "SYSTEM_ERROR",
] as const;

export type GateReason = (typeof GATE_REASON_CODES)[number];

export interface GateDecision {
  readonly schemaVersion: typeof GATE_ENGINE_VERSION;
  readonly id: string;
  readonly state: GateState;
  readonly reasons: readonly [GateReason, ...GateReason[]];
  readonly binding: string | null;
  readonly decisionId: string | null;
  readonly orderIntentId: string | null;
  readonly riskDecisionId: string | null;
  readonly policyDecisionId: string | null;
  readonly approvalId: string | null;
  readonly environment: TradingEnvironment | null;
  readonly provenance: ProvenanceStatus | null;
  readonly gateConfigVersion: string | null;
  readonly evaluatedAt: string | null;
  readonly agentRunId: string;
  readonly evaluationRunId: string | null;
  readonly liveExecutionEnabled: false;
  readonly orderIntentExecutable: false;
  readonly orderIntentBrokerSubmit: false;
  readonly events: readonly TradingEvent[];
}

/** Infrastructure fact. Eligibility is not a fill and not a quality score. */
export function gateInfrastructureFact(
  state: GateState,
):
  | "gate_eligible"
  | "gate_rejected"
  | "gate_blocked"
  | "gate_invalid"
  | "gate_requires_risk_reassessment"
  | "gate_requires_policy_reassessment"
  | "gate_requires_approval" {
  switch (state) {
    case "ELIGIBLE_FOR_EXECUTION":
      return "gate_eligible";
    case "REJECTED":
      return "gate_rejected";
    case "BLOCKED":
      return "gate_blocked";
    case "INVALID":
      return "gate_invalid";
    case "REQUIRES_RISK_REASSESSMENT":
      return "gate_requires_risk_reassessment";
    case "REQUIRES_POLICY_REASSESSMENT":
      return "gate_requires_policy_reassessment";
    case "REQUIRES_APPROVAL":
      return "gate_requires_approval";
  }
}
