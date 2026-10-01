import { TradingDomainError } from "../../../../shared/trading/errors.ts";
import type { MarketFreshness } from "../../../../shared/trading/snapshot.ts";
import type { MarketClock, MarketClockLimits } from "./model.ts";

const ZULU = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?[+-]\d{2}:\d{2}$/;

/** Store a provider instant as UTC. The original offset is recorded.
 * The provider timestamp is not replaced with server time. */
export function canonicalizeUtc(value: unknown): { iso: string; normalization?: string } {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TradingDomainError("market_data_rejected", "timestamp is missing");
  }
  const text = value.trim();
  if (ZULU.test(text)) {
    if (Number.isNaN(Date.parse(text))) {
      throw new TradingDomainError("market_data_rejected", "timestamp is not a real instant");
    }
    return { iso: text };
  }
  if (!OFFSET.test(text) || Number.isNaN(Date.parse(text))) {
    throw new TradingDomainError("market_data_rejected", "timestamp must be an absolute UTC instant");
  }
  const iso = new Date(Date.parse(text)).toISOString();
  return { iso, normalization: `timestamp ${text} stored as ${iso}` };
}

export function assertClockLimits(limits: MarketClockLimits): void {
  for (const [name, value] of Object.entries(limits) as [keyof MarketClockLimits, number][]) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new TradingDomainError("market_data_rejected", `${name} must be a non-negative finite number`);
    }
  }
}

export interface ClockAssessment {
  readonly latencyMs: number;
  readonly skewMs: number;
  readonly freshness: MarketFreshness;
  readonly abnormalLatency: boolean;
  readonly futureDated: boolean;
}

/** skewMs is receivedAt minus providerTimestamp. Positive means the provider
 * clock is behind. Negative means the provider stamped a future instant. */
export function assessClock(providerTimestamp: string, clock: MarketClock): ClockAssessment {
  assertClockLimits(clock.limits);
  const providerMs = Date.parse(providerTimestamp);
  const receivedMs = Date.parse(clock.receivedAt);
  const processedMs = Date.parse(clock.processedAt);
  if (Number.isNaN(providerMs) || Number.isNaN(receivedMs) || Number.isNaN(processedMs)) {
    throw new TradingDomainError("market_data_rejected", "clock timestamps are invalid");
  }
  const latencyMs = processedMs - receivedMs;
  if (latencyMs < 0) {
    throw new TradingDomainError("market_data_rejected", "processedAt is before receivedAt");
  }
  const skewMs = receivedMs - providerMs;
  const futureDated = skewMs < -clock.limits.futureSkewMs;
  const freshness: MarketFreshness = futureDated
    ? "future_dated"
    : skewMs > clock.limits.staleAfterMs
      ? "stale"
      : "fresh";
  return {
    latencyMs,
    skewMs,
    freshness,
    abnormalLatency: latencyMs > clock.limits.abnormalLatencyMs,
    futureDated,
  };
}
