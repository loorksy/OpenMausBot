/** Failures at the XAUUSD trading boundary. Safety-critical results fail closed:
 * the error is thrown, and `failClosed` is true. Nothing in this module
 * turns an unknown state into a successful trade. */

export const TRADING_ERROR_CODES = [
  "instrument_rejected",
  "environment_rejected",
  "environment_transition_rejected",
  "environment_isolation",
  "silent_simulator_fallback",
  "credentials_forbidden",
  "live_execution_disabled",
  "invalid_decision",
  "invalid_evidence",
  "invalid_snapshot",
  "invalid_context",
  "invalid_risk_check",
  "invalid_policy_check",
  "invalid_order_intent",
  "order_intent_not_executable",
  "immutable_revision",
  "agent_run_required",
  "agent_run_mismatch",
  "invalid_version_manifest",
  "invalid_event",
  "reconciliation_unknown",
  "reconciliation_blocks_autonomous",
  "kill_switch_unknown",
  "kill_switch_engaged",
  "autonomy_rejected",
  "risk_engine_not_implemented",
  "policy_engine_not_implemented",
  "execution_gate_not_implemented",
  "reconciliation_not_implemented",
  "kill_switch_runtime_not_implemented",
  "broker_adapter_not_implemented",
  "trading_store_not_implemented",
] as const;

export type TradingErrorCode = (typeof TRADING_ERROR_CODES)[number];

export class TradingDomainError extends Error {
  readonly code: TradingErrorCode;
  /** Unknown and unimplemented safety checks refuse the action. */
  readonly failClosed: true;

  constructor(code: TradingErrorCode, message: string) {
    super(message);
    this.name = "TradingDomainError";
    this.code = code;
    this.failClosed = true;
  }
}

export function tradingError(code: TradingErrorCode, message: string): TradingDomainError {
  return new TradingDomainError(code, message);
}
