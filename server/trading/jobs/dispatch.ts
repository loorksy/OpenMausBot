import type { ProvenanceStatus } from "../../../shared/trading/environment.ts";
import type { TradingEvent, TradingEventType } from "../../../shared/trading/events.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { recordIdSchema } from "../../../shared/trading/ids.ts";
import { tradingFact } from "../audit.ts";
import type { JobRepository } from "../persistence/jobs.ts";
import { contentHash } from "../replay/hash.ts";
import { revisionId } from "./interpret.ts";
import { jobStatusLabel, XAUUSD_JOB_VERSION, type XauUsdApprovalHold, type XauUsdJob, type XauUsdJobBlockReason, type XauUsdJobStatus, type XauUsdJobWake } from "./model.ts";
import { collapsedWakeSlot, epochMs, nextScheduledWake } from "./schedule.ts";

export interface XauUsdTurnRequest {
  readonly jobId: string;
  readonly wakeId: string;
  readonly agentRunId: string;
  readonly runtimeThreadId: string;
  readonly runtimeTurnId: string;
  readonly environment: XauUsdJob["environment"];
  readonly prompt: string;
}

export interface XauUsdTurnStarter {
  startTurn(request: XauUsdTurnRequest): Promise<{ readonly runtimeTurnId: string }>;
}

const TERMINAL = new Set<XauUsdJobStatus>(["COMPLETED", "CANCELLED", "FAILED"]);

/** Claims at most one fresh wake and asks the existing runtime to start one turn.
 * It does not call a model itself and it does not call MetaApi. */
export async function dispatchDueJobs(
  jobs: readonly XauUsdJob[],
  repository: JobRepository,
  turns: XauUsdTurnStarter,
  nowIso: string,
): Promise<{ readonly started: readonly XauUsdTurnRequest[]; readonly events: readonly TradingEvent[] }> {
  const started: XauUsdTurnRequest[] = [];
  const events: TradingEvent[] = [];
  for (const job of jobs) {
    const outcome = await dispatchOne(job, repository, turns, nowIso);
    if (outcome.request) started.push(outcome.request);
    events.push(...outcome.events);
  }
  repository.appendEvents(events);
  return { started, events };
}

async function dispatchOne(
  job: XauUsdJob,
  repository: JobRepository,
  turns: XauUsdTurnStarter,
  nowIso: string,
): Promise<{ request: XauUsdTurnRequest | null; events: TradingEvent[] }> {
  if (TERMINAL.has(job.status) || job.status === "PAUSED") return { request: null, events: [] };
  if (epochMs(nowIso) >= epochMs(job.endAt)) {
    const completed = revise(job, "COMPLETED", nowIso, { nextWakeAt: null, blockReason: null });
    repository.saveJob(completed);
    return { request: null, events: [fact(completed, "job.completed", nowIso)] };
  }
  if (job.status === "WAITING_FOR_APPROVAL") {
    if (job.approval !== null && epochMs(nowIso) <= epochMs(job.approval.expiresAt)) {
      return { request: null, events: [] };
    }
    const reassessment = revise(job, "WAITING_FOR_REASSESSMENT", nowIso, { approval: null, blockReason: "approval" });
    repository.saveJob(reassessment);
    job = reassessment;
  }
  const slot = collapsedWakeSlot(job, nowIso);
  if (slot === null) return { request: null, events: [] };
  const wake = wakeRecord(job, slot);
  const claim = repository.claimWake(wake);
  if (!claim.claimed) return { request: null, events: [] };
  const running = revise(job, "RUNNING", nowIso, { lastWakeAt: slot, blockReason: job.blockReason });
  repository.saveJob(running);
  const began = job.status === "CREATED" || job.status === "WAITING_FOR_REASSESSMENT"
    ? [fact(running, "job.started", nowIso)]
    : [];
  const request: XauUsdTurnRequest = {
    jobId: job.jobId,
    wakeId: wake.wakeId,
    agentRunId: wake.agentRunId,
    runtimeThreadId: job.runtimeThreadId,
    runtimeTurnId: wake.runtimeTurnId ?? "",
    environment: job.environment,
    prompt: monitoringPrompt(job),
  };
  const scheduled = fact(running, "job.wake.scheduled", nowIso, wake, request.runtimeTurnId);
  try {
    const startedTurn = await turns.startTurn(request);
    if (startedTurn.runtimeTurnId !== request.runtimeTurnId) {
      throw new TradingDomainError("trading_store_rejected", "XAUUSD wake turn identity was rejected. Failing closed.");
    }
  } catch {
    const nextWakeAt = nextScheduledWake(running, slot);
    const failed = revise(running, nextWakeAt === null ? "COMPLETED" : "SLEEPING", nowIso, { nextWakeAt });
    repository.saveJob(failed);
    return { request: null, events: [...began, scheduled, fact(failed, "job.failed", nowIso, wake)] };
  }
  const nextWakeAt = nextScheduledWake(running, slot);
  const blockReason = running.blockReason === "approval" ? null : running.blockReason;
  const sleeping = revise(running, nextWakeAt === null ? "COMPLETED" : "SLEEPING", nowIso, { nextWakeAt, blockReason });
  repository.saveJob(sleeping);
  const startedWake = fact(sleeping, "job.wake.started", nowIso, wake, request.runtimeTurnId);
  return {
    request,
    events: [
      ...began,
      scheduled,
      startedWake,
      fact(sleeping, "job.wake.completed", nowIso, wake, request.runtimeTurnId),
      fact(sleeping, nextWakeAt === null ? "job.completed" : "job.sleeping", nowIso),
    ],
  };
}

