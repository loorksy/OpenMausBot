import { TradingDomainError, type TradingErrorCode } from "../../../shared/trading/errors.ts";

/** Explicit not-implemented boundaries. Each one throws. None of them returns
 * a passed check, a fill, or a broker acknowledgement. */

function unimplemented(code: TradingErrorCode, message: string): () => never {
  return () => {
    throw new TradingDomainError(code, message);
  };
}

export const foundationControl = {
  implemented: false as const,
  assessRisk: unimplemented(
    "risk_engine_not_implemented",
    "Risk assessment is not implemented. Failing closed.",
  ),
  assessPolicy: unimplemented(
    "policy_engine_not_implemented",
    "Policy evaluation is not implemented. Failing closed.",
  ),
  runExecutionGate: unimplemented(
    "execution_gate_not_implemented",
    "The execution gate is not implemented. Failing closed.",
  ),
  reconcile: unimplemented(
    "reconciliation_not_implemented",
    "Broker reconciliation is not implemented. Failing closed.",
  ),
  enforceKillSwitch: unimplemented(
    "kill_switch_runtime_not_implemented",
    "Kill-switch runtime enforcement is not implemented. Failing closed.",
  ),
  submitToBroker: unimplemented(
    "broker_adapter_not_implemented",
    "Broker submission is not implemented. Failing closed.",
  ),
} as const;
