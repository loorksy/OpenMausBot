import { TradingDomainError, type TradingErrorCode } from "../../../../shared/trading/errors.ts";
import { parseTradingEvent, type TradingEvent, type TradingEventType } from "../../../../shared/trading/events.ts";
import type { MarketFreshness } from "../../../../shared/trading/snapshot.ts";
import { canonicalizeUtc } from "./clock.ts";
import {
  failureProvenance,
  MarketDataProviderError,
  redactMarketText,
  type MarketDataFailure,
  type MarketDataResult,
  type MarketRequest,
  type ProviderFailureKind,
  type XauUsdCandleSeries,
  type XauUsdQuote,
} from "./model.ts";
import type { CandleRange, XauUsdMarketDataProvider } from "./provider.ts";
import { normalizeTimeframe } from "./timeframe.ts";
import { validateCandles, validateQuote } from "./validate.ts";

function eventFor(kind: ProviderFailureKind): TradingEventType {
  if (kind === "future_timestamp" || kind === "malformed_response" || kind === "partial_response" || kind === "empty_response") {
    return "market.invalid";
  }
  if (kind === "unavailable") return "market.unavailable";
  if (kind === "stale_response") return "market.stale";
  return "market.provider_error";
}

function freshnessFor(kind: ProviderFailureKind): MarketFreshness {
  if (kind === "future_timestamp") return "future_dated";
  if (kind === "malformed_response" || kind === "partial_response" || kind === "empty_response") return "invalid";
  if (kind === "stale_response") return "stale";
  return "unavailable";
}

function failureResult(
  provider: XauUsdMarketDataProvider,
  request: MarketRequest,
  kind: ProviderFailureKind,
  message: string,
): MarketDataFailure {
  const provenance = failureProvenance(kind);
  const freshness = freshnessFor(kind);
  return {
    ok: false,
    failure: kind,
    provenance,
    freshness,
    providerId: provider.providerId,
    environment: provider.environment,
    message: redactMarketText(message),
    events: Object.freeze([emit(provider, request, eventFor(kind), {
      op: "read",
      providerId: provider.providerId,
      provenance,
      freshness,
      failure: kind,
      detail: redactMarketText(message),
    })]),
  };
}

function emit(
  provider: XauUsdMarketDataProvider,
  request: MarketRequest,
  type: TradingEventType,
  payload: Record<string, unknown>,
): TradingEvent {
  return parseTradingEvent({
    schemaVersion: 1,
    eventId: request.nextEventId(),
    type,
    source: "trading-domain",
    at: request.clock.processedAt,
    agentRunId: request.agentRunId,
    correlationId: request.correlationId,
    environment: provider.environment,
    instrument: "XAUUSD",
    actor: provider.providerId,
    payload,
  });
}

function fromError(
  provider: XauUsdMarketDataProvider,
  request: MarketRequest,
  error: unknown,
): MarketDataFailure {
  if (error instanceof MarketDataProviderError) {
    return failureResult(provider, request, error.kind, error.message);
  }
  if (error instanceof TradingDomainError) {
    return failureResult(provider, request, kindForCode(error.code), error.message);
  }
  const message = error instanceof Error ? error.message : "provider failed";
  return failureResult(provider, request, "unavailable", message);
}

function kindForCode(code: TradingErrorCode): ProviderFailureKind {
  if (code === "future_timestamp") return "future_timestamp";
  if (code === "unsupported_timeframe" || code === "conflicting_candles" || code === "instrument_rejected" || code === "market_data_rejected" || code === "silent_simulator_fallback") {
    return "malformed_response";
  }
  if (code === "provider_failure") return "unavailable";
  return "malformed_response";
}

