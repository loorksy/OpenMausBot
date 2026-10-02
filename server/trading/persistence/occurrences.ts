import type { DatabaseSync } from "node:sqlite";

import { tradingEnvironmentSchema, type ProvenanceStatus, type TradingEnvironment } from "../../../shared/trading/environment.ts";
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

export interface ProviderTurnAttach {
  readonly routineId: string;
  readonly routineRunId: string;
  readonly threadId: string;
  readonly providerTurnId: string;
}

/** Reference ids only. The occurrence does not store a second copy of the
 * risk, policy, approval, or gate record. */
export interface EligibilityReferenceWrite {
  readonly occurrenceId: string;
  readonly agentRunId: string;
  readonly environment: TradingEnvironment;
  readonly decisionId: string | null;
  readonly orderIntentId: string | null;
  readonly riskDecisionId: string | null;
  readonly policyDecisionId: string | null;
  readonly approvalId: string | null;
  readonly proposalBindingHash: string | null;
  readonly failureCode: string | null;
}

/** Correlation for one authorized execution request. It does not store the
 * broker payload or a second copy of the execution attempt. */
export interface ExecutionReceiptWrite {
  readonly occurrenceId: string;
  readonly agentRunId: string;
  readonly environment: TradingEnvironment;
  readonly executionRequestId: string;
  readonly failureCode: string | null;
  readonly domainStatus: "submitted_unknown" | null;
}

export interface OccurrenceRepository {
  insertRoutineOccurrence(input: RoutineOccurrenceInsert): TradingOccurrence;
  readByRoutineRun(routineRunId: string): TradingOccurrence | null;
  readByOccurrenceId(occurrenceId: string): TradingOccurrence | null;
  attachProviderTurn(input: ProviderTurnAttach): TradingOccurrence;
  attachEligibilityReferences(input: EligibilityReferenceWrite): TradingOccurrence;
  attachExecutionReceipt(input: ExecutionReceiptWrite): TradingOccurrence;
}

const ATTACH_KEYS = new Set(["routineId", "routineRunId", "threadId", "providerTurnId"]);
const REFERENCE_KEYS = new Set([
  "occurrenceId",
  "agentRunId",
  "environment",
  "decisionId",
  "orderIntentId",
  "riskDecisionId",
  "policyDecisionId",
  "approvalId",
  "proposalBindingHash",
  "failureCode",
]);
const RECEIPT_KEYS = new Set([
  "occurrenceId",
  "agentRunId",
  "environment",
  "executionRequestId",
  "failureCode",
  "domainStatus",
]);

