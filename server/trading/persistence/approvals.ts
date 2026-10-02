import type { DatabaseSync } from "node:sqlite";

import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { assertNoSecretFields, recordIdSchema, utcTimestampSchema } from "../../../shared/trading/ids.ts";
import type { ApprovalDecision } from "../approval/result.ts";
import type { ApprovalFact } from "../approval/assess.ts";

export interface ApprovalTransportInsert {
  readonly requestId: string;
  readonly occurrenceId: string;
  readonly agentRunId: string;
  readonly decisionId: string;
  readonly orderIntentId: string;
  readonly riskDecisionId: string;
  readonly policyDecisionId: string;
  readonly proposalBinding: string;
  readonly environment: TradingEnvironment;
  readonly requesterId: string;
  readonly openedAt: string;
  readonly expiresAt: string;
  readonly maxAgeMs: number;
  readonly assessmentJson: string;
}

export interface ApprovalTransportRow {
  readonly requestId: string;
  readonly occurrenceId: string;
  readonly agentRunId: string;
  readonly decisionId: string;
  readonly orderIntentId: string;
  readonly riskDecisionId: string;
  readonly policyDecisionId: string;
  readonly proposalBinding: string;
  readonly environment: TradingEnvironment;
  readonly approvalPolicyVersion: string;
  readonly requesterId: string;
  readonly openedAt: string;
  readonly expiresAt: string;
  readonly maxAgeMs: number;
  readonly assessmentJson: string;
  readonly resolvedFingerprint: string | null;
  readonly approvalDecisionId: string | null;
  readonly assessmentState: string | null;
  readonly assessmentReason: string | null;
  readonly factJson: string | null;
  readonly decisionJson: string | null;
}

export interface ApprovalResolutionWrite {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly decision: ApprovalDecision;
  readonly fact: ApprovalFact | null;
  readonly proposalBinding: string;
}

export interface ApprovalRepository {
  insertOpen(input: ApprovalTransportInsert): ApprovalTransportRow;
  read(requestId: string): ApprovalTransportRow | null;
  readByBinding(proposalBinding: string): ApprovalTransportRow | null;
  readForOccurrence(occurrenceId: string): { readonly open: ApprovalTransportRow | null; readonly settled: ApprovalTransportRow | null; readonly ambiguous: boolean };
  commitResolution(input: ApprovalResolutionWrite): ApprovalTransportRow;
}

const INSERT_KEYS = new Set([
  "requestId",
  "occurrenceId",
  "agentRunId",
  "decisionId",
  "orderIntentId",
  "riskDecisionId",
  "policyDecisionId",
  "proposalBinding",
  "environment",
  "requesterId",
  "openedAt",
  "expiresAt",
  "maxAgeMs",
  "assessmentJson",
]);

