import type { DatabaseSync } from "node:sqlite";

import type { ProvenanceStatus, TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { assertNoSecretFields, recordIdSchema, seal, utcTimestampSchema } from "../../../shared/trading/ids.ts";
import { XAUUSD_INSTRUMENT } from "../../../shared/trading/instrument.ts";
import {
  parseOccurrenceDomainStatus,
  routineAgentRunId,
  routineOccurrenceId,
  type OccurrenceDomainStatus,
} from "../occurrence/identity.ts";

const INSERT_KEYS = new Set(["routineId", "routineRunId", "threadId", "environment", "startedAt"]);

/** Correlation receipt for one native routine run. It does not schedule,
 * execute, or store authoritative trading bodies. */
export interface TradingOccurrence {
  readonly occurrenceId: string;
  readonly routineId: string;
  readonly routineRunId: string;
  readonly threadId: string;
  readonly providerTurnId: string | null;
  readonly agentRunId: string;
  readonly instrument: "XAUUSD";
  readonly environment: TradingEnvironment;
  readonly provenance: ProvenanceStatus | null;
  readonly snapshotId: string | null;
  readonly decisionId: string | null;
  readonly orderIntentId: string | null;
  readonly riskDecisionId: string | null;
  readonly policyDecisionId: string | null;
  readonly approvalId: string | null;
  readonly executionRequestId: string | null;
  readonly reconciliationRunId: string | null;
  readonly proposalBindingHash: string | null;
  readonly domainStatus: OccurrenceDomainStatus;
  readonly failureCode: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export interface RoutineOccurrenceInsert {
  readonly routineId: string;
  readonly routineRunId: string;
  readonly threadId: string;
  readonly environment: TradingEnvironment;
  readonly startedAt: string;
}

export interface OccurrenceRepository {
  insertRoutineOccurrence(input: RoutineOccurrenceInsert): TradingOccurrence;
  readByRoutineRun(routineRunId: string): TradingOccurrence | null;
}

interface OccurrenceRow {
  occurrence_id: string;
  routine_id: string;
  routine_run_id: string;
  thread_id: string;
  provider_turn_id: string | null;
  agent_run_id: string;
  instrument: string;
  environment: TradingEnvironment;
  provenance: ProvenanceStatus | null;
  snapshot_id: string | null;
  decision_id: string | null;
  order_intent_id: string | null;
  risk_decision_id: string | null;
  policy_decision_id: string | null;
  approval_id: string | null;
  execution_request_id: string | null;
  reconciliation_run_id: string | null;
  proposal_binding_hash: string | null;
  domain_status: string;
  failure_code: string | null;
  started_at: string;
  completed_at: string | null;
}

export function createOccurrenceRepository(db: DatabaseSync, environment: TradingEnvironment): OccurrenceRepository {
  return {
    insertRoutineOccurrence(input) {
      const row = occurrenceFromInsert(input, environment);
      assertNoSecretFields(row, "trading occurrence");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`
          INSERT INTO trading_occurrences (
            occurrence_id, routine_id, routine_run_id, thread_id, provider_turn_id, agent_run_id,
            instrument, environment, provenance, snapshot_id, decision_id, order_intent_id,
            risk_decision_id, policy_decision_id, approval_id, execution_request_id, reconciliation_run_id,
            proposal_binding_hash, domain_status, failure_code, started_at, completed_at
          ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, NULL)
        `).run(
          row.occurrenceId,
          row.routineId,
          row.routineRunId,
          row.threadId,
          row.agentRunId,
          row.instrument,
          row.environment,
          row.domainStatus,
          row.startedAt,
        );
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The occurrence transaction is already closed.
        }
        if (error instanceof TradingDomainError) throw error;
        throw new TradingDomainError(
          "trading_store_rejected",
          "Trading occurrence was rejected. Failing closed.",
        );
      }
      return row;
    },
    readByRoutineRun(routineRunId) {
      if (!recordIdSchema.safeParse(routineRunId).success) return null;
      const stored = db.prepare(`
        SELECT
          occurrence_id, routine_id, routine_run_id, thread_id, provider_turn_id, agent_run_id,
          instrument, environment, provenance, snapshot_id, decision_id, order_intent_id,
          risk_decision_id, policy_decision_id, approval_id, execution_request_id, reconciliation_run_id,
          proposal_binding_hash, domain_status, failure_code, started_at, completed_at
        FROM trading_occurrences
        WHERE routine_run_id = ?
      `).get(routineRunId) as OccurrenceRow | undefined;
      return stored === undefined ? null : seal(fromRow(stored));
    },
  };
}

function occurrenceFromInsert(input: RoutineOccurrenceInsert, storeEnvironment: TradingEnvironment): TradingOccurrence {
  assertNoSecretFields(input, "trading occurrence");
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TradingDomainError("trading_store_rejected", "Trading occurrence was rejected. Failing closed.");
  }
  for (const key of Object.keys(input)) {
    if (!INSERT_KEYS.has(key)) {
      throw new TradingDomainError("trading_store_rejected", "Trading occurrence contains an unsupported field. Failing closed.");
    }
  }
  if (!recordIdSchema.safeParse(input.routineId).success || !recordIdSchema.safeParse(input.threadId).success) {
    throw new TradingDomainError("trading_store_rejected", "Trading occurrence identity was rejected. Failing closed.");
  }
  if (!utcTimestampSchema.safeParse(input.startedAt).success) {
    throw new TradingDomainError("trading_store_rejected", "Trading occurrence timestamp was rejected. Failing closed.");
  }
  if (input.environment !== storeEnvironment) {
    throw new TradingDomainError(
      "trading_store_rejected",
      "Trading occurrence environment does not match the store partition. Failing closed.",
    );
  }
  const domainStatus = parseOccurrenceDomainStatus("turn_not_started");
  return seal({
    occurrenceId: routineOccurrenceId(input.routineRunId),
    routineId: input.routineId,
    routineRunId: input.routineRunId,
    threadId: input.threadId,
    providerTurnId: null,
    agentRunId: routineAgentRunId(input.routineRunId),
    instrument: XAUUSD_INSTRUMENT,
    environment: input.environment,
    provenance: null,
    snapshotId: null,
    decisionId: null,
    orderIntentId: null,
    riskDecisionId: null,
    policyDecisionId: null,
    approvalId: null,
    executionRequestId: null,
    reconciliationRunId: null,
    proposalBindingHash: null,
    domainStatus,
    failureCode: null,
    startedAt: input.startedAt,
    completedAt: null,
  });
}

function fromRow(row: OccurrenceRow): TradingOccurrence {
  if (row.instrument !== XAUUSD_INSTRUMENT) {
    throw new TradingDomainError("instrument_rejected", "The trading domain accepts only XAUUSD");
  }
  return {
    occurrenceId: row.occurrence_id,
    routineId: row.routine_id,
    routineRunId: row.routine_run_id,
    threadId: row.thread_id,
    providerTurnId: row.provider_turn_id,
    agentRunId: row.agent_run_id,
    instrument: "XAUUSD",
    environment: row.environment,
    provenance: row.provenance,
    snapshotId: row.snapshot_id,
    decisionId: row.decision_id,
    orderIntentId: row.order_intent_id,
    riskDecisionId: row.risk_decision_id,
    policyDecisionId: row.policy_decision_id,
    approvalId: row.approval_id,
    executionRequestId: row.execution_request_id,
    reconciliationRunId: row.reconciliation_run_id,
    proposalBindingHash: row.proposal_binding_hash,
    domainStatus: parseOccurrenceDomainStatus(row.domain_status),
    failureCode: row.failure_code,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}
