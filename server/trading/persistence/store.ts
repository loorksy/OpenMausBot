import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { tradingEnvironmentSchema } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import type { TradingEvent } from "../../../shared/trading/events.ts";
import { assertNoSecretFields, seal } from "../../../shared/trading/ids.ts";
import type { ExecutionAttemptRecord, ExecutionLedger } from "../execution/ledger.ts";
import type { ReconciliationResult } from "../reconciliation/engine.ts";
import type { BrokerAccountSnapshot } from "../reconciliation/snapshot.ts";
import { canonicalJson } from "../replay/hash.ts";
import { createJobRepository, type JobRepository } from "./jobs.ts";
import { createDurableExecutionLedger, insertEvent, readAttempts } from "./ledger.ts";
import { createApprovalRepository, type ApprovalRepository } from "./approvals.ts";
import { createOccurrenceRepository, type OccurrenceRepository } from "./occurrences.ts";
import type { PersistedExecutionRequest } from "./record.ts";
import { TRADING_STORE_SCHEMA_SQL } from "./schema.ts";

/** First durable trading schema. Version 0 had no tables. Opening still
 * requires an explicit path and environment; a zero-argument call does not
 * create a database. */
/** Phase 9 ledger is version 1. Phase 10 adds job tables as version 2.
 * Phase 10.3 step 1 adds trading_occurrences as version 3.
 * Phase 10.3 step 3 adds trading approval transports as version 4. */
export const TRADING_STORE_SCHEMA_VERSION = 4 as const;

const TRADING_STORE_SCHEMA_VERSIONS = [0, 1, 2, 3, TRADING_STORE_SCHEMA_VERSION] as const;

export interface OpenTradingStoreInput {
  readonly path: string;
  readonly environment: TradingEnvironment;
}

export interface TradingStore {
  readonly schemaVersion: typeof TRADING_STORE_SCHEMA_VERSION;
  readonly environment: TradingEnvironment;
  readonly path: string;
  readonly ledger: ExecutionLedger;
  readAttempts(identity: string): readonly ExecutionAttemptRecord[];
  readRequest(identity: string): PersistedExecutionRequest | null;
  readEvents(): readonly TradingEvent[];
  saveSnapshot(snapshot: BrokerAccountSnapshot): { readonly inserted: boolean };
  readSnapshot(snapshotId: string): BrokerAccountSnapshot | null;
  countBrokerOrders(snapshotId: string): number;
  countBrokerDeals(snapshotId: string): number;
  countBrokerPositions(snapshotId: string): number;
  saveReconciliation(result: ReconciliationResult): { readonly inserted: boolean };
  readReconciliations(identity: string): readonly ReconciliationResult[];
  countFindings(reconciliationRunId: string): number;
  readonly jobs: JobRepository;
  readonly occurrences: OccurrenceRepository;
  readonly approvals: ApprovalRepository;
  close(): void;
}

export function tradingPartitionKey(environment: TradingEnvironment): `xauusd/${TradingEnvironment}` {
  return `xauusd/${environment}`;
}

export function applyTradingMigrations(): never;
export function applyTradingMigrations(input: OpenTradingStoreInput): TradingStore;
export function applyTradingMigrations(input?: OpenTradingStoreInput): TradingStore {
  if (input === undefined) notOpened();
  return openAt(input);
}

export function openTradingStore(): never;
export function openTradingStore(input: OpenTradingStoreInput): TradingStore;
export function openTradingStore(input?: OpenTradingStoreInput): TradingStore {
  if (input === undefined) notOpened();
  return openAt(input);
}

function notOpened(): never {
  throw new TradingDomainError(
    "trading_store_not_implemented",
    "The trading store is not opened without an explicit path and environment. Failing closed.",
  );
}

function openAt(input: OpenTradingStoreInput): TradingStore {
  const environment = tradingEnvironmentSchema.safeParse(input.environment);
  if (!environment.success || typeof input.path !== "string" || input.path.length === 0) {
    throw new TradingDomainError("trading_store_rejected", "Trading store path or environment was rejected. Failing closed.");
  }
  prepareFile(input.path);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(input.path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA busy_timeout = 5000");
  } catch {
    throw new TradingDomainError("trading_store_rejected", "Trading store could not be opened. Failing closed.");
  }
  try {
    migrate(db, environment.data);
  } catch (error) {
    try {
      db.close();
    } catch {
      // The failed open must not leave a usable handle.
    }
    if (error instanceof TradingDomainError) throw error;
    throw new TradingDomainError("trading_store_rejected", "Trading store migration failed. Failing closed.");
  }
  return store(db, input.path, environment.data);
}

