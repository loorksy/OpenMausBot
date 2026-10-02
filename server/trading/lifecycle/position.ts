import type { ExecutionState } from "../execution/result.ts";
import type { ReconciliationState } from "../../../shared/trading/reconciliation.ts";

/** Display of broker and ledger facts. It does not submit or repair. */
export const POSITION_LIFECYCLE_STATES = [
  "NO_POSITION",
  "POSITION_PENDING",
  "POSITION_OPEN",
  "POSITION_PARTIALLY_OPEN",
  "POSITION_CLOSING",
  "POSITION_CLOSED",
  "POSITION_UNKNOWN",
  "POSITION_DESYNCED",
] as const;

export type PositionLifecycleState = (typeof POSITION_LIFECYCLE_STATES)[number];

export interface PositionLifecycleInput {
  readonly executionState: ExecutionState | null;
  readonly reconciliationState: ReconciliationState | null;
  readonly brokerPositionId: string | null;
  readonly brokerQuantity: number | null;
  readonly authorizedQuantity: number | null;
  readonly exitState: ExecutionState | null;
  readonly ambiguous: boolean;
}

/** One XAUUSD broker position, or an explicit ambiguity. Foreign symbols stay out. */
export function selectBrokerPosition(positions: readonly {
  readonly positionId: string;
  readonly symbol: string;
  readonly direction: string | null;
  readonly volume: number;
}[]): { readonly ambiguous: true } | { readonly ambiguous: false; readonly positionId: string | null; readonly direction: "LONG" | "SHORT" | null; readonly quantity: number | null } {
  const own = positions.filter((item) => item.symbol === "XAUUSD");
  const usable = (item: (typeof own)[number]): item is { positionId: string; symbol: string; direction: "LONG" | "SHORT"; volume: number } =>
    item.positionId.trim().length > 0
    && (item.direction === "LONG" || item.direction === "SHORT")
    && Number.isFinite(item.volume)
    && item.volume > 0;
  if (own.length > 1 || own.some((item) => !usable(item))) return { ambiguous: true };
  const one = own[0];
  if (one === undefined || !usable(one)) {
    return { ambiguous: false, positionId: null, direction: null, quantity: null };
  }
  return { ambiguous: false, positionId: one.positionId, direction: one.direction, quantity: one.volume };
}

/** Accepted is not open. A fill is not a position until reconciliation names
 * one broker position. A partial quantity stays partial and is not repaired. */
export function derivePositionLifecycle(input: PositionLifecycleInput): PositionLifecycleState {
  if (input.ambiguous || input.reconciliationState === "DESYNCED") return "POSITION_DESYNCED";
  if (input.reconciliationState === "UNKNOWN" || input.executionState === "SUBMISSION_UNKNOWN" || input.exitState === "SUBMISSION_UNKNOWN") {
    return "POSITION_UNKNOWN";
  }
  const present = input.brokerPositionId !== null && input.brokerQuantity !== null && input.brokerQuantity > 0;
  if (input.exitState === "FILL_REPORTED" && input.reconciliationState === "RECONCILED" && !present) return "POSITION_CLOSED";
  if (input.exitState === "SUBMISSION_ACCEPTED" && present) return "POSITION_CLOSING";
  if (input.reconciliationState === "DEGRADED" && present) return "POSITION_PARTIALLY_OPEN";
  if (
    present
    && input.authorizedQuantity !== null
    && input.brokerQuantity !== null
    && input.brokerQuantity < input.authorizedQuantity
  ) return "POSITION_PARTIALLY_OPEN";
  if (present && input.reconciliationState === "RECONCILED") return "POSITION_OPEN";
  if (input.executionState === "SUBMISSION_ACCEPTED" && !present) return "POSITION_PENDING";
  if (input.executionState === "FILL_REPORTED" && !present) return "POSITION_UNKNOWN";
  if (!present) return "NO_POSITION";
  return "POSITION_UNKNOWN";
}