export function rememberJob(repository: JobRepository, job: XauUsdJob): { readonly job: XauUsdJob; readonly created: boolean } {
  const existing = repository.readJob(job.jobId);
  if (existing !== null) return { job: existing, created: false };
  repository.saveJob(job);
  repository.appendEvents([fact(job, "job.created", job.createdAt)]);
  return { job, created: true };
}

export function pauseJob(repository: JobRepository, job: XauUsdJob, at: string): XauUsdJob {
  return transition(repository, job, "PAUSED", at, {}, "job.paused");
}

export function resumeJob(repository: JobRepository, job: XauUsdJob, at: string): XauUsdJob {
  if (job.status !== "PAUSED") return job;
  return transition(repository, job, "SLEEPING", at, {}, "job.resumed");
}

export function cancelJob(repository: JobRepository, job: XauUsdJob, at: string): XauUsdJob {
  return transition(repository, job, "CANCELLED", at, { nextWakeAt: null }, "job.cancelled");
}

export function holdForApproval(repository: JobRepository, job: XauUsdJob, approval: XauUsdApprovalHold, at: string): XauUsdJob {
  return transition(repository, job, "WAITING_FOR_APPROVAL", at, { approval, blockReason: "approval" }, "job.waiting_approval");
}

export function noteMarketObservation(
  repository: JobRepository,
  job: XauUsdJob,
  observation: { readonly observationId: string; readonly provenance: ProvenanceStatus },
  at: string,
): XauUsdJob {
  const blockReason: XauUsdJobBlockReason = observation.provenance === "LIVE" ? job.blockReason : "provenance";
  return transition(repository, job, job.status === "CREATED" ? "SLEEPING" : job.status, at, {
    observationId: observation.observationId,
    provenance: observation.provenance,
    blockReason,
  }, observation.provenance === "LIVE" ? null : "job.blocked");
}

export function noteReconciliation(
  repository: JobRepository,
  job: XauUsdJob,
  state: XauUsdJob["reconciliationState"],
  executionState: XauUsdJob["executionState"],
  at: string,
): XauUsdJob {
  const blocked = state === "DESYNCED" || state === "UNKNOWN" || executionState === "SUBMISSION_UNKNOWN";
  return transition(repository, job, job.status, at, {
    reconciliationState: state,
    executionState,
    blockReason: blocked ? "reconciliation" : job.blockReason === "reconciliation" ? null : job.blockReason,
  }, blocked ? "job.blocked" : null);
}

function transition(
  repository: JobRepository,
  job: XauUsdJob,
  status: XauUsdJobStatus,
  at: string,
  patch: Partial<XauUsdJob>,
  eventType: TradingEventType | null,
): XauUsdJob {
  const next = revise(job, status, at, patch);
  repository.saveJob(next);
  if (eventType !== null) repository.appendEvents([fact(next, eventType, at)]);
  return next;
}

