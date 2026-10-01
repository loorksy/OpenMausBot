import type { MarketFreshness, ProvenanceStatus, TradingEnvironment, TradingEvent, XauUsdCandle, XauUsdTimeframe } from "../../../../shared/trading/index.ts";

/** Quality limits for labeling quotes and bars. These are not execution gates. */
export interface MarketClockLimits {
  readonly staleAfterMs: number;
  readonly futureSkewMs: number;
  readonly abnormalLatencyMs: number;
}

/** Caller-supplied UTC clock. The market-data layer does not read Date.now. */
export interface MarketClock {
  readonly receivedAt: string;
  readonly processedAt: string;
  readonly limits: MarketClockLimits;
}

export interface MarketRequest {
  readonly agentRunId: string;
  readonly correlationId: string;
  readonly versionManifestId: string;
  readonly clock: MarketClock;
  nextEventId(): string;
}

export const PROVIDER_FAILURE_KINDS = [
  "timeout",
  "malformed_response",
  "authentication_failure",
  "rate_limit",
  "network_failure",
  "empty_response",
  "future_timestamp",
  "stale_response",
  "partial_response",
  "unavailable",
] as const;

export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KINDS)[number];

export interface RawCandleInput {
  readonly timeframe?: unknown;
  readonly time: unknown;
  readonly open: unknown;
  readonly high: unknown;
  readonly low: unknown;
  readonly close: unknown;
  readonly volume?: unknown;
}

/** Untrusted provider body. Provenance on a failure is ignored. */
export type RawProviderResult =
  | {
    readonly ok: true;
    readonly providerTimestamp: unknown;
    readonly provenance: unknown;
    readonly instrument: unknown;
    readonly quote?: { readonly bid: unknown; readonly ask: unknown; readonly spread?: unknown };
    readonly candles?: readonly RawCandleInput[];
    readonly explicitEmpty?: boolean;
  }
  | {
    readonly ok: false;
    readonly failure: ProviderFailureKind;
    readonly message?: string;
  };

export interface XauUsdQuote {
  readonly instrument: "XAUUSD";
  readonly bid: number;
  readonly ask: number;
  readonly spread: number;
  readonly providerId: string;
  readonly providerTimestamp: string;
  readonly receivedAt: string;
  readonly processedAt: string;
  readonly latencyMs: number;
  readonly skewMs: number;
  readonly abnormalLatency: boolean;
  readonly environment: TradingEnvironment;
  readonly provenance: ProvenanceStatus;
  readonly freshness: MarketFreshness;
  readonly normalizations: readonly string[];
}

export interface XauUsdCandleSeries {
  readonly instrument: "XAUUSD";
  readonly timeframe: XauUsdTimeframe;
  readonly candles: readonly XauUsdCandle[];
  readonly providerId: string;
  readonly providerTimestamp: string;
  readonly receivedAt: string;
  readonly processedAt: string;
  readonly latencyMs: number;
  readonly skewMs: number;
  readonly abnormalLatency: boolean;
  readonly environment: TradingEnvironment;
  readonly provenance: ProvenanceStatus;
  readonly freshness: MarketFreshness;
  readonly normalizations: readonly string[];
}

export interface MarketDataFailure {
  readonly ok: false;
  readonly failure: ProviderFailureKind;
  readonly provenance: "UNAVAILABLE" | "STALE";
  readonly freshness: MarketFreshness;
  readonly providerId: string;
  readonly environment: TradingEnvironment;
  readonly message: string;
  readonly events: readonly TradingEvent[];
}

export interface MarketDataSuccess<T> {
  readonly ok: true;
  readonly data: T;
  readonly events: readonly TradingEvent[];
}

export type MarketDataResult<T> = MarketDataSuccess<T> | MarketDataFailure;

export class MarketDataProviderError extends Error {
  readonly kind: ProviderFailureKind;

  constructor(kind: ProviderFailureKind, message: string) {
    super(message);
    this.name = "MarketDataProviderError";
    this.kind = kind;
  }
}

/** A failed live read is stale or unavailable. It is never simulator data. */
export function failureProvenance(kind: ProviderFailureKind): "UNAVAILABLE" | "STALE" {
  return kind === "stale_response" ? "STALE" : "UNAVAILABLE";
}

export function redactMarketText(value: string): string {
  return value
    .replace(/bearer\s+\S+/gi, "bearer [redacted]")
    .replace(/\b((?:api[_-]?key|token|secret|password)\s*[:=]\s*)\S+/gi, "$1[redacted]")
    .slice(0, 300);
}
