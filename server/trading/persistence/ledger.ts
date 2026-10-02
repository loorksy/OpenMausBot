import type { DatabaseSync } from "node:sqlite";

import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import type { TradingEvent } from "../../../shared/trading/events.ts";
import { assertNoSecretFields, seal } from "../../../shared/trading/ids.ts";
import type { ExecutionAttemptRecord, ExecutionLedger } from "../execution/ledger.ts";
import { executionAttemptKey } from "../execution/identity.ts";
import { canonicalJson } from "../replay/hash.ts";
import { requestFromAttempt } from "./record.ts";

/** Append-only execution ledger on the trading store. Reservation commits
 * before the caller may contact MetaApi. Completion inserts a new sequence. */
export function createDurableExecutionLedger(
  db: DatabaseSync,
  environment: TradingEnvironment,
): ExecutionLedger {
  return {
    find(identity) {
      const rows = attempts(db, identity);
      return rows.length === 0 ? null : rows[rows.length - 1] ?? null;
    },
    reserve(record) {
      assertAttempt(record, environment);
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db.prepare(
          "SELECT sequence FROM execution_attempts WHERE execution_identity = ? LIMIT 1",
        ).get(record.executionIdentity);
        if (existing !== undefined) {
          db.exec("ROLLBACK");
          return false;
        }
        const stored = materialize(record, 1, null);
        const request = requestFromAttempt(stored);
        db.prepare(`
          INSERT INTO execution_requests (
            execution_request_id, execution_identity, agent_run_id, environment,
            binding_id, client_id, submitted_at, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          request.executionRequestId,
          request.executionIdentity,
          request.agentRunId,
          request.environment,
          request.bindingId,
          request.clientId,
          request.submittedAt,
          canonicalJson(request),
        );
        insertAttempt(db, stored);
        db.exec("COMMIT");
        return true;
      } catch (error) {
        rollback(db);
        if (error instanceof TradingDomainError) throw error;
        throw writeFailed();
      }
    },
    complete(record) {
      assertAttempt(record, environment);
      db.exec("BEGIN IMMEDIATE");
      try {
        const latest = db.prepare(`
          SELECT sequence, state, execution_request_id
          FROM execution_attempts
          WHERE execution_identity = ?
          ORDER BY sequence DESC
          LIMIT 1
        `).get(record.executionIdentity) as {
          sequence: number;
          state: string;
          execution_request_id: string;
        } | undefined;
        if (
          latest === undefined
          || latest.state !== "SUBMISSION_UNKNOWN"
          || latest.execution_request_id !== record.executionRequestId
        ) {
          db.exec("ROLLBACK");
          return false;
        }
        insertAttempt(db, materialize(record, latest.sequence + 1, record.submittedAt));
        db.exec("COMMIT");
        return true;
      } catch (error) {
        rollback(db);
        if (error instanceof TradingDomainError) throw error;
        throw writeFailed();
      }
    },
    appendEvents(events) {
      if (events.length === 0) return;
      for (const event of events) assertNoSecretFields(event, "trading event");
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const event of events) insertEvent(db, event, environment);
        db.exec("COMMIT");
      } catch (error) {
        rollback(db);
        if (error instanceof TradingDomainError) throw error;
        throw writeFailed();
      }
    },
  };
}

export function readAttempts(db: DatabaseSync, identity: string): ExecutionAttemptRecord[] {
  return attempts(db, identity);
}

export function readAttemptsByAgent(db: DatabaseSync, agentRunId: string): ExecutionAttemptRecord[] {
  const rows = db.prepare(`
    SELECT payload_json
    FROM execution_attempts
    WHERE agent_run_id = ?
    ORDER BY sequence ASC
  `).all(agentRunId) as Array<{ payload_json: string }>;
  return rows.map((row) => readAttempt(row.payload_json));
}

function attempts(db: DatabaseSync, identity: string): ExecutionAttemptRecord[] {
  const rows = db.prepare(`
    SELECT payload_json
    FROM execution_attempts
    WHERE execution_identity = ?
    ORDER BY sequence ASC
  `).all(identity) as Array<{ payload_json: string }>;
  return rows.map((row) => readAttempt(row.payload_json));
}

function insertAttempt(db: DatabaseSync, record: ExecutionAttemptRecord): void {
  db.prepare(`
    INSERT INTO execution_attempts (
      execution_attempt_id, execution_request_id, execution_identity, sequence,
      state, submitted_at, response_at, client_id, broker_request_id, broker_code,
      agent_run_id, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.executionAttemptId,
    record.executionRequestId,
    record.executionIdentity,
    record.sequence,
    record.state,
    record.submittedAt,
    record.responseAt,
    record.clientId,
    record.brokerRequestId,
    record.brokerCode,
    record.agentRunId,
    canonicalJson(record),
  );
}

export function insertEvent(db: DatabaseSync, event: TradingEvent, environment: TradingEnvironment): void {
  if (event.environment !== environment) {
    throw new TradingDomainError(
      "trading_store_rejected",
      "Trading event environment does not match the store partition. Failing closed.",
    );
  }
  db.prepare(`
    INSERT OR IGNORE INTO trading_events (event_id, type, agent_run_id, environment, at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(event.eventId, event.type, event.agentRunId, event.environment, event.at, canonicalJson(event));
}

function materialize(
  record: ExecutionAttemptRecord,
  sequence: number,
  responseAt: string | null,
): ExecutionAttemptRecord {
  return {
    ...record,
    sequence,
    responseAt,
    executionAttemptId: executionAttemptKey({
      executionIdentity: record.executionIdentity,
      executionRequestId: record.executionRequestId,
      sequence,
      state: record.state,
    }),
    targets: [...record.targets],
    fill: record.fill === null ? null : { ...record.fill },
  };
}

function assertAttempt(record: ExecutionAttemptRecord, environment: TradingEnvironment): void {
  assertNoSecretFields(record, "execution attempt");
  if (record.environment !== environment) {
    throw new TradingDomainError(
      "trading_store_rejected",
      "Execution environment does not match the store partition. Failing closed.",
    );
  }
}

function readAttempt(json: string): ExecutionAttemptRecord {
  return seal(parseJson(json));
}

function parseJson(json: string): ExecutionAttemptRecord {
  try {
    const parsed: unknown = JSON.parse(json);
    assertNoSecretFields(parsed, "execution attempt");
    if (!isAttempt(parsed)) {
      throw new TradingDomainError("trading_store_rejected", "Trading store record could not be read. Failing closed.");
    }
    return parsed;
  } catch (error) {
    if (error instanceof TradingDomainError) throw error;
    throw new TradingDomainError("trading_store_rejected", "Trading store record could not be read. Failing closed.");
  }
}

function isAttempt(value: unknown): value is ExecutionAttemptRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<ExecutionAttemptRecord>;
  return typeof record.executionAttemptId === "string"
    && typeof record.executionIdentity === "string"
    && typeof record.executionRequestId === "string"
    && typeof record.sequence === "number"
    && typeof record.state === "string"
    && typeof record.clientId === "string";
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // The transaction is already closed.
  }
}

function writeFailed(): TradingDomainError {
  return new TradingDomainError("trading_store_rejected", "Trading store write failed. Failing closed.");
}
