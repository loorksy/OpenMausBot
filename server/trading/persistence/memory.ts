import type { DatabaseSync } from "node:sqlite";

import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { assertNoSecretFields, seal } from "../../../shared/trading/ids.ts";
import type { TradingMemoryRecord } from "../memory/record.ts";
import { proposeLearningChange } from "../memory/record.ts";

export interface StoredLearning {
  readonly revisionId: string;
  readonly target: string;
  readonly recordedAt: string;
  readonly note: string;
  readonly fields: readonly string[];
}

export interface MemoryRepository {
  append(record: TradingMemoryRecord): { readonly inserted: boolean };
  read(occurrenceId: string): readonly TradingMemoryRecord[];
  appendLearning(input: {
    readonly target: string;
    readonly fields: readonly string[];
    readonly note: string;
    readonly recordedAt: string;
  }): { readonly accepted: boolean; readonly reason?: string; readonly revisionId?: string };
  listLearning(): readonly StoredLearning[];
}

export function createMemoryRepository(db: DatabaseSync, environment: TradingEnvironment): MemoryRepository {
  return {
    append(record) {
      assertNoSecretFields(record, "trading memory");
      if (record.environment !== environment) {
        throw new TradingDomainError("trading_store_rejected", "Trading memory environment does not match the store. Failing closed.");
      }
      const existing = db.prepare("SELECT payload_json FROM trading_memory WHERE record_id = ?").get(record.recordId) as { payload_json: string } | undefined;
      if (existing !== undefined) {
        if (existing.payload_json !== JSON.stringify(record)) {
          throw new TradingDomainError("trading_store_rejected", "Trading memory is immutable. Failing closed.");
        }
        return { inserted: false };
      }
      db.prepare(
        `INSERT INTO trading_memory (
          record_id, occurrence_id, agent_run_id, environment, kind, revision, supersedes, recorded_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.recordId,
        record.occurrenceId,
        record.agentRunId,
        record.environment,
        record.kind,
        record.revision,
        record.supersedes,
        record.recordedAt,
        JSON.stringify(record),
      );
      return { inserted: true };
    },
    read(occurrenceId) {
      const rows = db.prepare(
        "SELECT payload_json FROM trading_memory WHERE occurrence_id = ? AND environment = ? ORDER BY revision ASC",
      ).all(occurrenceId, environment) as Array<{ payload_json: string }>;
      return rows.map((row) => seal(JSON.parse(row.payload_json) as TradingMemoryRecord));
    },
    appendLearning(input) {
      const proposed = proposeLearningChange(input);
      if (!proposed.accepted) return { accepted: false, reason: proposed.reason };
      const payload = JSON.stringify({ ...proposed, note: input.note, fields: input.fields });
      assertNoSecretFields(JSON.parse(payload), "trading learning");
      const existing = db.prepare("SELECT payload_json FROM trading_learning WHERE revision_id = ?").get(proposed.revisionId) as { payload_json: string } | undefined;
      if (existing !== undefined && existing.payload_json !== payload) {
        throw new TradingDomainError("trading_store_rejected", "Trading learning revision is immutable. Failing closed.");
      }
      if (existing === undefined) {
        db.prepare(
          "INSERT INTO trading_learning (revision_id, target, recorded_at, payload_json) VALUES (?, ?, ?, ?)",
        ).run(proposed.revisionId, proposed.target, input.recordedAt, payload);
      }
      return { accepted: true, revisionId: proposed.revisionId };
    },
    listLearning() {
      const rows = db.prepare(
        "SELECT payload_json, recorded_at FROM trading_learning WHERE recorded_at IS NOT NULL ORDER BY recorded_at ASC, revision_id ASC",
      ).all() as Array<{ payload_json: string; recorded_at: string }>;
      return rows.map((row) => {
        let parsed: { revisionId?: unknown; target?: unknown; note?: unknown; fields?: unknown };
        try {
          parsed = JSON.parse(row.payload_json) as typeof parsed;
        } catch {
          throw new TradingDomainError("trading_store_rejected", "Trading learning was unreadable. Failing closed.");
        }
        if (typeof parsed.revisionId !== "string" || typeof parsed.target !== "string" || typeof parsed.note !== "string" || !Array.isArray(parsed.fields)) {
          throw new TradingDomainError("trading_store_rejected", "Trading learning was unreadable. Failing closed.");
        }
        const fields = parsed.fields.filter((field): field is string => typeof field === "string");
        if (fields.length !== parsed.fields.length) {
          throw new TradingDomainError("trading_store_rejected", "Trading learning was unreadable. Failing closed.");
        }
        return seal({
          revisionId: parsed.revisionId,
          target: parsed.target,
          recordedAt: row.recorded_at,
          note: parsed.note,
          fields,
        });
      });
    },
  };
}