/** Zero matches and more than one match both fail closed. */
export function requireSingleCorrelation<T>(matches: readonly T[]): T {
  if (matches.length !== 1) {
    throw new TradingDomainError(
      "trading_store_rejected",
      "XAUUSD routine correlation did not match exactly one occurrence. Failing closed.",
    );
  }
  return matches[0] as T;
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
    readByOccurrenceId(occurrenceId) {
      if (!recordIdSchema.safeParse(occurrenceId).success) return null;
      const stored = db.prepare(`
        SELECT
          occurrence_id, routine_id, routine_run_id, thread_id, provider_turn_id, agent_run_id,
          instrument, environment, provenance, snapshot_id, decision_id, order_intent_id,
          risk_decision_id, policy_decision_id, approval_id, execution_request_id, reconciliation_run_id,
          proposal_binding_hash, domain_status, failure_code, started_at, completed_at
        FROM trading_occurrences
        WHERE occurrence_id = ?
      `).get(occurrenceId) as OccurrenceRow | undefined;
      return stored === undefined ? null : seal(fromRow(stored));
    },
    attachProviderTurn(input) {
      assertNoSecretFields(input, "trading occurrence");
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new TradingDomainError("trading_store_rejected", "Provider turn correlation was rejected. Failing closed.");
      }
      for (const key of Object.keys(input)) {
        if (!ATTACH_KEYS.has(key)) {
          throw new TradingDomainError("trading_store_rejected", "Provider turn correlation contains an unsupported field. Failing closed.");
        }
      }
      if (!recordIdSchema.safeParse(input.providerTurnId).success) {
        throw new TradingDomainError("trading_store_rejected", "Provider turn id was rejected. Failing closed.");
      }
      const matches = db.prepare(`
        SELECT
          occurrence_id, routine_id, routine_run_id, thread_id, provider_turn_id, agent_run_id,
          instrument, environment, provenance, snapshot_id, decision_id, order_intent_id,
          risk_decision_id, policy_decision_id, approval_id, execution_request_id, reconciliation_run_id,
          proposal_binding_hash, domain_status, failure_code, started_at, completed_at
        FROM trading_occurrences
        WHERE routine_id = ? AND routine_run_id = ? AND thread_id = ?
      `).all(input.routineId, input.routineRunId, input.threadId) as unknown as OccurrenceRow[];
      const current = requireSingleCorrelation(matches);
      if (current.provider_turn_id === input.providerTurnId) return seal(fromRow(current));
      if (current.provider_turn_id != null) {
        throw new TradingDomainError(
          "trading_store_rejected",
          "Provider turn correlation already differs. Failing closed.",
        );
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db.prepare(`
          UPDATE trading_occurrences
          SET provider_turn_id = ?
          WHERE occurrence_id = ? AND provider_turn_id IS NULL
        `).run(input.providerTurnId, current.occurrence_id);
        if (result.changes !== 1) {
          throw new TradingDomainError(
            "trading_store_rejected",
            "Provider turn correlation was rejected. Failing closed.",
          );
        }
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
          "Provider turn correlation was rejected. Failing closed.",
        );
      }
      const stored = db.prepare(`
        SELECT
          occurrence_id, routine_id, routine_run_id, thread_id, provider_turn_id, agent_run_id,
          instrument, environment, provenance, snapshot_id, decision_id, order_intent_id,
          risk_decision_id, policy_decision_id, approval_id, execution_request_id, reconciliation_run_id,
          proposal_binding_hash, domain_status, failure_code, started_at, completed_at
        FROM trading_occurrences
        WHERE occurrence_id = ?
      `).get(current.occurrence_id) as OccurrenceRow | undefined;
      if (!stored || stored.provider_turn_id !== input.providerTurnId) {
        throw new TradingDomainError(
          "trading_store_rejected",
          "Provider turn correlation was rejected. Failing closed.",
        );
      }
      return seal(fromRow(stored));
    },
    attachEligibilityReferences(input) {
      assertNoSecretFields(input, "trading occurrence");
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new TradingDomainError("trading_store_rejected", "Eligibility correlation was rejected. Failing closed.");
      }
      for (const key of Object.keys(input)) {
        if (!REFERENCE_KEYS.has(key)) {
          throw new TradingDomainError("trading_store_rejected", "Eligibility correlation contains an unsupported field. Failing closed.");
        }
      }
      const decisionId = nullableReference(input.decisionId, "Decision id");
      const orderIntentId = nullableReference(input.orderIntentId, "Order intent id");
      const riskDecisionId = nullableReference(input.riskDecisionId, "Risk decision id");
      const policyDecisionId = nullableReference(input.policyDecisionId, "Policy decision id");
      const approvalId = nullableReference(input.approvalId, "Approval id");
      const proposalBindingHash = nullableReference(input.proposalBindingHash, "Proposal binding");
      const failureCode = nullableFailure(input.failureCode);
      if (!recordIdSchema.safeParse(input.occurrenceId).success || !recordIdSchema.safeParse(input.agentRunId).success) {
        throw new TradingDomainError("trading_store_rejected", "Eligibility correlation identity was rejected. Failing closed.");
      }
      const environment = tradingEnvironmentSchema.safeParse(input.environment);
      if (!environment.success) {
        throw new TradingDomainError("trading_store_rejected", "Eligibility correlation environment was rejected. Failing closed.");
      }
      const current = db.prepare(`
        SELECT
          occurrence_id, routine_id, routine_run_id, thread_id, provider_turn_id, agent_run_id,
          instrument, environment, provenance, snapshot_id, decision_id, order_intent_id,
          risk_decision_id, policy_decision_id, approval_id, execution_request_id, reconciliation_run_id,
          proposal_binding_hash, domain_status, failure_code, started_at, completed_at
        FROM trading_occurrences
        WHERE occurrence_id = ?
      `).get(input.occurrenceId) as OccurrenceRow | undefined;
      if (current === undefined) {
        throw new TradingDomainError("trading_store_rejected", "Eligibility correlation matched no occurrence. Failing closed.");
      }
      if (current.agent_run_id !== input.agentRunId) {
        throw new TradingDomainError("agent_run_mismatch", "Eligibility correlation agent run does not match. Failing closed.");
      }
      if (current.environment !== environment.data) {
        throw new TradingDomainError("trading_store_rejected", "Eligibility correlation environment does not match. Failing closed.");
      }
      agree(current.decision_id, decisionId);
      agree(current.order_intent_id, orderIntentId);
      agree(current.risk_decision_id, riskDecisionId);
      agree(current.policy_decision_id, policyDecisionId);
      agree(current.approval_id, approvalId);
      agree(current.proposal_binding_hash, proposalBindingHash);
      agree(current.failure_code, failureCode);
      const preserved = {
        providerTurnId: current.provider_turn_id,
        executionRequestId: current.execution_request_id,
        reconciliationRunId: current.reconciliation_run_id,
        domainStatus: current.domain_status,
      };
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`
          UPDATE trading_occurrences
          SET decision_id = COALESCE(decision_id, ?),
              order_intent_id = COALESCE(order_intent_id, ?),
              risk_decision_id = COALESCE(risk_decision_id, ?),
              policy_decision_id = COALESCE(policy_decision_id, ?),
              approval_id = COALESCE(approval_id, ?),
              proposal_binding_hash = COALESCE(proposal_binding_hash, ?),
              failure_code = COALESCE(failure_code, ?)
          WHERE occurrence_id = ?
            AND agent_run_id = ?
            AND environment = ?
            AND (decision_id IS NULL OR decision_id = ?)
            AND (order_intent_id IS NULL OR order_intent_id = ?)
            AND (risk_decision_id IS NULL OR risk_decision_id = ?)
            AND (policy_decision_id IS NULL OR policy_decision_id = ?)
            AND (approval_id IS NULL OR approval_id = ?)
            AND (proposal_binding_hash IS NULL OR proposal_binding_hash = ?)
            AND (failure_code IS NULL OR failure_code = ?)
        `).run(
          decisionId,
          orderIntentId,
          riskDecisionId,
          policyDecisionId,
          approvalId,
          proposalBindingHash,
          failureCode,
          input.occurrenceId,
          input.agentRunId,
          environment.data,
          decisionId,
          orderIntentId,
          riskDecisionId,
          policyDecisionId,
          approvalId,
          proposalBindingHash,
          failureCode,
        );
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The occurrence transaction is already closed.
        }
        if (error instanceof TradingDomainError) throw error;
        throw new TradingDomainError("trading_store_rejected", "Eligibility correlation was rejected. Failing closed.");
      }
      const stored = db.prepare(`
        SELECT
          occurrence_id, routine_id, routine_run_id, thread_id, provider_turn_id, agent_run_id,
          instrument, environment, provenance, snapshot_id, decision_id, order_intent_id,
          risk_decision_id, policy_decision_id, approval_id, execution_request_id, reconciliation_run_id,
          proposal_binding_hash, domain_status, failure_code, started_at, completed_at
        FROM trading_occurrences
        WHERE occurrence_id = ?
      `).get(input.occurrenceId) as OccurrenceRow | undefined;
      if (
        stored === undefined
        || stored.decision_id !== (current.decision_id ?? decisionId)
        || stored.order_intent_id !== (current.order_intent_id ?? orderIntentId)
        || stored.risk_decision_id !== (current.risk_decision_id ?? riskDecisionId)
        || stored.policy_decision_id !== (current.policy_decision_id ?? policyDecisionId)
        || stored.approval_id !== (current.approval_id ?? approvalId)
        || stored.proposal_binding_hash !== (current.proposal_binding_hash ?? proposalBindingHash)
        || stored.failure_code !== (current.failure_code ?? failureCode)
        || stored.provider_turn_id !== preserved.providerTurnId
        || stored.execution_request_id !== preserved.executionRequestId
        || stored.reconciliation_run_id !== preserved.reconciliationRunId
        || stored.domain_status !== preserved.domainStatus
      ) {
        throw new TradingDomainError("immutable_revision", "Eligibility correlation already differs. Failing closed.");
      }
      return seal(fromRow(stored));
    },
    attachExecutionReceipt(input) {
      assertNoSecretFields(input, "trading occurrence");
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new TradingDomainError("trading_store_rejected", "Execution receipt was rejected. Failing closed.");
      }
      for (const key of Object.keys(input)) {
        if (!RECEIPT_KEYS.has(key)) {
          throw new TradingDomainError("trading_store_rejected", "Execution receipt contains an unsupported field. Failing closed.");
        }
      }
      const executionRequestId = nullableReference(input.executionRequestId, "Execution request id");
      const failureCode = nullableFailure(input.failureCode);
      if (executionRequestId === null || !recordIdSchema.safeParse(input.occurrenceId).success || !recordIdSchema.safeParse(input.agentRunId).success) {
        throw new TradingDomainError("trading_store_rejected", "Execution receipt identity was rejected. Failing closed.");
      }
      if (input.domainStatus !== null && input.domainStatus !== "submitted_unknown") {
        throw new TradingDomainError("trading_store_rejected", "Execution receipt status was rejected. Failing closed.");
      }
      const environment = tradingEnvironmentSchema.safeParse(input.environment);
      if (!environment.success) {
        throw new TradingDomainError("trading_store_rejected", "Execution receipt environment was rejected. Failing closed.");
      }
      const current = db.prepare(`
        SELECT
          occurrence_id, routine_id, routine_run_id, thread_id, provider_turn_id, agent_run_id,
          instrument, environment, provenance, snapshot_id, decision_id, order_intent_id,
          risk_decision_id, policy_decision_id, approval_id, execution_request_id, reconciliation_run_id,
          proposal_binding_hash, domain_status, failure_code, started_at, completed_at
        FROM trading_occurrences
        WHERE occurrence_id = ?
      `).get(input.occurrenceId) as OccurrenceRow | undefined;
      if (current === undefined || current.provider_turn_id === null) {
        throw new TradingDomainError("trading_store_rejected", "Execution receipt matched no bound occurrence. Failing closed.");
      }
      if (current.agent_run_id !== input.agentRunId) {
        throw new TradingDomainError("agent_run_mismatch", "Execution receipt agent run does not match. Failing closed.");
      }
      if (current.environment !== environment.data) {
        throw new TradingDomainError("trading_store_rejected", "Execution receipt environment does not match. Failing closed.");
      }
      agree(current.execution_request_id, executionRequestId);
      agree(current.failure_code, failureCode);
      const nextStatus = input.domainStatus === "submitted_unknown"
        && current.domain_status === "turn_not_started"
        ? "submitted_unknown"
        : current.domain_status;
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db.prepare(`
          UPDATE trading_occurrences
          SET execution_request_id = COALESCE(execution_request_id, ?),
              failure_code = COALESCE(failure_code, ?),
              domain_status = CASE
                WHEN domain_status = 'turn_not_started' AND ? = 'submitted_unknown' THEN 'submitted_unknown'
                ELSE domain_status
              END
          WHERE occurrence_id = ?
            AND agent_run_id = ?
            AND environment = ?
            AND provider_turn_id IS NOT NULL
            AND (execution_request_id IS NULL OR execution_request_id = ?)
            AND (failure_code IS NULL OR ? IS NULL OR failure_code = ?)
        `).run(
          executionRequestId,
          failureCode,
          input.domainStatus,
          input.occurrenceId,
          input.agentRunId,
          environment.data,
          executionRequestId,
          failureCode,
          failureCode,
        );
        if (result.changes !== 1 && current.execution_request_id !== executionRequestId) {
          throw new TradingDomainError("trading_store_rejected", "Execution receipt was rejected. Failing closed.");
        }
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The occurrence transaction is already closed.
        }
        if (error instanceof TradingDomainError) throw error;
        throw new TradingDomainError("trading_store_rejected", "Execution receipt was rejected. Failing closed.");
      }
      const stored = db.prepare(`
        SELECT
          occurrence_id, routine_id, routine_run_id, thread_id, provider_turn_id, agent_run_id,
          instrument, environment, provenance, snapshot_id, decision_id, order_intent_id,
          risk_decision_id, policy_decision_id, approval_id, execution_request_id, reconciliation_run_id,
          proposal_binding_hash, domain_status, failure_code, started_at, completed_at
        FROM trading_occurrences
        WHERE occurrence_id = ?
      `).get(input.occurrenceId) as OccurrenceRow | undefined;
      if (
        stored === undefined
        || stored.execution_request_id !== (current.execution_request_id ?? executionRequestId)
        || stored.failure_code !== (current.failure_code ?? failureCode)
        || stored.domain_status !== nextStatus
        || stored.provider_turn_id !== current.provider_turn_id
        || stored.agent_run_id !== current.agent_run_id
        || stored.routine_id !== current.routine_id
        || stored.routine_run_id !== current.routine_run_id
        || stored.thread_id !== current.thread_id
      ) {
        throw new TradingDomainError("immutable_revision", "Execution receipt already differs. Failing closed.");
      }
      return seal(fromRow(stored));
    },
  };
}

function nullableReference(value: string | null, label: string): string | null {
  if (value === null) return null;
  if (!recordIdSchema.safeParse(value).success) {
    throw new TradingDomainError("trading_store_rejected", `${label} was rejected. Failing closed.`);
  }
  return value;
}

function nullableFailure(value: string | null): string | null {
  if (value === null) return null;
  if (!/^[A-Za-z0-9_]+$/.test(value) || value.length > 128) {
    throw new TradingDomainError("trading_store_rejected", "Eligibility failure code was rejected. Failing closed.");
  }
  return value;
}

/** A null column may be filled once. A later null leaves the stored value.
 * Two different non-null values are an immutable revision. */
function agree(current: string | null, next: string | null): void {
  if (next === null || current === null || current === next) return;
  throw new TradingDomainError("immutable_revision", "Eligibility correlation already differs. Failing closed.");
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
