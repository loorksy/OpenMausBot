import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { recordIdSchema, type AgentRunId } from "../../../shared/trading/ids.ts";
import { contentHash } from "../replay/hash.ts";

/** Identity contract for a routine trading occurrence. Distinct from the
 * Phase 10 job id. */
export const XAUUSD_OCCURRENCE_SCHEMA = "xauusd-occurrence-1" as const;

/** Display labels on a trading occurrence. They do not replace
 * `execution_attempts.state` or `reconciliation_runs.state`. */
export const OCCURRENCE_DOMAIN_STATUSES = [
  "turn_not_started",
  "observing",
  "no_trade",
  "proposed",
  "waiting_approval",
  "blocked",
  "submitted_unknown",
  "reconciled",
  "degraded",
  "desynced",
  "turn_failed",
] as const;

export type OccurrenceDomainStatus = (typeof OCCURRENCE_DOMAIN_STATUSES)[number];

export function parseOccurrenceDomainStatus(value: unknown): OccurrenceDomainStatus {
  if (typeof value !== "string" || !(OCCURRENCE_DOMAIN_STATUSES as readonly string[]).includes(value)) {
    throw new TradingDomainError("trading_store_rejected", "Occurrence domain status was rejected. Failing closed.");
  }
  return value as OccurrenceDomainStatus;
}

function requireRoutineRunId(routineRunId: string): string {
  if (!recordIdSchema.safeParse(routineRunId).success) {
    throw new TradingDomainError("trading_store_rejected", "Routine run id was rejected. Failing closed.");
  }
  return routineRunId;
}

/** Deterministic primary key for one native RoutineRun. Not a random id. */
export function routineOccurrenceId(routineRunId: string): string {
  const id = requireRoutineRunId(routineRunId);
  return `occ.${contentHash({ schema: XAUUSD_OCCURRENCE_SCHEMA, routineRunId: id, role: "occurrence" }).slice(0, 40)}`;
}

/** Phase 3 `AgentRunId` is a trading-domain record id. It names one
 * investigation and is validated by `recordIdSchema`. It is not a runtime
 * thread id and not a provider turn id. This uses the existing `run.` + 40
 * hex representation, derived from the native RoutineRun id, so the value
 * is not that id. */
export function routineAgentRunId(routineRunId: string): AgentRunId {
  const id = requireRoutineRunId(routineRunId);
  return `run.${contentHash({ schema: XAUUSD_OCCURRENCE_SCHEMA, routineRunId: id, role: "agent" }).slice(0, 40)}`;
}