export function createApprovalRepository(db: DatabaseSync, environment: TradingEnvironment): ApprovalRepository {
  return {
    insertOpen(input) {
      assertNoSecretFields(input, "trading approval");
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new TradingDomainError("trading_store_rejected", "Trading approval transport was rejected. Failing closed.");
      }
      for (const key of Object.keys(input)) {
        if (!INSERT_KEYS.has(key)) {
          throw new TradingDomainError("trading_store_rejected", "Trading approval transport contains an unsupported field. Failing closed.");
        }
      }
      if (input.environment !== environment) {
        throw new TradingDomainError("environment_isolation", "Trading approval environment does not match the store partition. Failing closed.");
      }
      const ids = [
        input.requestId,
        input.occurrenceId,
        input.agentRunId,
        input.decisionId,
        input.orderIntentId,
        input.riskDecisionId,
        input.policyDecisionId,
        input.proposalBinding,
        input.requesterId,
      ];
      if (ids.some((id) => !recordIdSchema.safeParse(id).success)) {
        throw new TradingDomainError("trading_store_rejected", "Trading approval identity was rejected. Failing closed.");
      }
      if (!utcTimestampSchema.safeParse(input.openedAt).success || !utcTimestampSchema.safeParse(input.expiresAt).success) {
        throw new TradingDomainError("trading_store_rejected", "Trading approval timestamp was rejected. Failing closed.");
      }
      if (!Number.isSafeInteger(input.maxAgeMs) || input.maxAgeMs <= 0) {
        throw new TradingDomainError("trading_store_rejected", "Trading approval freshness was rejected. Failing closed.");
      }
      if (typeof input.assessmentJson !== "string" || input.assessmentJson.length === 0) {
        throw new TradingDomainError("trading_store_rejected", "Trading approval assessment was rejected. Failing closed.");
      }
      const approvalPolicyVersion = approvalVersion(input.assessmentJson);
      db.exec("BEGIN IMMEDIATE");
      try {
        const existingBinding = db.prepare(
          "SELECT request_id FROM trading_approval_transports WHERE proposal_binding = ?",
        ).get(input.proposalBinding) as { request_id: string } | undefined;
        if (existingBinding) {
          throw new TradingDomainError(
            "immutable_revision",
            "This proposal already has a trading approval transport. Failing closed.",
          );
        }
        db.prepare(`
          INSERT INTO trading_approval_transports (
            request_id, occurrence_id, agent_run_id, decision_id, order_intent_id, risk_decision_id,
            policy_decision_id, proposal_binding, environment, instrument, approval_policy_version,
            requester_id, opened_at, expires_at, max_age_ms, assessment_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'XAUUSD', ?, ?, ?, ?, ?, ?)
        `).run(
          input.requestId,
          input.occurrenceId,
          input.agentRunId,
          input.decisionId,
          input.orderIntentId,
          input.riskDecisionId,
          input.policyDecisionId,
          input.proposalBinding,
          input.environment,
          approvalPolicyVersion,
          input.requesterId,
          input.openedAt,
          input.expiresAt,
          input.maxAgeMs,
          input.assessmentJson,
        );
        db.exec("COMMIT");
      } catch (error) {
        rollback(db);
        if (error instanceof TradingDomainError) throw error;
        throw new TradingDomainError("trading_store_rejected", "Trading approval transport was rejected. Failing closed.");
      }
      const stored = readRow(db, input.requestId);
      if (!stored) throw new TradingDomainError("trading_store_rejected", "Trading approval transport was rejected. Failing closed.");
      return stored;
    },
    read(requestId) {
      if (!recordIdSchema.safeParse(requestId).success) return null;
      return readRow(db, requestId);
    },
    readByBinding(proposalBinding) {
      if (!recordIdSchema.safeParse(proposalBinding).success) return null;
      const row = db.prepare(`${SELECT} WHERE proposal_binding = ?`).get(proposalBinding) as TransportSql | undefined;
      return row ? fromRow(row) : null;
    },
    readForOccurrence(occurrenceId) {
      if (!recordIdSchema.safeParse(occurrenceId).success) return { open: null, settled: null, ambiguous: true };
      const rows = (db.prepare(`${SELECT} WHERE occurrence_id = ? ORDER BY opened_at ASC`).all(occurrenceId) as unknown as TransportSql[]).map(fromRow);
      const open = rows.filter((row) => row.resolvedFingerprint === null);
      const settled = rows.filter((row) => row.decisionJson !== null);
      if (open.length > 1 || settled.length > 1) return { open: null, settled: null, ambiguous: true };
      return { open: open[0] ?? null, settled: settled[0] ?? null, ambiguous: false };
    },
    commitResolution(input) {
      assertNoSecretFields(input, "trading approval");
      if (!recordIdSchema.safeParse(input.requestId).success || !recordIdSchema.safeParse(input.fingerprint).success) {
        throw new TradingDomainError("trading_store_rejected", "Trading approval resolution was rejected. Failing closed.");
      }
      const decisionJson = JSON.stringify(input.decision);
      const factJson = input.fact === null ? null : JSON.stringify(input.fact);
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = readRow(db, input.requestId);
        if (!current) {
          throw new TradingDomainError("trading_store_rejected", "Trading approval transport was not found. Failing closed.");
        }
        if (current.resolvedFingerprint === input.fingerprint) {
          db.exec("COMMIT");
          return current;
        }
        if (current.resolvedFingerprint !== null) {
          throw new TradingDomainError("immutable_revision", "Trading approval was already resolved. Failing closed.");
        }
        const written = db.prepare(`
          UPDATE trading_approval_transports
          SET resolved_fingerprint = ?, approval_decision_id = ?, assessment_state = ?, assessment_reason = ?,
              fact_json = ?, decision_json = ?
          WHERE request_id = ? AND resolved_fingerprint IS NULL
        `).run(
          input.fingerprint,
          input.decision.id,
          input.decision.state,
          input.decision.reasons[0],
          factJson,
          decisionJson,
          input.requestId,
        );
        if (written.changes !== 1) {
          throw new TradingDomainError("immutable_revision", "Trading approval was already resolved. Failing closed.");
        }
        const attached = db.prepare(`
          UPDATE trading_occurrences
          SET approval_id = ?, proposal_binding_hash = ?
          WHERE occurrence_id = ?
            AND (approval_id IS NULL OR approval_id = ?)
            AND (proposal_binding_hash IS NULL OR proposal_binding_hash = ?)
        `).run(
          input.decision.id,
          input.proposalBinding,
          current.occurrenceId,
          input.decision.id,
          input.proposalBinding,
        );
        if (attached.changes !== 1) {
          throw new TradingDomainError("immutable_revision", "Trading occurrence approval already differs. Failing closed.");
        }
        db.exec("COMMIT");
      } catch (error) {
        rollback(db);
        if (error instanceof TradingDomainError) throw error;
        throw new TradingDomainError("trading_store_rejected", "Trading approval resolution was rejected. Failing closed.");
      }
      const stored = readRow(db, input.requestId);
      if (!stored || stored.resolvedFingerprint !== input.fingerprint) {
        throw new TradingDomainError("trading_store_rejected", "Trading approval resolution was rejected. Failing closed.");
      }
      return stored;
    },
  };
}

