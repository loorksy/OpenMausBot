import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { replayInstant } from "../replay/clock.ts";

/** One explicit observation time. Sequence is the schedule index. */
export interface ObservationPoint {
  readonly sequence: number;
  readonly at: string;
}

/** Deterministic observation times. There is no interval loop and no clock
 * read from the process. Equal or decreasing instants are rejected. */
export function createObservationSchedule(
  timestamps: readonly unknown[],
  startAt: string,
  endAt: string,
): readonly ObservationPoint[] {
  if (timestamps.length === 0) {
    throw new TradingDomainError("evaluation_rejected", "evaluation schedule is empty");
  }
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  const points: ObservationPoint[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const value of timestamps) {
    const at = replayInstant(value);
    const atMs = Date.parse(at);
    if (atMs < startMs || atMs > endMs) {
      throw new TradingDomainError("evaluation_rejected", "observation time is outside the replay window");
    }
    if (atMs <= previous) {
      throw new TradingDomainError("evaluation_rejected", "observation times must increase");
    }
    previous = atMs;
    points.push({ sequence: points.length, at });
  }
  return points;
}
