import { z } from "zod";

import { TradingDomainError } from "./errors.ts";

/** Ledger-versus-broker states. DESYNCED and UNKNOWN block autonomous orders.
 * An unrecognized value fails closed instead of being treated as healthy.
 * DEGRADED is a known state; later policy decides what it permits. */
export const RECONCILIATION_STATES = ["RECONCILED", "DEGRADED", "DESYNCED", "UNKNOWN"] as const;

export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];

const reconciliationStateSchema = z.enum(RECONCILIATION_STATES);

export function parseReconciliationState(value: unknown): ReconciliationState {
  const parsed = reconciliationStateSchema.safeParse(value);
  if (!parsed.success) {
    throw new TradingDomainError("reconciliation_unknown", "Unknown reconciliation state fails closed");
  }
  return parsed.data;
}

/** Invariant: DESYNCED and UNKNOWN block autonomous orders. */
export function autonomousOrdersBlocked(state: ReconciliationState): boolean {
  return state === "DESYNCED" || state === "UNKNOWN";
}

export function assertAutonomousOrdersAllowed(state: ReconciliationState): void {
  if (autonomousOrdersBlocked(state)) {
    throw new TradingDomainError(
      "reconciliation_blocks_autonomous",
      `${state} reconciliation blocks autonomous orders`,
    );
  }
}