function revise(job: XauUsdJob, status: XauUsdJobStatus, at: string, patch: Partial<XauUsdJob>): XauUsdJob {
  const sequence = job.sequence + 1;
  const blockReason = patch.blockReason === undefined ? job.blockReason : patch.blockReason;
  const nextWakeAt = patch.nextWakeAt === undefined ? job.nextWakeAt : patch.nextWakeAt;
  return {
    ...job,
    ...patch,
    schemaVersion: job.schemaVersion,
    jobId: job.jobId,
    instrument: job.instrument,
    environment: job.environment,
    autonomyLevel: job.autonomyLevel,
    autonomyName: job.autonomyName,
    agentRunId: job.agentRunId,
    runtimeThreadId: job.runtimeThreadId,
    taskId: job.taskId,
    everyMinutes: job.everyMinutes,
    scheduleSource: job.scheduleSource,
    startAt: job.startAt,
    endAt: job.endAt,
    durationMs: job.durationMs,
    createdAt: job.createdAt,
    configVersion: job.configVersion,
    permissions: [...job.permissions],
    sequence,
    revisionId: revisionId(job.jobId, sequence, status),
    status,
    statusLabel: jobStatusLabel(status, blockReason, status === "RUNNING"),
    blockReason,
    nextWakeAt: status === "COMPLETED" || status === "CANCELLED" ? null : nextWakeAt,
    updatedAt: at,
  };
}

function wakeRecord(job: XauUsdJob, scheduledFor: string): XauUsdJobWake {
  const wakeId = `wake.${contentHash({ schema: XAUUSD_JOB_VERSION, jobId: job.jobId, scheduledFor }).slice(0, 40)}`;
  return {
    wakeId,
    jobId: job.jobId,
    scheduledFor,
    status: "claimed",
    agentRunId: `run.${contentHash({ schema: XAUUSD_JOB_VERSION, wakeId, role: "agent" }).slice(0, 40)}`,
    runtimeThreadId: job.runtimeThreadId,
    runtimeTurnId: `turn.${contentHash({ schema: XAUUSD_JOB_VERSION, jobId: job.jobId, scheduledFor, role: "turn" }).slice(0, 40)}`,
    collapsedFrom: job.nextWakeAt !== scheduledFor ? job.nextWakeAt : null,
  };
}

function monitoringPrompt(job: XauUsdJob): string {
  return [
    "Scheduled XAUUSD monitoring wake.",
    `Job ${job.jobId}. Environment ${job.environment}. Autonomy ${job.autonomyName}.`,
    "Read the current XAUUSD observation through the existing tools you are permitted to use.",
    "Keep the observation provenance and freshness. Do not invent prices.",
    "Do not place, modify, or close a broker order.",
    "Execution remains behind risk, policy, approval, the fire-time gate, the kill switch, and reconciliation.",
  ].join(" ");
}

function fact(
  job: XauUsdJob,
  type: TradingEventType,
  at: string,
  wake?: XauUsdJobWake,
  runtimeTurnId?: string,
): TradingEvent {
  const eventId = `tev.${contentHash({ schema: XAUUSD_JOB_VERSION, type, jobId: job.jobId, sequence: job.sequence, wakeId: wake?.wakeId ?? null }).slice(0, 40)}`;
  const correlationId = recordIdSchema.safeParse(job.taskId).success ? job.taskId : job.agentRunId;
  const event = tradingFact({
    type,
    eventId,
    at,
    agentRunId: wake?.agentRunId ?? job.agentRunId,
    correlationId,
    environment: job.environment,
    actor: "xauusd-job",
    nextState: job.status,
    runtimeThreadId: job.runtimeThreadId,
    runtimeTurnId: runtimeTurnId ?? null,
    payload: {
      jobId: job.jobId,
      status: job.status,
      statusLabel: job.statusLabel,
      wakeId: wake?.wakeId ?? null,
      scheduledFor: wake?.scheduledFor ?? null,
      runtimeThreadId: job.runtimeThreadId,
      runtimeTurnId: runtimeTurnId ?? null,
      blockReason: job.blockReason,
      brokerCall: false,
    },
  });
  if (event === null) {
    throw new TradingDomainError("trading_store_rejected", "XAUUSD job event was rejected. Failing closed.");
  }
  return event;
}
