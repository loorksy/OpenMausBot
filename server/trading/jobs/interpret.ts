import { AUTONOMY_NAMES, type AutonomyState } from "../../../shared/trading/autonomy.ts";
import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { recordIdSchema } from "../../../shared/trading/ids.ts";
import { contentHash } from "../replay/hash.ts";
import {
  XAUUSD_JOB_DEFAULT_INTERVAL_MINUTES,
  XAUUSD_JOB_MAX_DURATION_MS,
  XAUUSD_JOB_VERSION,
  jobStatusLabel,
  type XauUsdJob,
} from "./model.ts";
import { isoFromEpoch, epochMs } from "./schedule.ts";

export interface XauUsdJobRequestContext {
  readonly text: string;
  readonly environment: TradingEnvironment;
  readonly autonomy: AutonomyState;
  readonly permissions: readonly string[];
  readonly agentRunId: string;
  readonly runtimeThreadId: string;
  readonly taskId: string;
  readonly requestedAt: string;
}

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** Turns a monitoring request into an explicit job. It does not choose a trade. */
export function interpretMonitoringRequest(context: XauUsdJobRequestContext): XauUsdJob {
  if (!recordIdSchema.safeParse(context.agentRunId).success || !recordIdSchema.safeParse(context.runtimeThreadId).success) {
    throw rejected();
  }
  let requestedAt = Number.NaN;
  try {
    requestedAt = epochMs(context.requestedAt);
  } catch {
    throw rejected();
  }
  if (!Number.isFinite(requestedAt)) throw rejected();
  if (context.autonomy.environment !== context.environment) throw rejected();
  if (AUTONOMY_NAMES[context.autonomy.level] !== context.autonomy.name) throw rejected();
  const text = context.text.normalize("NFKC").trim();
  if (!mentionsXau(text)) throw rejected();
  if (environmentConflict(text, context.environment)) throw rejected();
  const durationMs = namedDuration(text);
  if (durationMs === null || durationMs < MINUTE || durationMs > XAUUSD_JOB_MAX_DURATION_MS) throw rejected();
  const requestedInterval = namedInterval(text);
  const everyMinutes = requestedInterval ?? XAUUSD_JOB_DEFAULT_INTERVAL_MINUTES;
  if (!Number.isInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 24 * 60) throw rejected();
  const startAt = context.requestedAt;
  const endAt = isoFromEpoch(requestedAt + durationMs);
  const jobId = `job.${contentHash({
    schema: XAUUSD_JOB_VERSION,
    text,
    environment: context.environment,
    autonomy: context.autonomy.level,
    agentRunId: context.agentRunId,
    runtimeThreadId: context.runtimeThreadId,
    startAt,
    durationMs,
    everyMinutes,
  }).slice(0, 40)}`;
  const sequence = 1;
  return {
    schemaVersion: XAUUSD_JOB_VERSION,
    jobId,
    sequence,
    revisionId: revisionId(jobId, sequence, "CREATED"),
    status: "CREATED",
    statusLabel: jobStatusLabel("CREATED", null, false),
    agentRunId: context.agentRunId,
    runtimeThreadId: context.runtimeThreadId,
    taskId: context.taskId,
    instrument: "XAUUSD",
    environment: context.environment,
    autonomyLevel: context.autonomy.level,
    autonomyName: context.autonomy.name,
    permissions: [...context.permissions],
    everyMinutes,
    scheduleSource: requestedInterval === null ? "configured-default" : "requested",
    startAt,
    endAt,
    durationMs,
    nextWakeAt: startAt,
    lastWakeAt: null,
    approval: null,
    provenance: null,
    observationId: null,
    reconciliationState: null,
    executionState: null,
    blockReason: null,
    configVersion: XAUUSD_JOB_VERSION,
    createdAt: startAt,
    updatedAt: startAt,
  };
}

export function revisionId(jobId: string, sequence: number, status: string): string {
  return `jrev.${contentHash({ schema: XAUUSD_JOB_VERSION, jobId, sequence, status }).slice(0, 40)}`;
}

function mentionsXau(text: string): boolean {
  return /xauusd|gold|ذهب|الذهب|الصفقة الحالية/i.test(text);
}

function environmentConflict(text: string, environment: TradingEnvironment): boolean {
  const live = /live|حقيقي/i.test(text);
  const paper = /paper|تجريب/i.test(text);
  const simulator = /simulator|محاك/i.test(text);
  if (live && environment !== "LIVE") return true;
  if (paper && environment !== "PAPER") return true;
  if (simulator && environment !== "SIMULATOR") return true;
  return false;
}

function namedDuration(text: string): number | null {
  const hour = /(?:لمدة|خلال|for|next)?[^\d]{0,16}(\d+)\s*(?:ساعة|ساعات|hours?|h)(?![a-z])/i.exec(text);
  if (hour?.[1]) return Number(hour[1]) * HOUR;
  const minute = /(?:لمدة|for)[^\d]{0,8}(\d+)\s*(?:دقيقة|دقائق|minutes?|m)(?![a-z])/i.exec(text);
  if (minute?.[1]) return Number(minute[1]) * MINUTE;
  return null;
}

function namedInterval(text: string): number | null {
  const match = /(?:كل|every)\s*(\d+)\s*(?:دقيقة|دقائق|minutes?)/i.exec(text);
  if (!match?.[1]) return null;
  return Number(match[1]);
}

function rejected(): TradingDomainError {
  return new TradingDomainError("trading_store_rejected", "XAUUSD job request was rejected. Failing closed.");
}
