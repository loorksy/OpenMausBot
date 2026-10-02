import { latestIntervalOccurrence, nextOccurrence } from "../../routines.ts";
import type { XauUsdJob } from "./model.ts";

/** Interval phase comes from the job anchor, using the routine scheduler's
 * occurrence math. A wake that runs long does not move the next slot. */
export function epochMs(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("timestamp");
  }
  return parsed;
}

export function isoFromEpoch(value: number): string {
  return new Date(value).toISOString();
}

export function nextScheduledWake(job: Pick<XauUsdJob, "startAt" | "endAt" | "everyMinutes">, afterIso: string): string | null {
  const next = nextOccurrence({
    type: "interval",
    everyMinutes: job.everyMinutes,
    anchorAt: epochMs(job.startAt),
    endsAt: epochMs(job.endAt),
  }, epochMs(afterIso));
  if (next === null || next >= epochMs(job.endAt)) return null;
  return isoFromEpoch(next);
}

/** One slot for a late process: the latest interval at or before `now` that
 * is still inside the job. Earlier missed slots are not returned. */
export function collapsedWakeSlot(
  job: Pick<XauUsdJob, "startAt" | "endAt" | "everyMinutes" | "nextWakeAt">,
  nowIso: string,
): string | null {
  if (job.nextWakeAt === null) return null;
  const now = epochMs(nowIso);
  const endAt = epochMs(job.endAt);
  if (now >= endAt) return null;
  const latest = latestIntervalOccurrence({
    type: "interval",
    everyMinutes: job.everyMinutes,
    anchorAt: epochMs(job.startAt),
    endsAt: endAt - 1,
  }, now);
  if (latest === null || latest < epochMs(job.nextWakeAt) || latest >= endAt) return null;
  return isoFromEpoch(latest);
}
