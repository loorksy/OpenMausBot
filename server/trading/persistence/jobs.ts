import type { DatabaseSync } from "node:sqlite";

import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import type { TradingEvent } from "../../../shared/trading/events.ts";
import { assertNoSecretFields, seal } from "../../../shared/trading/ids.ts";
import type { XauUsdJob, XauUsdJobWake } from "../jobs/model.ts";
import { insertEvent } from "./ledger.ts";
import { canonicalJson } from "../replay/hash.ts";

export interface JobRepository {
  saveJob(job: XauUsdJob): { readonly inserted: boolean };
  readJob(jobId: string): XauUsdJob | null;
  listJobs(): readonly XauUsdJob[];
  claimWake(wake: XauUsdJobWake): { readonly claimed: boolean };
  readWakes(jobId: string): readonly XauUsdJobWake[];
  appendEvents(events: readonly TradingEvent[]): void;
}

export function createJobRepository(db: DatabaseSync, environment: TradingEnvironment): JobRepository {
  return {
    saveJob(job) {
      assertNoSecretFields(job, "xauusd job");
      if (job.environment !== environment) {
        throw new TradingDomainError(
          "trading_store_rejected",
          "XAUUSD job environment does not match the store partition. Failing closed.",
        );
      }
      const inserted = db.prepare(`
        INSERT OR IGNORE INTO xauusd_jobs (
          revision_id, job_id, sequence, status, environment, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(job.revisionId, job.jobId, job.sequence, job.status, job.environment, canonicalJson(job));
      return { inserted: changes(inserted) === 1 };
    },
    readJob(jobId) {
      const row = db.prepare(`
        SELECT payload_json FROM xauusd_jobs
        WHERE job_id = ? ORDER BY sequence DESC LIMIT 1
      `).get(jobId) as { payload_json: string } | undefined;
      return row === undefined ? null : seal(parseJob(row.payload_json));
    },
    listJobs() {
      const rows = db.prepare(`
        SELECT payload_json FROM xauusd_jobs AS jobs
        WHERE sequence = (
          SELECT MAX(sequence) FROM xauusd_jobs WHERE job_id = jobs.job_id
        )
        ORDER BY job_id ASC
      `).all() as Array<{ payload_json: string }>;
      return rows.map((row) => seal(parseJob(row.payload_json)));
    },
    claimWake(wake) {
      assertNoSecretFields(wake, "xauusd job wake");
      db.exec("BEGIN IMMEDIATE");
      try {
        const inserted = db.prepare(`
          INSERT OR IGNORE INTO xauusd_job_wakes (
            wake_id, job_id, scheduled_for, status, agent_run_id, runtime_thread_id, runtime_turn_id, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          wake.wakeId,
          wake.jobId,
          wake.scheduledFor,
          wake.status,
          wake.agentRunId,
          wake.runtimeThreadId,
          wake.runtimeTurnId,
          canonicalJson(wake),
        );
        db.exec("COMMIT");
        return { claimed: changes(inserted) === 1 };
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The wake transaction is already closed.
        }
        if (error instanceof TradingDomainError) throw error;
        throw new TradingDomainError("trading_store_rejected", "Trading store write failed. Failing closed.");
      }
    },
    readWakes(jobId) {
      const rows = db.prepare(`
        SELECT payload_json FROM xauusd_job_wakes WHERE job_id = ? ORDER BY scheduled_for ASC, wake_id ASC
      `).all(jobId) as Array<{ payload_json: string }>;
      return rows.map((row) => seal(parseWake(row.payload_json)));
    },
    appendEvents(events) {
      if (events.length === 0) return;
      for (const event of events) {
        assertNoSecretFields(event, "trading event");
        if (event.environment !== environment) {
          throw new TradingDomainError(
            "trading_store_rejected",
            "XAUUSD job event environment does not match the store partition. Failing closed.",
          );
        }
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const event of events) insertEvent(db, event, environment);
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The event transaction is already closed.
        }
        if (error instanceof TradingDomainError) throw error;
        throw new TradingDomainError("trading_store_rejected", "Trading store write failed. Failing closed.");
      }
    },
  };
}

function parseJob(json: string): XauUsdJob {
  const parsed: unknown = JSON.parse(json);
  assertNoSecretFields(parsed, "xauusd job");
  if (parsed === null || typeof parsed !== "object" || (parsed as { instrument?: unknown }).instrument !== "XAUUSD") {
    throw new TradingDomainError("trading_store_rejected", "Trading store record could not be read. Failing closed.");
  }
  return parsed as XauUsdJob;
}

function parseWake(json: string): XauUsdJobWake {
  const parsed: unknown = JSON.parse(json);
  assertNoSecretFields(parsed, "xauusd job wake");
  if (parsed === null || typeof parsed !== "object" || typeof (parsed as { wakeId?: unknown }).wakeId !== "string") {
    throw new TradingDomainError("trading_store_rejected", "Trading store record could not be read. Failing closed.");
  }
  return parsed as XauUsdJobWake;
}

function changes(result: unknown): number {
  if (result !== null && typeof result === "object" && "changes" in result && typeof result.changes === "number") {
    return result.changes;
  }
  return 0;
}
