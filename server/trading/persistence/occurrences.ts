import type { DatabaseSync } from "node:sqlite";

import type { Decision } from "../../../shared/trading/decision.ts";
import { parseDecision } from "../../../shared/trading/decision.ts";
import { tradingEnvironmentSchema, type ProvenanceStatus, type TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { assertNoSecretFields, recordIdSchema, seal, utcTimestampSchema } from "../../../shared/trading/ids.ts";
import { XAUUSD_INSTRUMENT } from "../../../shared/trading/instrument.ts";
import { parseReconciliationState, type ReconciliationState } from "../../../shared/trading/reconciliation.ts";
import { EXECUTION_STATES, type ExecutionState } from "../execution/result.ts";
import type { GateDecision } from "../gate/result.ts";
import type { PolicyDecision } from "../policy/result.ts";
import type { RiskDecision } from "../risk/result.ts";
import { writeSealedRow } from "./artifacts.ts";
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
  readonly gateDecisionId: string | null;
  readonly approvalId: string | null;
  readonly executionRequestId: string | null;
  readonly reconciliationRunId: string | null;
  /** Citation of `execution_attempts.state`. It is not a second execution machine. */
  readonly executionState: ExecutionState | null;
  readonly exitExecutionRequestId: string | null;
  readonly exitExecutionState: ExecutionState | null;
  readonly exitBrokerCalled: boolean | null;
  readonly exitClosePositionId: string | null;
  readonly exitQuantity: number | null;
  readonly exitFailureCode: string | null;
  /** Citation of `reconciliation_runs.state`. It is not a second reconciliation machine. */
  readonly reconciliationState: ReconciliationState | null;
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

/** Decision, risk, policy, and gate bodies written in the same transaction
 * as the occurrence citation. */
export interface AuthoritativeReferenceWrite extends EligibilityReferenceWrite {
  readonly gateDecisionId: string | null;
  readonly decision: Decision | null;
  readonly risk: RiskDecision | null;
  readonly policy: PolicyDecision | null;
  readonly gate: GateDecision | null;
}

/** Close citation. It points at the existing exit attempt. It is not a
 * second close command. */
export interface ExitExecutionWrite {
  readonly occurrenceId: string;
  readonly agentRunId: string;
  readonly environment: TradingEnvironment;
  readonly executionRequestId: string;
  readonly executionState: ExecutionState;
  readonly brokerCalled: boolean;
  readonly closePositionId: string | null;
  readonly quantity: number | null;
  readonly failureCode: string | null;
}

/** Correlation for one authorized execution request. It does not store the
 * broker payload or a second copy of the execution attempt. */
export interface ExecutionReceiptWrite {
  readonly occurrenceId: string;
  readonly agentRunId: string;
  readonly environment: TradingEnvironment;
  readonly executionRequestId: string;
  readonly executionState: Exclude<ExecutionState, "NOT_SUBMITTED">;
  readonly failureCode: string | null;
  readonly domainStatus: "submitted_unknown" | null;
}

/** Correlation for one existing reconciliation run. The run remains authoritative. */
export interface ReconciliationReceiptWrite {
  readonly occurrenceId: string;
  readonly agentRunId: string;
  readonly environment: TradingEnvironment;
  readonly executionRequestId: string;
  readonly reconciliationRunId: string;
  readonly reconciliationState: ReconciliationState;
  readonly reconciledAt: string;
  /** Broker book that governed this reconciliation. Omitted leaves the stored citation. */
  readonly snapshotId?: string | null;
}

export interface OccurrenceRepository {
  insertRoutineOccurrence(input: RoutineOccurrenceInsert): TradingOccurrence;
  readByRoutineRun(routineRunId: string): TradingOccurrence | null;
  readByOccurrenceId(occurrenceId: string): TradingOccurrence | null;
  attachProviderTurn(input: ProviderTurnAttach): TradingOccurrence;
  attachEligibilityReferences(input: EligibilityReferenceWrite): TradingOccurrence;
  attachAuthoritativeRecords(input: AuthoritativeReferenceWrite): TradingOccurrence;
  attachExecutionReceipt(input: ExecutionReceiptWrite): TradingOccurrence;
  attachExitExecution(input: ExitExecutionWrite): TradingOccurrence;
  attachReconciliationReceipt(input: ReconciliationReceiptWrite): TradingOccurrence;
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
  "executionState",
  "failureCode",
  "domainStatus",
]);
const RECONCILIATION_KEYS = new Set([
  "occurrenceId",
  "agentRunId",
  "environment",
  "executionRequestId",
  "reconciliationRunId",
  "reconciliationState",
  "reconciledAt",
  "snapshotId",
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
  gate_decision_id: string | null;
  approval_id: string | null;
  execution_request_id: string | null;
  reconciliation_run_id: string | null;
  execution_state: string | null;
  exit_execution_request_id: string | null;
  exit_execution_state: string | null;
  exit_broker_called: number | null;
  exit_close_position_id: string | null;
  exit_quantity: string | null;
  exit_failure_code: string | null;
  reconciliation_state: string | null;
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
          execution_state, reconciliation_state,
          gate_decision_id, exit_execution_request_id, exit_execution_state, exit_broker_called,
          exit_close_position_id, exit_quantity, exit_failure_code,
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
          execution_state, reconciliation_state,
          gate_decision_id, exit_execution_request_id, exit_execution_state, exit_broker_called,
          exit_close_position_id, exit_quantity, exit_failure_code,
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
          execution_state, reconciliation_state,
          gate_decision_id, exit_execution_request_id, exit_execution_state, exit_broker_called,
          exit_close_position_id, exit_quantity, exit_failure_code,
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
          execution_state, reconciliation_state,
          gate_decision_id, exit_execution_request_id, exit_execution_state, exit_broker_called,
          exit_close_position_id, exit_quantity, exit_failure_code,
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
          execution_state, reconciliation_state,
          gate_decision_id, exit_execution_request_id, exit_execution_state, exit_broker_called,
          exit_close_position_id, exit_quantity, exit_failure_code,
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
        executionState: current.execution_state,
        reconciliationState: current.reconciliation_state,
        domainStatus: current.domain_status,
        completedAt: current.completed_at,
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
          execution_state, reconciliation_state,
          gate_decision_id, exit_execution_request_id, exit_execution_state, exit_broker_called,
          exit_close_position_id, exit_quantity, exit_failure_code,
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
        || stored.execution_state !== preserved.executionState
        || stored.reconciliation_state !== preserved.reconciliationState
        || stored.domain_status !== preserved.domainStatus
        || stored.completed_at !== preserved.completedAt
      ) {
        throw new TradingDomainError("immutable_revision", "Eligibility correlation already differs. Failing closed.");
      }
      return seal(fromRow(stored));
    },
    attachAuthoritativeRecords(input) {
      const decisionId = nullableReference(input.decisionId, "Decision id");
      const orderIntentId = nullableReference(input.orderIntentId, "Order intent id");
      const riskDecisionId = nullableReference(input.riskDecisionId, "Risk decision id");
      const policyDecisionId = nullableReference(input.policyDecisionId, "Policy decision id");
      const gateDecisionId = nullableReference(input.gateDecisionId, "Gate decision id");
      const approvalId = nullableReference(input.approvalId, "Approval id");
      const proposalBindingHash = nullableReference(input.proposalBindingHash, "Proposal binding");
      const failureCode = nullableFailure(input.failureCode);
      requireArtifact(decisionId, input.decision, input.decision?.id ?? null, "Decision");
      requireArtifact(riskDecisionId, input.risk, input.risk?.id ?? null, "Risk decision");
      requireArtifact(policyDecisionId, input.policy, input.policy?.id ?? null, "Policy decision");
      requireArtifact(gateDecisionId, input.gate, input.gate?.id ?? null, "Gate decision");
      const decision = decisionId === null ? null : parseDecision(input.decision);
      if (decision !== null && decision.environment !== environment) {
        throw new TradingDomainError("trading_store_rejected", "Decision environment was rejected. Failing closed.");
      }
      if (!recordIdSchema.safeParse(input.occurrenceId).success || !recordIdSchema.safeParse(input.agentRunId).success) {
        throw new TradingDomainError("trading_store_rejected", "Eligibility correlation identity was rejected. Failing closed.");
      }
      const parsedEnvironment = tradingEnvironmentSchema.safeParse(input.environment);
      if (!parsedEnvironment.success || parsedEnvironment.data !== environment) {
        throw new TradingDomainError("trading_store_rejected", "Eligibility correlation environment was rejected. Failing closed.");
      }
      const current = readOccurrenceRow(db, input.occurrenceId);
      if (current === undefined || current.agent_run_id !== input.agentRunId || current.environment !== environment) {
        throw new TradingDomainError("trading_store_rejected", "Eligibility correlation matched no occurrence. Failing closed.");
      }
      agree(current.decision_id, decisionId);
      agree(current.order_intent_id, orderIntentId);
      agree(current.risk_decision_id, riskDecisionId);
      agree(current.policy_decision_id, policyDecisionId);
      agree(current.gate_decision_id, gateDecisionId);
      agree(current.approval_id, approvalId);
      agree(current.proposal_binding_hash, proposalBindingHash);
      agree(current.failure_code, failureCode);
      db.exec("BEGIN IMMEDIATE");
      try {
        if (decision !== null) writeSealedRow(db, "trading_decisions", "decision_id", decision.id, decision.agentRunId, environment, decision);
        if (input.risk !== null && riskDecisionId !== null) writeSealedRow(db, "trading_risk_decisions", "risk_decision_id", input.risk.id, input.risk.agentRunId, environment, input.risk);
        if (input.policy !== null && policyDecisionId !== null) writeSealedRow(db, "trading_policy_decisions", "policy_decision_id", input.policy.id, input.policy.agentRunId, environment, input.policy);
        if (input.gate !== null && gateDecisionId !== null) writeSealedRow(db, "trading_gate_decisions", "gate_decision_id", input.gate.id, input.gate.agentRunId, environment, input.gate);
        db.prepare(`
          UPDATE trading_occurrences
          SET decision_id = COALESCE(decision_id, ?),
              order_intent_id = COALESCE(order_intent_id, ?),
              risk_decision_id = COALESCE(risk_decision_id, ?),
              policy_decision_id = COALESCE(policy_decision_id, ?),
              gate_decision_id = COALESCE(gate_decision_id, ?),
              approval_id = COALESCE(approval_id, ?),
              proposal_binding_hash = COALESCE(proposal_binding_hash, ?),
              failure_code = COALESCE(failure_code, ?)
          WHERE occurrence_id = ?
            AND agent_run_id = ?
            AND environment = ?
        `).run(
          decisionId,
          orderIntentId,
          riskDecisionId,
          policyDecisionId,
          gateDecisionId,
          approvalId,
          proposalBindingHash,
          failureCode,
          input.occurrenceId,
          input.agentRunId,
          environment,
        );
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The artifact transaction is already closed.
        }
        if (error instanceof TradingDomainError) throw error;
        throw new TradingDomainError("trading_store_rejected", "Authoritative trading records were rejected. Failing closed.");
      }
      const stored = readOccurrenceRow(db, input.occurrenceId);
      if (
        stored === undefined
        || stored.decision_id !== (current.decision_id ?? decisionId)
        || stored.risk_decision_id !== (current.risk_decision_id ?? riskDecisionId)
        || stored.policy_decision_id !== (current.policy_decision_id ?? policyDecisionId)
        || stored.gate_decision_id !== (current.gate_decision_id ?? gateDecisionId)
      ) {
        throw new TradingDomainError("immutable_revision", "Authoritative trading records already differ. Failing closed.");
      }
      return seal(fromRow(stored));
    },
    attachExitExecution(input) {
      assertNoSecretFields(input, "exit execution");
      if (!recordIdSchema.safeParse(input.occurrenceId).success || !recordIdSchema.safeParse(input.agentRunId).success) {
        throw new TradingDomainError("trading_store_rejected", "Exit execution identity was rejected. Failing closed.");
      }
      if (input.environment !== environment) {
        throw new TradingDomainError("trading_store_rejected", "Exit execution environment was rejected. Failing closed.");
      }
      const executionState = parseStoredExecutionState(input.executionState);
      const executionRequestId = nullableReference(input.executionRequestId, "Exit execution id");
      if (executionState === null || executionRequestId === null) {
        throw new TradingDomainError("trading_store_rejected", "Exit execution identity was rejected. Failing closed.");
      }
      const current = readOccurrenceRow(db, input.occurrenceId);
      if (current === undefined || current.agent_run_id !== input.agentRunId) {
        throw new TradingDomainError("trading_store_rejected", "Exit execution matched no occurrence. Failing closed.");
      }
      agree(current.exit_execution_request_id, executionRequestId);
      const written = db.prepare(`
        UPDATE trading_occurrences
        SET exit_execution_request_id = COALESCE(exit_execution_request_id, ?),
            exit_execution_state = ?,
            exit_broker_called = ?,
            exit_close_position_id = COALESCE(exit_close_position_id, ?),
            exit_quantity = COALESCE(exit_quantity, ?),
            exit_failure_code = ?
        WHERE occurrence_id = ? AND agent_run_id = ? AND environment = ?
          AND (exit_execution_request_id IS NULL OR exit_execution_request_id = ?)
      `).run(
        executionRequestId,
        executionState,
        input.brokerCalled ? 1 : 0,
        input.closePositionId,
        input.quantity === null ? null : String(input.quantity),
        input.failureCode,
        input.occurrenceId,
        input.agentRunId,
        environment,
        executionRequestId,
      );
      const stored = readOccurrenceRow(db, input.occurrenceId);
      if (written.changes !== 1 || stored === undefined || stored.exit_execution_request_id !== executionRequestId || stored.exit_execution_state !== executionState) {
        throw new TradingDomainError("immutable_revision", "Exit execution already differs. Failing closed.");
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
      const executionState = parseStoredExecutionState(input.executionState);
      if (executionRequestId === null || executionState === null || executionState === "NOT_SUBMITTED" || !recordIdSchema.safeParse(input.occurrenceId).success || !recordIdSchema.safeParse(input.agentRunId).success) {
        throw new TradingDomainError("trading_store_rejected", "Execution receipt identity was rejected. Failing closed.");
      }
      if (input.domainStatus !== null && input.domainStatus !== "submitted_unknown") {
        throw new TradingDomainError("trading_store_rejected", "Execution receipt status was rejected. Failing closed.");
      }
      if (executionState === "SUBMISSION_UNKNOWN" && input.domainStatus !== "submitted_unknown") {
        throw new TradingDomainError("trading_store_rejected", "Unknown submission was not recorded as unknown. Failing closed.");
      }
      if (executionState !== "SUBMISSION_UNKNOWN" && input.domainStatus !== null) {
        throw new TradingDomainError("trading_store_rejected", "Execution receipt status was rejected. Failing closed.");
      }
      if ((executionState === "SUBMISSION_ACCEPTED" || executionState === "FILL_REPORTED") && failureCode !== null) {
        throw new TradingDomainError("trading_store_rejected", "Accepted execution cannot carry a rejection. Failing closed.");
      }
      if ((executionState === "SUBMISSION_REJECTED" || executionState === "SUBMISSION_UNKNOWN") && failureCode === null) {
        throw new TradingDomainError("trading_store_rejected", "Execution receipt failure was rejected. Failing closed.");
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
          execution_state, reconciliation_state,
          gate_decision_id, exit_execution_request_id, exit_execution_state, exit_broker_called,
          exit_close_position_id, exit_quantity, exit_failure_code,
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
      agree(current.execution_state, executionState);
      const nextStatus = input.domainStatus === "submitted_unknown"
        && current.domain_status === "turn_not_started"
        ? "submitted_unknown"
        : current.domain_status;
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db.prepare(`
          UPDATE trading_occurrences
          SET execution_request_id = COALESCE(execution_request_id, ?),
              execution_state = COALESCE(execution_state, ?),
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
            AND (execution_state IS NULL OR execution_state = ?)
            AND (failure_code IS NULL OR ? IS NULL OR failure_code = ?)
        `).run(
          executionRequestId,
          executionState,
          failureCode,
          input.domainStatus,
          input.occurrenceId,
          input.agentRunId,
          environment.data,
          executionRequestId,
          executionState,
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
          execution_state, reconciliation_state,
          gate_decision_id, exit_execution_request_id, exit_execution_state, exit_broker_called,
          exit_close_position_id, exit_quantity, exit_failure_code,
          proposal_binding_hash, domain_status, failure_code, started_at, completed_at
        FROM trading_occurrences
        WHERE occurrence_id = ?
      `).get(input.occurrenceId) as OccurrenceRow | undefined;
      if (
        stored === undefined
        || stored.execution_request_id !== (current.execution_request_id ?? executionRequestId)
        || stored.execution_state !== (current.execution_state ?? executionState)
        || stored.failure_code !== (current.failure_code ?? failureCode)
        || stored.reconciliation_run_id !== current.reconciliation_run_id
        || stored.reconciliation_state !== current.reconciliation_state
        || stored.domain_status !== nextStatus
        || stored.decision_id !== current.decision_id
        || stored.approval_id !== current.approval_id
        || stored.proposal_binding_hash !== current.proposal_binding_hash
        || stored.completed_at !== current.completed_at
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
    attachReconciliationReceipt(input) {
      assertNoSecretFields(input, "trading occurrence");
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new TradingDomainError("trading_store_rejected", "Reconciliation receipt was rejected. Failing closed.");
      }
      for (const key of Object.keys(input)) {
        if (!RECONCILIATION_KEYS.has(key)) {
          throw new TradingDomainError("trading_store_rejected", "Reconciliation receipt contains an unsupported field. Failing closed.");
        }
      }
      const executionRequestId = nullableReference(input.executionRequestId, "Execution request id");
      const reconciliationRunId = nullableReference(input.reconciliationRunId, "Reconciliation run id");
      const reconciliationState = parseReconciliationState(input.reconciliationState);
      if (
        executionRequestId === null
        || reconciliationRunId === null
        || !recordIdSchema.safeParse(input.occurrenceId).success
        || !recordIdSchema.safeParse(input.agentRunId).success
        || !utcTimestampSchema.safeParse(input.reconciledAt).success
      ) {
        throw new TradingDomainError("trading_store_rejected", "Reconciliation receipt identity was rejected. Failing closed.");
      }
      const environment = tradingEnvironmentSchema.safeParse(input.environment);
      if (!environment.success) {
        throw new TradingDomainError("trading_store_rejected", "Reconciliation receipt environment was rejected. Failing closed.");
      }
      const current = db.prepare(`
        SELECT
          occurrence_id, routine_id, routine_run_id, thread_id, provider_turn_id, agent_run_id,
          instrument, environment, provenance, snapshot_id, decision_id, order_intent_id,
          risk_decision_id, policy_decision_id, approval_id, execution_request_id, reconciliation_run_id,
          execution_state, reconciliation_state,
          gate_decision_id, exit_execution_request_id, exit_execution_state, exit_broker_called,
          exit_close_position_id, exit_quantity, exit_failure_code,
          proposal_binding_hash, domain_status, failure_code, started_at, completed_at
        FROM trading_occurrences
        WHERE occurrence_id = ?
      `).get(input.occurrenceId) as OccurrenceRow | undefined;
      if (current === undefined || current.provider_turn_id === null || current.execution_request_id === null || current.execution_state === null) {
        throw new TradingDomainError("trading_store_rejected", "Reconciliation receipt matched no submitted occurrence. Failing closed.");
      }
      if (current.execution_state === "NOT_SUBMITTED" || current.execution_request_id !== executionRequestId) {
        throw new TradingDomainError("trading_store_rejected", "Reconciliation receipt does not match the submission. Failing closed.");
      }
      if (current.agent_run_id !== input.agentRunId) {
        throw new TradingDomainError("agent_run_mismatch", "Reconciliation receipt agent run does not match. Failing closed.");
      }
      if (current.environment !== environment.data) {
        throw new TradingDomainError("trading_store_rejected", "Reconciliation receipt environment does not match. Failing closed.");
      }
      agreeReconciliation(current.reconciliation_run_id, current.reconciliation_state, reconciliationRunId, reconciliationState);
      const snapshotId = input.snapshotId == null ? null : nullableReference(input.snapshotId, "Snapshot id");
      const snapshotAdvances = current.reconciliation_state === "UNKNOWN"
        && current.reconciliation_run_id !== null
        && current.reconciliation_run_id !== reconciliationRunId;
      if (!snapshotAdvances) agree(current.snapshot_id, snapshotId);
      const nextStatus = reconciliationDisplay(current.domain_status, reconciliationState);
      const nextCompleted = reconciliationState === "UNKNOWN"
        ? current.completed_at
        : current.completed_at ?? input.reconciledAt;
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db.prepare(`
          UPDATE trading_occurrences
          SET snapshot_id = CASE
                WHEN ? = 1 THEN COALESCE(?, snapshot_id)
                ELSE COALESCE(snapshot_id, ?)
              END,
              reconciliation_run_id = ?,
              reconciliation_state = ?,
              domain_status = CASE
                WHEN ? = 'UNKNOWN' THEN domain_status
                WHEN ? = 'RECONCILED' AND domain_status IN ('turn_not_started', 'submitted_unknown') THEN 'reconciled'
                WHEN ? = 'DEGRADED' AND domain_status IN ('turn_not_started', 'submitted_unknown') THEN 'degraded'
                WHEN ? = 'DESYNCED' AND domain_status IN ('turn_not_started', 'submitted_unknown') THEN 'desynced'
                ELSE domain_status
              END,
              completed_at = CASE
                WHEN ? = 'UNKNOWN' THEN completed_at
                WHEN completed_at IS NULL THEN ?
                ELSE completed_at
              END
          WHERE occurrence_id = ?
            AND agent_run_id = ?
            AND environment = ?
            AND provider_turn_id IS NOT NULL
            AND execution_request_id = ?
            AND execution_state = ?
            AND (
              (reconciliation_run_id IS NULL AND reconciliation_state IS NULL)
              OR (reconciliation_run_id = ? AND reconciliation_state = ?)
              OR reconciliation_state = 'UNKNOWN'
            )
        `).run(
          snapshotAdvances ? 1 : 0,
          snapshotId,
          snapshotId,
          reconciliationRunId,
          reconciliationState,
          reconciliationState,
          reconciliationState,
          reconciliationState,
          reconciliationState,
          reconciliationState,
          input.reconciledAt,
          input.occurrenceId,
          input.agentRunId,
          environment.data,
          executionRequestId,
          current.execution_state,
          reconciliationRunId,
          reconciliationState,
        );
        if (result.changes !== 1) {
          throw new TradingDomainError("trading_store_rejected", "Reconciliation receipt was rejected. Failing closed.");
        }
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The occurrence transaction is already closed.
        }
        if (error instanceof TradingDomainError) throw error;
        throw new TradingDomainError("trading_store_rejected", "Reconciliation receipt was rejected. Failing closed.");
      }
      const stored = db.prepare(`
        SELECT
          occurrence_id, routine_id, routine_run_id, thread_id, provider_turn_id, agent_run_id,
          instrument, environment, provenance, snapshot_id, decision_id, order_intent_id,
          risk_decision_id, policy_decision_id, approval_id, execution_request_id, reconciliation_run_id,
          execution_state, reconciliation_state,
          gate_decision_id, exit_execution_request_id, exit_execution_state, exit_broker_called,
          exit_close_position_id, exit_quantity, exit_failure_code,
          proposal_binding_hash, domain_status, failure_code, started_at, completed_at
        FROM trading_occurrences
        WHERE occurrence_id = ?
      `).get(input.occurrenceId) as OccurrenceRow | undefined;
      const expectedSnapshot = snapshotAdvances && snapshotId !== null ? snapshotId : current.snapshot_id ?? snapshotId;
      if (
        stored === undefined
        || stored.snapshot_id !== expectedSnapshot
        || stored.reconciliation_run_id !== reconciliationRunId
        || stored.reconciliation_state !== reconciliationState
        || stored.domain_status !== nextStatus
        || stored.completed_at !== nextCompleted
        || stored.execution_request_id !== current.execution_request_id
        || stored.execution_state !== current.execution_state
        || stored.failure_code !== current.failure_code
        || stored.decision_id !== current.decision_id
        || stored.order_intent_id !== current.order_intent_id
        || stored.risk_decision_id !== current.risk_decision_id
        || stored.policy_decision_id !== current.policy_decision_id
        || stored.approval_id !== current.approval_id
        || stored.proposal_binding_hash !== current.proposal_binding_hash
        || stored.provider_turn_id !== current.provider_turn_id
        || stored.agent_run_id !== current.agent_run_id
        || stored.routine_id !== current.routine_id
        || stored.routine_run_id !== current.routine_run_id
        || stored.thread_id !== current.thread_id
      ) {
        throw new TradingDomainError("immutable_revision", "Reconciliation receipt already differs. Failing closed.");
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

/** A concluded reconciliation stays. UNKNOWN may advance to a later run.
 * The earlier run remains in reconciliation_runs. */
function agreeReconciliation(
  currentId: string | null,
  currentState: string | null,
  nextId: string,
  nextState: string,
): void {
  if (currentId === null && currentState === null) return;
  if (currentId === nextId && currentState === nextState) return;
  if (currentState === "UNKNOWN" && currentId !== null && currentId !== nextId) return;
  throw new TradingDomainError("immutable_revision", "Reconciliation correlation already differs. Failing closed.");
}

function reconciliationDisplay(current: string, state: ReconciliationState): string {
  if (state === "UNKNOWN") return current;
  if (current !== "turn_not_started" && current !== "submitted_unknown") return current;
  if (state === "RECONCILED") return "reconciled";
  if (state === "DEGRADED") return "degraded";
  if (state === "DESYNCED") return "desynced";
  return current;
}

function parseStoredExecutionState(value: string | null): ExecutionState | null {
  if (value === null) return null;
  if (!(EXECUTION_STATES as readonly string[]).includes(value)) {
    throw new TradingDomainError("trading_store_rejected", "Execution state was rejected. Failing closed.");
  }
  return value as ExecutionState;
}

/** A null column may be filled once. A later null leaves the stored value.
 * Two different non-null values are an immutable revision. */
function readOccurrenceRow(db: DatabaseSync, occurrenceId: string): OccurrenceRow | undefined {
  return db.prepare(`
    SELECT
      occurrence_id, routine_id, routine_run_id, thread_id, provider_turn_id, agent_run_id,
      instrument, environment, provenance, snapshot_id, decision_id, order_intent_id,
      risk_decision_id, policy_decision_id, approval_id, execution_request_id, reconciliation_run_id,
      execution_state, reconciliation_state,
      gate_decision_id, exit_execution_request_id, exit_execution_state, exit_broker_called,
      exit_close_position_id, exit_quantity, exit_failure_code,
      proposal_binding_hash, domain_status, failure_code, started_at, completed_at
    FROM trading_occurrences
    WHERE occurrence_id = ?
  `).get(occurrenceId) as OccurrenceRow | undefined;
}

function requireArtifact(id: string | null, body: unknown, bodyId: string | null, label: string): void {
  if (id === null && body == null) return;
  if (id === null || body == null || bodyId !== id) {
    throw new TradingDomainError("trading_store_rejected", `${label} citation was rejected. Failing closed.`);
  }
}

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
    gateDecisionId: null,
    approvalId: null,
    executionRequestId: null,
    reconciliationRunId: null,
    executionState: null,
    exitExecutionRequestId: null,
    exitExecutionState: null,
    exitBrokerCalled: null,
    exitClosePositionId: null,
    exitQuantity: null,
    exitFailureCode: null,
    reconciliationState: null,
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
    gateDecisionId: row.gate_decision_id,
    approvalId: row.approval_id,
    executionRequestId: row.execution_request_id,
    reconciliationRunId: row.reconciliation_run_id,
    executionState: parseStoredExecutionState(row.execution_state),
    exitExecutionRequestId: row.exit_execution_request_id,
    exitExecutionState: parseStoredExecutionState(row.exit_execution_state),
    exitBrokerCalled: row.exit_broker_called === null ? null : row.exit_broker_called === 1,
    exitClosePositionId: row.exit_close_position_id,
    exitQuantity: row.exit_quantity === null ? null : Number(row.exit_quantity),
    exitFailureCode: row.exit_failure_code,
    reconciliationState: row.reconciliation_state === null ? null : parseReconciliationState(row.reconciliation_state),
    proposalBindingHash: row.proposal_binding_hash,
    domainStatus: parseOccurrenceDomainStatus(row.domain_status),
    failureCode: row.failure_code,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}
