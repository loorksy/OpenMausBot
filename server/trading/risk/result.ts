import type { RiskCheck } from "../../../shared/trading/risk.ts";
import type { TradingEvent } from "../../../shared/trading/events.ts";
import type { ProvenanceStatus } from "../../../shared/trading/environment.ts";
import type { MarketFreshness } from "../../../shared/trading/snapshot.ts";
import { RISK_ENGINE_VERSION } from "./config.ts";
import { XAUUSD_CONTRACT_VERSION, XAUUSD_OUNCES_PER_LOT } from "./contract.ts";

export const RISK_STATES = ["ACCEPT", "REJECT", "BLOCKED", "INVALID"] as const;

export type RiskState = (typeof RISK_STATES)[number];

/** Reason codes this engine returns. ACCEPT uses RISK_WITHIN_LIMITS so the
 * Phase 1 check, which requires a reason, stays explicit. */
export const RISK_REASON_CODES = [
  "RISK_WITHIN_LIMITS",
  "INVALID_INSTRUMENT",
  "INVALID_DIRECTION",
  "MISSING_ORDER_INTENT",
  "INTENT_NOT_ALLOWED",
  "DIRECTION_MISMATCH",
  "INTENT_FLAGS_INVALID",
  "MISSING_ENTRY",
  "INVALID_ENTRY",
  "MISSING_STOP",
  "INVALID_STOP",
  "INCONSISTENT_STOP",
  "STOP_WRONG_SIDE",
  "ZERO_RISK_DISTANCE",
  "TARGET_WRONG_SIDE",
  "INCONSISTENT_TARGET",
  "INVALID_EQUITY",
  "ACCOUNT_STATE_UNAVAILABLE",
  "ACCOUNT_STATE_STALE",
  "MARKET_DATA_UNAVAILABLE",
  "MARKET_DATA_STALE",
  "RISK_CONFIG_INVALID",
  "RISK_BUDGET_EXCEEDED",
  "POSITION_SIZE_EXCEEDED",
  "EXPOSURE_LIMIT_EXCEEDED",
  "UNKNOWN_EXISTING_EXPOSURE",
  "NO_OPEN_POSITION",
  "QUANTITY_INVALID",
  "QUANTITY_STEP_INVALID",
  "SPREAD_LIMIT_EXCEEDED",
  "ENVIRONMENT_MISMATCH",
  "CREDENTIALS_FORBIDDEN",
  "INVALID_INPUT",
  "SYSTEM_ERROR",
] as const;

export type RiskReason = (typeof RISK_REASON_CODES)[number];

export interface RiskTrace {
  readonly equity: number | null;
  readonly maxRiskPercent: number | null;
  readonly riskBudget: number | null;
  readonly entry: number | null;
  readonly stop: number | null;
  readonly stopDistance: number | null;
  readonly contractSize: typeof XAUUSD_OUNCES_PER_LOT;
  readonly riskPerLot: number | null;
  readonly requestedQuantity: number | null;
  readonly calculatedMaximumQuantity: number | null;
  readonly acceptedQuantity: number | null;
  readonly rejectedQuantity: number | null;
  readonly resultingRiskAmount: number | null;
  readonly resultingRiskPercent: number | null;
  readonly openExposureLots: number | null;
  readonly configVersion: string | null;
  readonly contractVersion: typeof XAUUSD_CONTRACT_VERSION;
  readonly roundingMode: "none" | "floor" | null;
  readonly quantityStep: number | null;
  readonly accountProvenance: ProvenanceStatus | null;
  readonly marketProvenance: ProvenanceStatus | null;
  readonly marketFreshness: MarketFreshness | null;
}

export interface RiskDecision {
  readonly schemaVersion: typeof RISK_ENGINE_VERSION;
  readonly id: string;
  readonly state: RiskState;
  readonly reasons: readonly [RiskReason, ...RiskReason[]];
  readonly check: RiskCheck | null;
  readonly trace: RiskTrace;
  readonly agentRunId: string;
  readonly evaluationRunId: string | null;
  readonly configId: string | null;
  readonly decisionId: string | null;
  readonly orderIntentId: string | null;
  readonly snapshotId: string | null;
  readonly liveExecutionEnabled: false;
  readonly events: readonly TradingEvent[];
}

/** Infrastructure fact for a later evaluation record. Not a quality score. */
export function riskInfrastructureFact(
  state: RiskState,
): "risk_accepted" | "risk_rejected" | "risk_blocked" | "risk_invalid" {
  switch (state) {
    case "ACCEPT":
      return "risk_accepted";
    case "REJECT":
      return "risk_rejected";
    case "BLOCKED":
      return "risk_blocked";
    case "INVALID":
      return "risk_invalid";
  }
}
