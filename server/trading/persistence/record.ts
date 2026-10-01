import type { ProvenanceStatus, TradingEnvironment } from "../../../shared/trading/environment.ts";
import type { ExecutionAttemptRecord } from "../execution/ledger.ts";
import { EXECUTION_ENGINE_VERSION } from "../execution/result.ts";

/** Authorized request as it was reserved. Later attempts do not rewrite it. */
export interface PersistedExecutionRequest {
  readonly schemaVersion: typeof EXECUTION_ENGINE_VERSION;
  readonly executionRequestId: string;
  readonly executionIdentity: string;
  readonly agentRunId: string;
  readonly decisionId: string;
  readonly orderIntentId: string;
  readonly riskDecisionId: string;
  readonly policyDecisionId: string;
  readonly approvalDecisionId: string;
  readonly gateId: string;
  readonly bindingId: string;
  readonly environment: TradingEnvironment;
  readonly provenance: ProvenanceStatus;
  readonly instrument: "XAUUSD";
  readonly direction: "LONG" | "SHORT";
  readonly entry: number;
  readonly stop: number;
  readonly takeProfit: number | null;
  readonly requestedQuantity: number | null;
  readonly acceptedQuantity: number;
  readonly targets: readonly number[];
  readonly proposalBinding: string;
  readonly gateState: string;
  readonly clientId: string;
  readonly submittedAt: string;
}

export function requestFromAttempt(record: ExecutionAttemptRecord): PersistedExecutionRequest {
  return {
    schemaVersion: EXECUTION_ENGINE_VERSION,
    executionRequestId: record.executionRequestId,
    executionIdentity: record.executionIdentity,
    agentRunId: record.agentRunId,
    decisionId: record.decisionId,
    orderIntentId: record.orderIntentId,
    riskDecisionId: record.riskDecisionId,
    policyDecisionId: record.policyDecisionId,
    approvalDecisionId: record.approvalDecisionId,
    gateId: record.gateId,
    bindingId: record.bindingId,
    environment: record.environment,
    provenance: record.provenance,
    instrument: "XAUUSD",
    direction: record.direction,
    entry: record.entry,
    stop: record.stop,
    takeProfit: record.takeProfit,
    requestedQuantity: record.requestedQuantity,
    acceptedQuantity: record.quantity,
    targets: record.targets,
    proposalBinding: record.proposalBinding,
    gateState: record.gateState,
    clientId: record.clientId,
    submittedAt: record.submittedAt,
  };
}