function prepareFile(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, "a", 0o600));
  } catch {
    throw new TradingDomainError("trading_store_rejected", "Trading store could not be opened. Failing closed.");
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // A platform that cannot chmod still has to fail closed on later reads
    // if the file is not usable. The create mode above is the requested mode.
  }
}

function migrate(db: DatabaseSync, environment: TradingEnvironment): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'",
    ).get();
    if (table === undefined) {
      db.exec(TRADING_STORE_SCHEMA_SQL);
      db.prepare(
        "INSERT INTO schema_meta (id, version, environment, partition_key) VALUES (1, ?, ?, ?)",
      ).run(TRADING_STORE_SCHEMA_VERSION, environment, tradingPartitionKey(environment));
      db.exec("COMMIT");
      return;
    }
    const columns = new Set(
      (db.prepare("PRAGMA table_info(schema_meta)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!columns.has("environment")) {
      db.exec("ALTER TABLE schema_meta ADD COLUMN environment TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.has("partition_key")) {
      db.exec("ALTER TABLE schema_meta ADD COLUMN partition_key TEXT NOT NULL DEFAULT ''");
    }
    db.exec(TRADING_STORE_SCHEMA_SQL);
    const row = db.prepare("SELECT version, environment FROM schema_meta WHERE id = 1").get() as {
      version: number;
      environment: string;
    } | undefined;
    if (row === undefined) {
      db.prepare(
        "INSERT INTO schema_meta (id, version, environment, partition_key) VALUES (1, ?, ?, ?)",
      ).run(TRADING_STORE_SCHEMA_VERSION, environment, tradingPartitionKey(environment));
      db.exec("COMMIT");
      return;
    }
    if (!(TRADING_STORE_SCHEMA_VERSIONS as readonly number[]).includes(row.version)) {
      throw new TradingDomainError("trading_store_rejected", "Trading store schema version is not supported. Failing closed.");
    }
    if (row.environment !== "" && row.environment !== environment) {
      throw new TradingDomainError(
        "trading_store_rejected",
        "Trading store environment does not match the requested partition. Failing closed.",
      );
    }
    if (row.version !== TRADING_STORE_SCHEMA_VERSION || row.environment !== environment) {
      db.prepare("UPDATE schema_meta SET version = ?, environment = ?, partition_key = ? WHERE id = 1").run(
        TRADING_STORE_SCHEMA_VERSION,
        environment,
        tradingPartitionKey(environment),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The migration transaction is already closed.
    }
    throw error;
  }
}

function store(db: DatabaseSync, path: string, environment: TradingEnvironment): TradingStore {
  const ledger = createDurableExecutionLedger(db, environment);
  const jobs = createJobRepository(db, environment);
  const occurrences = createOccurrenceRepository(db, environment);
  const approvals = createApprovalRepository(db, environment);
  return {
    schemaVersion: TRADING_STORE_SCHEMA_VERSION,
    environment,
    path,
    ledger,
    readAttempts(identity) {
      return readAttempts(db, identity);
    },
    readRequest(identity) {
      const row = db.prepare(
        "SELECT payload_json FROM execution_requests WHERE execution_identity = ?",
      ).get(identity) as { payload_json: string } | undefined;
      if (row === undefined) return null;
      return seal(parseRecord<PersistedExecutionRequest>(row.payload_json, isRequest));
    },
    readEvents() {
      const rows = db.prepare(
        "SELECT payload_json FROM trading_events ORDER BY at ASC, event_id ASC",
      ).all() as Array<{ payload_json: string }>;
      return rows.map((row) => seal(parseRecord<TradingEvent>(row.payload_json, isEvent)));
    },
    saveSnapshot(snapshot) {
      assertNoSecretFields(snapshot, "broker snapshot");
      if (snapshot.environment !== environment) {
        throw new TradingDomainError(
          "trading_store_rejected",
          "Broker snapshot environment does not match the store partition. Failing closed.",
        );
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const inserted = db.prepare(`
          INSERT OR IGNORE INTO broker_snapshots (
            snapshot_id, fingerprint, binding_id, environment, provider, observed_at,
            complete, unavailable, broker_call_skipped, invalid,
            orders_channel, deals_channel, positions_channel, account_channel,
            source, balance, equity, margin, currency, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          snapshot.snapshotId,
          snapshot.fingerprint,
          snapshot.bindingId,
          snapshot.environment,
          snapshot.provider,
          snapshot.observedAt,
          flag(snapshot.complete),
          flag(snapshot.unavailable),
          flag(snapshot.brokerCallSkipped),
          flag(snapshot.invalid),
          snapshot.channels.orders,
          snapshot.channels.deals,
          snapshot.channels.positions,
          snapshot.channels.account,
          snapshot.source,
          textNumber(snapshot.account.balance),
          textNumber(snapshot.account.equity),
          textNumber(snapshot.account.margin),
          snapshot.account.currency,
          canonicalJson(snapshot),
        );
        if (changes(inserted) !== 1) {
          db.exec("COMMIT");
          return { inserted: false };
        }
        for (const order of snapshot.orders) {
          db.prepare(`
            INSERT INTO broker_orders (
              snapshot_id, order_id, client_id, symbol, direction, volume, state, stop_loss, take_profit
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            snapshot.snapshotId,
            order.orderId,
            order.clientId,
            order.symbol,
            order.direction,
            textNumber(order.volume),
            order.state,
            textNumber(order.stopLoss),
            textNumber(order.takeProfit),
          );
        }
        for (const deal of snapshot.deals) {
          db.prepare(`
            INSERT INTO broker_deals (
              snapshot_id, deal_id, order_id, client_id, position_id, symbol, volume, price
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            snapshot.snapshotId,
            deal.dealId,
            deal.orderId,
            deal.clientId,
            deal.positionId,
            deal.symbol,
            textNumber(deal.volume),
            textNumber(deal.price),
          );
        }
        for (const position of snapshot.positions) {
          db.prepare(`
            INSERT INTO broker_positions (snapshot_id, position_id, symbol, direction, volume)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            snapshot.snapshotId,
            position.positionId,
            position.symbol,
            position.direction,
            textNumber(position.volume),
          );
        }
        db.exec("COMMIT");
        return { inserted: true };
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The snapshot transaction is already closed.
        }
        if (error instanceof TradingDomainError) throw error;
        throw new TradingDomainError("trading_store_rejected", "Trading store write failed. Failing closed.");
      }
    },
    readSnapshot(snapshotId) {
      const row = db.prepare("SELECT payload_json FROM broker_snapshots WHERE snapshot_id = ?").get(snapshotId) as {
        payload_json: string;
      } | undefined;
      if (row === undefined) return null;
      return seal(parseRecord<BrokerAccountSnapshot>(row.payload_json, isSnapshot));
    },
    countBrokerOrders(snapshotId) {
      return count(db, "SELECT COUNT(*) AS n FROM broker_orders WHERE snapshot_id = ?", snapshotId);
    },
    countBrokerDeals(snapshotId) {
      return count(db, "SELECT COUNT(*) AS n FROM broker_deals WHERE snapshot_id = ?", snapshotId);
    },
    countBrokerPositions(snapshotId) {
      return count(db, "SELECT COUNT(*) AS n FROM broker_positions WHERE snapshot_id = ?", snapshotId);
    },
    saveReconciliation(result) {
      assertNoSecretFields(result, "reconciliation result");
      if (result.environment !== environment) {
        throw new TradingDomainError(
          "trading_store_rejected",
          "Reconciliation environment does not match the store partition. Failing closed.",
        );
      }
      if (result.repairAttempted !== false || result.retried !== false) {
        throw new TradingDomainError("trading_store_rejected", "Reconciliation repair was rejected. Failing closed.");
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const inserted = db.prepare(`
          INSERT OR IGNORE INTO reconciliation_runs (
            reconciliation_run_id, execution_request_id, execution_attempt_id, execution_identity,
            snapshot_id, state, resolution, engine_version, config_version, reconciled_at,
            agent_run_id, binding_id, environment, provider, repair_attempted, retried, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
        `).run(
          result.reconciliationRunId,
          result.executionRequestId,
          result.executionAttemptId,
          result.executionIdentity,
          result.snapshotId,
          result.state,
          result.resolution,
          result.schemaVersion,
          result.configVersion,
          result.reconciledAt,
          result.agentRunId,
          result.accountBindingId,
          result.environment,
          result.provider,
          canonicalJson(result),
        );
        if (changes(inserted) !== 1) {
          db.exec("COMMIT");
          return { inserted: false };
        }
        result.findings.forEach((item, index) => {
          db.prepare(`
            INSERT INTO reconciliation_findings (
              reconciliation_run_id, finding_index, code, order_id, deal_id, position_id, symbol, broker_volume
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            result.reconciliationRunId,
            index,
            item.code,
            item.orderId,
            item.dealId,
            item.positionId,
            item.symbol,
            textNumber(item.brokerVolume),
          );
        });
        for (const event of result.events) insertEvent(db, event, environment);
        db.exec("COMMIT");
        return { inserted: true };
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The reconciliation transaction is already closed.
        }
        if (error instanceof TradingDomainError) throw error;
        throw new TradingDomainError("trading_store_rejected", "Trading store write failed. Failing closed.");
      }
    },
    readReconciliations(identity) {
      const rows = db.prepare(`
        SELECT payload_json
        FROM reconciliation_runs
        WHERE execution_identity = ?
        ORDER BY reconciled_at ASC, reconciliation_run_id ASC
      `).all(identity) as Array<{ payload_json: string }>;
      return rows.map((row) => seal(parseRecord<ReconciliationResult>(row.payload_json, isReconciliation)));
    },
    countFindings(reconciliationRunId) {
      return count(
        db,
        "SELECT COUNT(*) AS n FROM reconciliation_findings WHERE reconciliation_run_id = ?",
        reconciliationRunId,
      );
    },
    jobs,
    occurrences,
    approvals,
    close() {
      db.close();
    },
  };
}

function flag(value: boolean): number {
  return value ? 1 : 0;
}

function textNumber(value: number | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

function changes(result: unknown): number {
  if (result !== null && typeof result === "object" && "changes" in result && typeof result.changes === "number") {
    return result.changes;
  }
  return 0;
}

function count(db: DatabaseSync, sql: string, id: string): number {
  const row = db.prepare(sql).get(id) as { n: number } | undefined;
  return row?.n ?? 0;
}

function parseRecord<T>(json: string, check: (value: unknown) => value is T): T {
  try {
    const parsed: unknown = JSON.parse(json);
    assertNoSecretFields(parsed, "trading store record");
    if (!check(parsed)) {
      throw new TradingDomainError("trading_store_rejected", "Trading store record could not be read. Failing closed.");
    }
    return parsed;
  } catch (error) {
    if (error instanceof TradingDomainError) throw error;
    throw new TradingDomainError("trading_store_rejected", "Trading store record could not be read. Failing closed.");
  }
}

function isRequest(value: unknown): value is PersistedExecutionRequest {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<PersistedExecutionRequest>;
  return record.instrument === "XAUUSD"
    && typeof record.executionIdentity === "string"
    && typeof record.executionRequestId === "string"
    && typeof record.clientId === "string"
    && typeof record.acceptedQuantity === "number";
}

function isEvent(value: unknown): value is TradingEvent {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<TradingEvent>;
  return record.source === "trading-domain" && typeof record.eventId === "string" && typeof record.type === "string";
}

function isSnapshot(value: unknown): value is BrokerAccountSnapshot {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<BrokerAccountSnapshot>;
  return typeof record.snapshotId === "string" && typeof record.fingerprint === "string" && Array.isArray(record.orders);
}

function isReconciliation(value: unknown): value is ReconciliationResult {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<ReconciliationResult>;
  return typeof record.reconciliationRunId === "string"
    && typeof record.state === "string"
    && record.repairAttempted === false
    && record.retried === false
    && Array.isArray(record.findings);
}
