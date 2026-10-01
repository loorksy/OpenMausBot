import { TradingDomainError } from "../../../../shared/trading/errors.ts";
import { parseTradingEvent, type TradingEvent } from "../../../../shared/trading/events.ts";
import { parseXauUsdContext, type XauUsdContext } from "../../../../shared/trading/context.ts";
import { parseMarketSnapshot, type MarketSnapshot } from "../../../../shared/trading/snapshot.ts";
import { barCloseMs } from "./timeframe.ts";
import type { MarketRequest, XauUsdCandleSeries, XauUsdQuote } from "./model.ts";

export interface SealedXauUsdMarket {
  readonly snapshot: MarketSnapshot;
  readonly events: readonly TradingEvent[];
}

/** Seal a Phase 1 snapshot from data already validated for this clock.
 * The result does not keep a reference to the provider's mutable arrays. */
export function createXauUsdMarketSnapshot(input: {
  readonly id: string;
  readonly request: MarketRequest;
  readonly quote?: XauUsdQuote;
  readonly series?: XauUsdCandleSeries;
}): SealedXauUsdMarket {
  const { quote, series, request } = input;
  if (!quote && !series) {
    throw new TradingDomainError("market_data_rejected", "a snapshot needs a quote or candles");
  }
  if (quote && series) {
    if (quote.providerId !== series.providerId || quote.environment !== series.environment || quote.provenance !== series.provenance || quote.freshness !== series.freshness) {
      throw new TradingDomainError("market_data_rejected", "quote and candles disagree; refusing to hide a provider state");
    }
  }
  const source = quote ?? series;
  if (!source) throw new TradingDomainError("market_data_rejected", "a snapshot needs a quote or candles");
  const capturedMs = Date.parse(request.clock.receivedAt);
  if (quote && Date.parse(quote.providerTimestamp) > capturedMs + request.clock.limits.futureSkewMs) {
    throw new TradingDomainError("future_timestamp", "quote is after the snapshot clock");
  }
  const candles = (series?.candles ?? []).map((candle) => {
    if (barCloseMs(candle.time, candle.timeframe) > capturedMs) {
      throw new TradingDomainError("future_timestamp", "candle close is after the snapshot clock");
    }
    return { ...candle };
  });
  const snapshot = parseMarketSnapshot({
    schemaVersion: 1,
    id: input.id,
    agentRunId: request.agentRunId,
    environment: source.environment,
    instrument: "XAUUSD",
    createdAt: request.clock.processedAt,
    capturedAt: request.clock.receivedAt,
    provider: source.providerId,
    providerTimestamp: source.providerTimestamp,
    receivedAt: source.receivedAt,
    processedAt: source.processedAt,
    provenance: source.provenance,
    latencyMs: source.latencyMs,
    freshness: source.freshness,
    versionManifestId: request.versionManifestId,
    normalizations: [...(quote?.normalizations ?? []), ...(series?.normalizations ?? [])],
    ...(quote ? { bid: quote.bid, ask: quote.ask, spread: quote.spread } : {}),
    candles,
  });
  const event = parseTradingEvent({
    schemaVersion: 1,
    eventId: request.nextEventId(),
    type: "market.snapshot.created",
    source: "trading-domain",
    at: request.clock.processedAt,
    agentRunId: request.agentRunId,
    correlationId: request.correlationId,
    environment: snapshot.environment,
    instrument: "XAUUSD",
    actor: snapshot.provider,
    ...(request.runtime ? {
      runtimeEventId: request.runtime.eventId,
      runtimeThreadId: request.runtime.threadId,
      runtimeTurnId: request.runtime.turnId,
    } : {}),
    payload: {
      snapshotId: snapshot.id,
      provenance: snapshot.provenance,
      freshness: snapshot.freshness,
      providerTimestamp: snapshot.providerTimestamp,
      receivedAt: snapshot.receivedAt,
      candleCount: snapshot.candles.length,
    },
  });
  return { snapshot, events: Object.freeze([event]) };
}

/** Market-data portion of a context. It copies the sealed snapshot.
 * It does not run analysis, regime detection, or decisions. */
export function buildXauUsdMarketContext(
  snapshot: MarketSnapshot,
  input: { readonly id: string; readonly evidenceIds?: readonly string[] },
): XauUsdContext {
  if (!snapshot.versionManifestId) {
    throw new TradingDomainError("market_data_rejected", "snapshot is missing a version manifest id");
  }
  return parseXauUsdContext({
    schemaVersion: 1,
    id: input.id,
    agentRunId: snapshot.agentRunId,
    environment: snapshot.environment,
    instrument: "XAUUSD",
    snapshotId: snapshot.id,
    evidenceIds: input.evidenceIds ?? [],
    versionManifestId: snapshot.versionManifestId,
    asOf: snapshot.capturedAt,
    provenance: snapshot.provenance,
    createdAt: snapshot.processedAt ?? snapshot.createdAt,
  });
}
