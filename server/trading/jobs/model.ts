import type { AutonomyLevel, AutonomyName } from "../../../shared/trading/autonomy.ts";
import type { ProvenanceStatus, TradingEnvironment } from "../../../shared/trading/environment.ts";
import type { ReconciliationState } from "../../../shared/trading/reconciliation.ts";
import type { ExecutionState } from "../execution/result.ts";

/** Orchestration only. This is not a strategy and it does not submit orders. */
export const XAUUSD_JOB_VERSION = "xauusd-job-1" as const;

/** Configured cap. A monitoring request cannot run longer than this. */
export const XAUUSD_JOB_MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/** Used only when a request names a duration and no cadence. It is recorded on the job. */
export const XAUUSD_JOB_DEFAULT_INTERVAL_MINUTES = 15;

/** How long a claimed or dispatching wake keeps its lease. A dispatched wake
 * does not expire this way. Broker submission is not retried when it lapses. */
export const XAUUSD_WAKE_LEASE_MS = 2 * 60 * 1000;

export const XAUUSD_JOB_STATUSES = [
  "CREATED",
  "RUNNING",
  "SLEEPING",
  "WAITING_FOR_APPROVAL",
  "WAITING_FOR_REASSESSMENT",
  "PAUSED",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
  "BLOCKED",
] as const;

export type XauUsdJobStatus = (typeof XAUUSD_JOB_STATUSES)[number];

export type XauUsdJobBlockReason =
  | "kill_switch"
  | "reconciliation"
  | "risk"
  | "policy"
  | "gate"
  | "provenance"
  | "approval"
  | "autonomy"
  | "execution_unresolved"
  | null;

export interface XauUsdApprovalHold {
  readonly approvalId: string;
  readonly proposalBinding: string;
  readonly entry: number;
  readonly stop: number;
  readonly quantity: number;
  readonly environment: TradingEnvironment;
  readonly expiresAt: string;
}

export interface XauUsdJob {
  readonly schemaVersion: typeof XAUUSD_JOB_VERSION;
  readonly jobId: string;
  readonly sequence: number;
  readonly revisionId: string;
  readonly status: XauUsdJobStatus;
  readonly statusLabel: string;
  readonly agentRunId: string;
  readonly runtimeThreadId: string;
  readonly taskId: string;
  readonly instrument: "XAUUSD";
  readonly environment: TradingEnvironment;
  readonly autonomyLevel: AutonomyLevel;
  readonly autonomyName: AutonomyName;
  readonly permissions: readonly string[];
  readonly everyMinutes: number;
  readonly scheduleSource: "requested" | "configured-default";
  readonly startAt: string;
  readonly endAt: string;
  readonly durationMs: number;
  readonly nextWakeAt: string | null;
  readonly lastWakeAt: string | null;
  readonly approval: XauUsdApprovalHold | null;
  readonly provenance: ProvenanceStatus | null;
  readonly observationId: string | null;
  readonly reconciliationState: ReconciliationState | null;
  readonly executionState: ExecutionState | null;
  readonly blockReason: XauUsdJobBlockReason;
  readonly configVersion: typeof XAUUSD_JOB_VERSION;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Wake dispatch is not job status, decision state, execution state, or reconciliation. */
export const XAUUSD_WAKE_STATUSES = [
  "claimed",
  "dispatching",
  "dispatched",
  "completed",
  "failed",
  "interrupted",
  "collapsed",
] as const;

export type XauUsdWakeStatus = (typeof XAUUSD_WAKE_STATUSES)[number];

export interface XauUsdJobWake {
  readonly wakeId: string;
  readonly jobId: string;
  readonly scheduledFor: string;
  readonly status: XauUsdWakeStatus;
  readonly agentRunId: string;
  readonly runtimeThreadId: string;
  readonly runtimeTurnId: string | null;
  readonly collapsedFrom: string | null;
  /** Set while status is claimed or dispatching. Null after dispatch. */
  readonly leaseExpiresAt: string | null;
}

export function jobStatusLabel(
  status: XauUsdJobStatus,
  blockReason: XauUsdJobBlockReason,
  wakeInProgress: boolean,
): string {
  if (status === "WAITING_FOR_APPROVAL") return "Waiting for approval";
  if (status === "WAITING_FOR_REASSESSMENT") return "Waiting for reassessment";
  if (status === "PAUSED") return "Job paused";
  if (status === "CANCELLED") return "Job cancelled";
  if (status === "COMPLETED") return "Job completed";
  if (status === "FAILED") return "Job failed";
  if (status === "BLOCKED" || blockReason !== null) {
    if (blockReason === "reconciliation" || blockReason === "execution_unresolved") return "Execution blocked by reconciliation";
    if (blockReason === "risk") return "Execution blocked by risk";
    if (blockReason === "kill_switch") return "Execution blocked by kill switch";
    if (blockReason === "policy" || blockReason === "gate" || blockReason === "approval" || blockReason === "autonomy") {
      return "Execution blocked by policy";
    }
    if (blockReason === "provenance") return "Execution blocked by stale observation";
  }
  if (status === "RUNNING" && wakeInProgress) return "Analyzing new market observation";
  if (status === "RUNNING") return "Monitoring XAUUSD";
  if (status === "SLEEPING" || status === "CREATED") return "Waiting for next scheduled check";
  return "Monitoring XAUUSD";
}
