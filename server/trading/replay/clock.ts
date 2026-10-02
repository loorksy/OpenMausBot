import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { canonicalizeUtc } from "../infrastructure/market_data/clock.ts";

/** Clock contract for one replay session. This does not replace Date globally. */
export const REPLAY_CLOCK_VERSION = "xauusd-replay-clock-1";

export interface ReplayAdvance {
  readonly advanced: boolean;
  readonly at: string;
}

export interface ReplayClock {
  readonly version: typeof REPLAY_CLOCK_VERSION;
  readonly timezone: "UTC";
  readonly startAt: string;
  readonly endAt: string;
  currentAt(): string;
  now(): string;
  advanceTo(timestamp: string): ReplayAdvance;
  advanceBy(ms: number): ReplayAdvance;
}

/** Store an absolute instant as UTC with millisecond precision.
 * Offset inputs are converted. Naive timestamps are rejected. */
export function replayInstant(value: unknown): string {
  const parsed = canonicalizeUtc(value);
  return new Date(Date.parse(parsed.iso)).toISOString();
}

export function createReplayClock(input: { readonly startAt: unknown; readonly endAt: unknown }): ReplayClock {
  const startAt = replayInstant(input.startAt);
  const endAt = replayInstant(input.endAt);
  if (Date.parse(endAt) <= Date.parse(startAt)) {
    throw new TradingDomainError("replay_rejected", "replay end must be after the start");
  }
  let currentAt = startAt;
  const moveTo = (timestamp: string): ReplayAdvance => {
    const next = replayInstant(timestamp);
    const nextMs = Date.parse(next);
    const currentMs = Date.parse(currentAt);
    if (nextMs < currentMs) {
      throw new TradingDomainError("replay_rejected", "replay clock cannot move backwards");
    }
    if (nextMs < Date.parse(startAt)) {
      throw new TradingDomainError("replay_rejected", "replay clock cannot move before the start");
    }
    if (nextMs > Date.parse(endAt)) {
      throw new TradingDomainError("replay_rejected", "replay clock cannot pass the session end");
    }
    if (nextMs === currentMs) return { advanced: false, at: currentAt };
    currentAt = next;
    return { advanced: true, at: currentAt };
  };
  return {
    version: REPLAY_CLOCK_VERSION,
    timezone: "UTC",
    startAt,
    endAt,
    currentAt: () => currentAt,
    now: () => currentAt,
    advanceTo: moveTo,
    advanceBy(ms: number): ReplayAdvance {
      if (!Number.isInteger(ms)) {
        throw new TradingDomainError("replay_rejected", "replay advance must be an integer number of milliseconds");
      }
      if (ms < 0) {
        throw new TradingDomainError("replay_rejected", "replay clock cannot move backwards");
      }
      if (ms === 0) return { advanced: false, at: currentAt };
      return moveTo(new Date(Date.parse(currentAt) + ms).toISOString());
    },
  };
}
