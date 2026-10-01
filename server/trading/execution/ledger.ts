import type { ProvenanceStatus, TradingEnvironment } from "../../../shared/trading/environment.ts";
import type { TradingEvent } from "../../../shared/trading/events.ts";
import { executionAttemptKey } from "./identity.ts";
import { EXECUTION_ENGINE_VERSION, type ExecutionFill, type ExecutionState } from "./result.ts";

/** One immutable attempt. A later outcome is a new record, not an edit.
 * The ledger is caller-owned. It is not broker truth. */
export interface ExecutionAttemptRecord {
  readonly schemaVersion: typeof EXECUTION_ENGINE_VERSION;
  readonly executionAttemptId: string;
  readonly executionRequestId: string;
  readonly executionIdentity: string;
  readonly sequence: number;
  readonly agentRunId: string;
  readonly decisionId: string;
  readonly orderIntentId: string;
  readonly riskDecisionId: string;
  readonly policyDecisionId: string;
  readonly approvalDecisionId: string;
  readonly gateId: string;
  readonly gateState: string;
  readonly bindingId: string;
  readonly proposalBinding: string;
  readonly environment: TradingEnvironment;
  readonly provenance: ProvenanceStatus;
  readonly direction: "LONG" | "SHORT";
  readonly entry: number;
  readonly stop: number;
  readonly takeProfit: number | null;
  readonly targets: readonly number[];
  readonly requestedQuantity: number | null;
  readonly quantity: number;
  readonly clientId: string;
  readonly state: ExecutionState;
  readonly brokerRequestId: string | null;
  readonly brokerCode: string | null;
  readonly fill: ExecutionFill | null;
  readonly submittedAt: string;
  readonly responseAt: string | null;
}

export interface ExecutionLedger {
  find(identity: string): ExecutionAttemptRecord | null;
  reserve(record: ExecutionAttemptRecord): boolean;
  complete(record: ExecutionAttemptRecord): boolean;
  appendEvents?(events: readonly TradingEvent[]): void;
}

/** In-process duplicate guard. The first row stays UNKNOWN. Completion appends
 * a later sequence. This map does not survive a process restart. */
export function createMemoryExecutionLedger(): ExecutionLedger {
  const records = new Map<string, ExecutionAttemptRecord[]>();
  return {
    find(identity) {
      const list = records.get(identity);
      if (list === undefined || list.length === 0) return null;
      return list[list.length - 1] ?? null;
    },
    reserve(record) {
      if (records.has(record.executionIdentity)) return false;
      records.set(record.executionIdentity, [freezeAttempt(record, 1, null)]);
      return true;
    },
    complete(record) {
      const list = records.get(record.executionIdentity);
      const existing = list?.[list.length - 1];
      if (
        list === undefined
        || existing === undefined
        || existing.state !== "SUBMISSION_UNKNOWN"
        || existing.executionRequestId !== record.executionRequestId
      ) {
        return false;
      }
      list.push(freezeAttempt(record, existing.sequence + 1, record.submittedAt));
      return true;
    },
  };
}

function freezeAttempt(
  record: ExecutionAttemptRecord,
  sequence: number,
  responseAt: string | null,
): ExecutionAttemptRecord {
  return Object.freeze({
    ...record,
    sequence,
    responseAt,
    executionAttemptId: executionAttemptKey({
      executionIdentity: record.executionIdentity,
      executionRequestId: record.executionRequestId,
      sequence,
      state: record.state,
    }),
    targets: Object.freeze([...record.targets]),
    fill: record.fill === null ? null : Object.freeze({ ...record.fill }),
  });
}