function approvalVersion(assessmentJson: string): string {
  let parsed: { config?: { version?: unknown } };
  try {
    parsed = JSON.parse(assessmentJson) as { config?: { version?: unknown } };
  } catch {
    throw new TradingDomainError("trading_store_rejected", "Trading approval assessment was rejected. Failing closed.");
  }
  if (typeof parsed.config?.version !== "string" || parsed.config.version.trim() === "") {
    throw new TradingDomainError("trading_store_rejected", "Trading approval policy version was rejected. Failing closed.");
  }
  return parsed.config.version.trim();
}

const SELECT = `
  SELECT
    request_id, occurrence_id, agent_run_id, decision_id, order_intent_id, risk_decision_id,
    policy_decision_id, proposal_binding, environment, approval_policy_version, requester_id, opened_at, expires_at,
    max_age_ms, assessment_json, resolved_fingerprint, approval_decision_id, assessment_state,
    assessment_reason, fact_json, decision_json
  FROM trading_approval_transports
`;

interface TransportSql {
  request_id: string;
  occurrence_id: string;
  agent_run_id: string;
  decision_id: string;
  order_intent_id: string;
  risk_decision_id: string;
  policy_decision_id: string;
  proposal_binding: string;
  environment: TradingEnvironment;
  approval_policy_version: string;
  requester_id: string;
  opened_at: string;
  expires_at: string;
  max_age_ms: number;
  assessment_json: string;
  resolved_fingerprint: string | null;
  approval_decision_id: string | null;
  assessment_state: string | null;
  assessment_reason: string | null;
  fact_json: string | null;
  decision_json: string | null;
}

function readRow(db: DatabaseSync, requestId: string): ApprovalTransportRow | null {
  const row = db.prepare(`${SELECT} WHERE request_id = ?`).get(requestId) as TransportSql | undefined;
  return row ? fromRow(row) : null;
}

function fromRow(row: TransportSql): ApprovalTransportRow {
  return {
    requestId: row.request_id,
    occurrenceId: row.occurrence_id,
    agentRunId: row.agent_run_id,
    decisionId: row.decision_id,
    orderIntentId: row.order_intent_id,
    riskDecisionId: row.risk_decision_id,
    policyDecisionId: row.policy_decision_id,
    proposalBinding: row.proposal_binding,
    environment: row.environment,
    approvalPolicyVersion: row.approval_policy_version,
    requesterId: row.requester_id,
    openedAt: row.opened_at,
    expiresAt: row.expires_at,
    maxAgeMs: row.max_age_ms,
    assessmentJson: row.assessment_json,
    resolvedFingerprint: row.resolved_fingerprint,
    approvalDecisionId: row.approval_decision_id,
    assessmentState: row.assessment_state,
    assessmentReason: row.assessment_reason,
    factJson: row.fact_json,
    decisionJson: row.decision_json,
  };
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // The approval transaction is already closed.
  }
}
