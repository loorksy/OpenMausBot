import type { ProvenanceStatus, TradingEnvironment } from "../../../shared/trading/environment.ts";
import { EXECUTION_ENGINE_VERSION, type ExecutionFill, type ExecutionState } from "./result.ts";

/** One immutable attempt. The ledger is caller-owned. It is not a broker reconciliation. */
export interface ExecutionAttemptRecord {
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
  readonly direction: "LONG" | "SHORT";
  readonly entry: number;
  readonly stop: number;
  readonly takeProfit: number | null;
  readonly quantity: number;
  readonly state: ExecutionState;
  readonly brokerRequestId: string | null;
  readonly fill: ExecutionFill | null;
  readonly submittedAt: string;
}

export interface ExecutionLedger {
  find(identity: string): ExecutionAttemptRecord | null;
  reserve(record: ExecutionAttemptRecord): boolean;
  complete(record: ExecutionAttemptRecord): boolean;
}

/** In-process duplicate guard. A reserved attempt starts as UNKNOWN so a second
 * call cannot submit while the first response is unresolved. Records are frozen. */
export function createMemoryExecutionLedger(): ExecutionLedger {
  const records = new Map<string, ExecutionAttemptRecord>();
  return {
    find(identity) {
      return records.get(identity) ?? null;
    },
    reserve(record) {
      if (records.has(record.executionIdentity)) return false;
      records.set(record.executionIdentity, Object.freeze({ ...record }));
      return true;
    },
    complete(record) {
      const existing = records.get(record.executionIdentity);
      if (
        existing === undefined
        || existing.state !== "SUBMISSION_UNKNOWN"
        || existing.executionRequestId !== record.executionRequestId
      ) {
        return false;
      }
      records.set(record.executionIdentity, Object.freeze({ ...record, fill: record.fill === null ? null : Object.freeze({ ...record.fill }) }));
      return true;
    },
  };
}
