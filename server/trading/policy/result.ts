import type { PolicyCheck } from "../../../shared/trading/policy.ts";
import type { TradingEvent } from "../../../shared/trading/events.ts";
import type { AutonomyLevel } from "../../../shared/trading/autonomy.ts";
import { POLICY_ENGINE_VERSION } from "./config.ts";

export const POLICY_STATES = ["ALLOW", "REJECT", "BLOCKED", "INVALID"] as const;

export type PolicyState = (typeof POLICY_STATES)[number];

export const POLICY_PROGRESSIONS = [
  "ELIGIBLE_FOR_FUTURE_EXECUTION",
  "RECOMMENDATION_ONLY",
  "ANALYSIS_ONLY",
  "NONE",
] as const;

export type PolicyProgression = (typeof POLICY_PROGRESSIONS)[number];

export const POLICY_REASON_CODES = [
  "POLICY_ALLOWED",
  "POLICY_RECOMMENDATION_ONLY",
  "POLICY_ANALYSIS_ONLY",
  "AUTONOMY_OBSERVE_ONLY",
  "AUTONOMY_ANALYSIS_ONLY",
  "APPROVAL_REQUIRED",
  "APPROVAL_INVALID",
  "PERMISSION_MISSING",
  "ENVIRONMENT_REJECTED",
  "PROVENANCE_REJECTED",
  "REPLAY_RESEARCH_ONLY",
  "MARKET_DATA_UNAVAILABLE",
  "MARKET_DATA_STALE",
  "KILL_SWITCH_ENGAGED",
  "KILL_SWITCH_UNKNOWN",
  "RISK_NOT_ACCEPTED",
  "INVALID_INSTRUMENT",
  "POLICY_CONFIG_INVALID",
  "AUTONOMY_REJECTED",
  "INTENT_FLAGS_INVALID",
  "CREDENTIALS_FORBIDDEN",
  "INVALID_INPUT",
  "SYSTEM_ERROR",
] as const;

export type PolicyReason = (typeof POLICY_REASON_CODES)[number];

export interface PolicyDecision {
  readonly schemaVersion: typeof POLICY_ENGINE_VERSION;
  readonly id: string;
  readonly state: PolicyState;
  readonly progression: PolicyProgression;
  readonly reasons: readonly [PolicyReason, ...PolicyReason[]];
  readonly check: PolicyCheck | null;
  readonly agentRunId: string;
  readonly evaluationRunId: string | null;
  readonly configId: string | null;
  readonly riskDecisionId: string | null;
  readonly autonomyLevel: AutonomyLevel | null;
  readonly liveExecutionEnabled: false;
  readonly brokerSubmit: false;
  readonly events: readonly TradingEvent[];
}

/** Infrastructure fact for a later evaluation record. Not a quality score. */
export function policyInfrastructureFact(
  state: PolicyState,
): "policy_allowed" | "policy_rejected" | "policy_blocked" | "policy_invalid" {
  switch (state) {
    case "ALLOW":
      return "policy_allowed";
    case "REJECT":
      return "policy_rejected";
    case "BLOCKED":
      return "policy_blocked";
    case "INVALID":
      return "policy_invalid";
  }
}