async function callProvider(
  provider: XauUsdMarketDataProvider,
  request: MarketRequest,
  read: () => Promise<unknown>,
): Promise<MarketDataFailure | { raw: Extract<import("./model.ts").RawProviderResult, { ok: true }> }> {
  let raw: unknown;
  try {
    raw = await read();
  } catch (error) {
    return fromError(provider, request, error);
  }
  if (raw === null || raw === undefined || typeof raw !== "object" || !("ok" in raw)) {
    return failureResult(provider, request, "malformed_response", "provider response is malformed");
  }
  const body = raw as import("./model.ts").RawProviderResult;
  if (!body.ok) {
    return failureResult(provider, request, body.failure, body.message ?? body.failure);
  }
  return { raw: body };
}

export async function readXauUsdQuote(
  provider: XauUsdMarketDataProvider,
  request: MarketRequest,
): Promise<MarketDataResult<XauUsdQuote>> {
  const called = await callProvider(provider, request, () => provider.getXauUsdQuote());
  if (!("raw" in called)) return called;
  if (!called.raw.quote) return failureResult(provider, request, "partial_response", "quote is missing bid or ask");
  try {
    const data = Object.freeze(validateQuote({
      providerId: provider.providerId,
      environment: provider.environment,
      declaredProvenance: provider.successProvenance,
      instrument: called.raw.instrument,
      providerTimestamp: called.raw.providerTimestamp,
      provenance: called.raw.provenance,
      bid: called.raw.quote.bid,
      ask: called.raw.quote.ask,
      spread: called.raw.quote.spread,
      clock: request.clock,
    }));
    const type = data.freshness === "stale" ? "market.stale" : "market.quote.updated";
    return {
      ok: true,
      data,
      events: Object.freeze([emit(provider, request, type, {
        op: "quote",
        providerId: data.providerId,
        provenance: data.provenance,
        freshness: data.freshness,
        providerTimestamp: data.providerTimestamp,
        receivedAt: data.receivedAt,
        processedAt: data.processedAt,
        latencyMs: data.latencyMs,
        skewMs: data.skewMs,
        abnormalLatency: data.abnormalLatency,
        bid: data.bid,
        ask: data.ask,
        normalizations: data.normalizations,
      })]),
    };
  } catch (error) {
    return fromError(provider, request, error);
  }
}

export async function readXauUsdCandles(
  provider: XauUsdMarketDataProvider,
  timeframeInput: unknown,
  range: CandleRange,
  request: MarketRequest,
): Promise<MarketDataResult<XauUsdCandleSeries>> {
  let timeframe;
  let requestNormalization: string | undefined;
  try {
    const normalized = normalizeTimeframe(timeframeInput);
    timeframe = normalized.timeframe;
    requestNormalization = normalized.normalization;
    canonicalizeUtc(range.from);
    canonicalizeUtc(range.to);
  } catch (error) {
    return fromError(provider, request, error);
  }
  const called = await callProvider(provider, request, () => provider.getXauUsdCandles(timeframe, range));
  if (!("raw" in called)) return called;
  if (!called.raw.candles && called.raw.explicitEmpty !== true) {
    return failureResult(provider, request, "partial_response", "candle response is partial");
  }
  try {
    const data = Object.freeze(validateCandles({
      providerId: provider.providerId,
      environment: provider.environment,
      declaredProvenance: provider.successProvenance,
      instrument: called.raw.instrument,
      providerTimestamp: called.raw.providerTimestamp,
      provenance: called.raw.provenance,
      timeframe,
      requestNormalization,
      candles: called.raw.candles ?? [],
      asOf: request.clock.receivedAt,
      clock: request.clock,
    }));
    const type = data.freshness === "stale" ? "market.stale" : "market.candles.updated";
    return {
      ok: true,
      data,
      events: Object.freeze([emit(provider, request, type, {
        op: "candles",
        providerId: data.providerId,
        timeframe: data.timeframe,
        candleCount: data.candles.length,
        provenance: data.provenance,
        freshness: data.freshness,
        providerTimestamp: data.providerTimestamp,
        receivedAt: data.receivedAt,
        processedAt: data.processedAt,
        normalizations: data.normalizations,
      })]),
    };
  } catch (error) {
    return fromError(provider, request, error);
  }
}
