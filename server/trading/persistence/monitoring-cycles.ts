import type { DatabaseSync } from "node:sqlite";

import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import type { TradingEvent } from "../../../shared/trading/events.ts";
import { assertNoSecretFields } from "../../../shared/trading/ids.ts";
import type { ReconciliationState } from "../../../shared/trading/reconciliation.ts";
import type { MonitoringCycle, MonitoringDecisionName, MonitoringExitProposal } from "../monitoring/cycle.ts";
import { canonicalJson, contentHash } from "../replay/hash.ts";
import { insertEvent } from "./ledger.ts";

/** Fields the room is allowed to reconstruct. Account identity and model
 * context stay out of this row. */
export interface PersistedMonitoringCycle {
  readonly schemaVersion: MonitoringCycle["schemaVersion"];
  readonly cycleId: string;
  readonly occurrenceId: string;
  readonly routineId: string;
  readonly routineRunId: string;
  readonly threadId: string;
  readonly providerTurnId: string;
  readonly agentRunId: string;
  readonly environment: TradingEnvironment;
  readonly observedAt: string;
  readonly marketProvenance: MonitoringCycle["market"]["provenance"] | null;
  readonly brokerHealth: MonitoringCycle["account"]["brokerHealth"];
  readonly reconciliationState: ReconciliationState | null;
  readonly position: MonitoringCycle["position"];
  readonly decision: MonitoringDecisionName;
  readonly failureCodes: readonly string[];
  readonly exitProposal: MonitoringExitProposal | null;
}

export interface MonitoringCycleRepository {
  record(cycle: MonitoringCycle, events: readonly TradingEvent[]): PersistedMonitoringCycle;
  readLatest(occurrenceId: string): PersistedMonitoringCycle | "missing" | "malformed";
}

export function persistableMonitoringCycle(cycle: MonitoringCycle): PersistedMonitoringCycle {
  const stored: PersistedMonitoringCycle = {
    schemaVersion: cycle.schemaVersion,
    cycleId: monitoringCycleId(cycle),
    occurrenceId: cycle.occurrenceId,
    routineId: cycle.routineId,
    routineRunId: cycle.routineRunId,
    threadId: cycle.threadId,
    providerTurnId: cycle.providerTurnId,
    agentRunId: cycle.agentRunId,
    environment: cycle.environment,
    observedAt: cycle.observedAt,
    marketProvenance: cycle.market.provenance,
    brokerHealth: cycle.account.brokerHealth,
    reconciliationState: cycle.reconciliationState,
    position: {
      state: cycle.position.state,
      positionId: cycle.position.positionId,
      direction: cycle.position.direction,
      quantity: cycle.position.quantity,
      entry: null,
    },
    decision: cycle.decision,
    failureCodes: cycle.failureCodes,
    exitProposal: cycle.exitProposal,
  };
  assertNoSecretFields(stored, "monitoring cycle");
  return stored;
}

export function createMonitoringCycleRepository(db: DatabaseSync, environment: TradingEnvironment): MonitoringCycleRepository {
  return {
    record(cycle, events) {
      if (cycle.environment !== environment) {
        throw new TradingDomainError("trading_store_rejected", "Monitoring cycle environment does not match the store partition. Failing closed.");
      }
      const stored = persistableMonitoringCycle(cycle);
      const json = canonicalJson(stored);
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db.prepare(
          "SELECT payload_json FROM trading_monitoring_cycles WHERE cycle_id = ?",
        ).get(stored.cycleId) as { payload_json: string } | undefined;
        if (existing === undefined) {
          db.prepare(`
            INSERT INTO trading_monitoring_cycles (
              cycle_id, occurrence_id, agent_run_id, environment, observed_at, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).run(stored.cycleId, stored.occurrenceId, stored.agentRunId, environment, stored.observedAt, json);
        } else if (existing.payload_json !== json) {
          throw new TradingDomainError("immutable_revision", "Monitoring cycle already differs. Failing closed.");
        }
        for (const event of events) insertEvent(db, event, environment);
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The monitoring transaction is already closed.
        }
        if (error instanceof TradingDomainError) throw error;
        throw new TradingDomainError("trading_store_rejected", "Monitoring cycle was rejected. Failing closed.");
      }
      return stored;
    },
    readLatest(occurrenceId) {
      const row = db.prepare(`
        SELECT payload_json FROM trading_monitoring_cycles
        WHERE occurrence_id = ? AND environment = ?
        ORDER BY observed_at DESC, cycle_id DESC
        LIMIT 1
      `).get(occurrenceId, environment) as { payload_json: string } | undefined;
      if (row === undefined) return "missing";
      try {
        const parsed = JSON.parse(row.payload_json) as PersistedMonitoringCycle;
        assertNoSecretFields(parsed, "monitoring cycle");
        if (parsed.occurrenceId !== occurrenceId || parsed.environment !== environment || typeof parsed.observedAt !== "string" || typeof parsed.decision !== "string") {
          return "malformed";
        }
        return parsed;
      } catch (error) {
        if (error instanceof TradingDomainError && error.code === "credentials_forbidden") throw error;
        return "malformed";
      }
    },
  };
}

function monitoringCycleId(cycle: MonitoringCycle): string {
  return `mcy.${contentHash({
    schema: cycle.schemaVersion,
    occurrenceId: cycle.occurrenceId,
    observedAt: cycle.observedAt,
    decision: cycle.decision,
    failureCodes: cycle.failureCodes,
  }).slice(0, 40)}`;
}
