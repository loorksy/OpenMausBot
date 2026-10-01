import { TradingDomainError } from "../../../../shared/trading/errors.ts";
import { assertProvenanceForEnvironment, type ProvenanceStatus, type TradingEnvironment } from "../../../../shared/trading/environment.ts";
import { XAUUSD_INSTRUMENT } from "../../../../shared/trading/instrument.ts";
import type { MarketFreshness } from "../../../../shared/trading/snapshot.ts";
import type { XauUsdCandle, XauUsdTimeframe } from "../../../../shared/trading/snapshot.ts";
import { assessClock, canonicalizeUtc } from "./clock.ts";
import type { MarketClock, RawCandleInput, XauUsdCandleSeries, XauUsdQuote } from "./model.ts";
import { barCloseMs, normalizeTimeframe } from "./timeframe.ts";

function note(notes: string[], normalization: string | undefined): void {
  if (normalization) notes.push(normalization);
}

function parseDecimal(value: unknown, label: string, notes: string[]): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TradingDomainError("market_data_rejected", `${label} is not finite`);
    return value;
  }
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (!Number.isFinite(parsed)) throw new TradingDomainError("market_data_rejected", `${label} is not finite`);
    note(notes, `${label} numeric string coerced`);
    return parsed;
  }
  throw new TradingDomainError("market_data_rejected", `${label} is malformed`);
}

function positivePrice(value: unknown, label: string, notes: string[]): number {
  const price = parseDecimal(value, label, notes);
  if (price <= 0) throw new TradingDomainError("market_data_rejected", `${label} must be positive`);
  return price;
}

export function assertXauUsdInstrument(value: unknown): void {
  if (value !== XAUUSD_INSTRUMENT) {
    throw new TradingDomainError("instrument_rejected", "market data must be XAUUSD");
  }
}

export function resolveSuccessProvenance(
  environment: TradingEnvironment,
  declared: ProvenanceStatus,
  reported: ProvenanceStatus,
  freshness: MarketFreshness,
): { provenance: ProvenanceStatus; normalizations: string[] } {
  if (reported !== declared) {
    throw new TradingDomainError("market_data_rejected", "payload provenance does not match the provider");
  }
  assertProvenanceForEnvironment(environment, reported);
  if (reported === "UNAVAILABLE") {
    throw new TradingDomainError("provider_failure", "a success payload cannot be UNAVAILABLE");
  }
  if (reported === "LIVE" && freshness === "stale") {
    return {
      provenance: "STALE",
      normalizations: ["LIVE quote labeled STALE from the caller clock"],
    };
  }
  return { provenance: reported, normalizations: [] };
}

export function validateQuote(input: {
  providerId: string;
  environment: TradingEnvironment;
  declaredProvenance: ProvenanceStatus;
  instrument: unknown;
  providerTimestamp: unknown;
  provenance: unknown;
  bid: unknown;
  ask: unknown;
  spread?: unknown;
  clock: MarketClock;
}): XauUsdQuote {
  const notes: string[] = [];
  assertXauUsdInstrument(input.instrument);
  if (input.bid === undefined || input.ask === undefined || input.bid === null || input.ask === null) {
    throw new TradingDomainError("market_data_rejected", "quote is missing bid or ask");
  }
  const stamped = canonicalizeUtc(input.providerTimestamp);
  note(notes, stamped.normalization);
  const received = canonicalizeUtc(input.clock.receivedAt);
  const processed = canonicalizeUtc(input.clock.processedAt);
  const clock = assessClock(stamped.iso, {
    ...input.clock,
    receivedAt: received.iso,
    processedAt: processed.iso,
  });
  if (clock.futureDated) {
    throw new TradingDomainError("future_timestamp", "provider timestamp is in the future");
  }
  if (input.provenance !== "LIVE" && input.provenance !== "STALE" && input.provenance !== "SIMULATOR" && input.provenance !== "UNAVAILABLE") {
    throw new TradingDomainError("market_data_rejected", "provenance is missing");
  }
  const resolved = resolveSuccessProvenance(input.environment, input.declaredProvenance, input.provenance, clock.freshness);
  const bid = positivePrice(input.bid, "bid", notes);
  const ask = positivePrice(input.ask, "ask", notes);
  if (bid > ask) throw new TradingDomainError("market_data_rejected", "bid cannot exceed ask");
  let spread: number;
  if (input.spread === undefined) {
    spread = ask - bid;
    note(notes, "spread derived from ask-bid");
  } else {
    spread = parseDecimal(input.spread, "spread", notes);
    if (spread < 0) throw new TradingDomainError("market_data_rejected", "spread cannot be negative");
    if (Math.abs(spread - (ask - bid)) > 1e-8) {
      throw new TradingDomainError("market_data_rejected", "spread conflicts with ask-bid");
    }
  }
  return {
    instrument: "XAUUSD",
    bid,
    ask,
    spread,
    providerId: input.providerId,
    providerTimestamp: stamped.iso,
    receivedAt: received.iso,
    processedAt: processed.iso,
    latencyMs: clock.latencyMs,
    skewMs: clock.skewMs,
    abnormalLatency: clock.abnormalLatency,
    environment: input.environment,
    provenance: resolved.provenance,
    freshness: clock.freshness,
    normalizations: Object.freeze([...notes, ...resolved.normalizations]),
  };
}

function candleSignature(candle: XauUsdCandle): string {
  return `${candle.open}|${candle.high}|${candle.low}|${candle.close}|${candle.volume ?? ""}`;
}

export function validateCandles(input: {
  providerId: string;
  environment: TradingEnvironment;
  declaredProvenance: ProvenanceStatus;
  instrument: unknown;
  providerTimestamp: unknown;
  provenance: unknown;
  timeframe: XauUsdTimeframe;
  requestNormalization?: string;
  candles: readonly RawCandleInput[];
  asOf: string;
  clock: MarketClock;
}): XauUsdCandleSeries {
  const notes: string[] = [];
  note(notes, input.requestNormalization);
  assertXauUsdInstrument(input.instrument);
  const stamped = canonicalizeUtc(input.providerTimestamp);
  note(notes, stamped.normalization);
  const received = canonicalizeUtc(input.clock.receivedAt);
  const processed = canonicalizeUtc(input.clock.processedAt);
  const asOf = canonicalizeUtc(input.asOf);
  const clock = assessClock(stamped.iso, {
    ...input.clock,
    receivedAt: received.iso,
    processedAt: processed.iso,
  });
  if (clock.futureDated) {
    throw new TradingDomainError("future_timestamp", "provider response timestamp is in the future");
  }
  if (input.provenance !== "LIVE" && input.provenance !== "STALE" && input.provenance !== "SIMULATOR" && input.provenance !== "UNAVAILABLE") {
    throw new TradingDomainError("market_data_rejected", "provenance is missing");
  }
  const resolved = resolveSuccessProvenance(input.environment, input.declaredProvenance, input.provenance, clock.freshness);
  const parsed: XauUsdCandle[] = [];
  const seen = new Map<number, string>();
  let unsorted = false;
  let previousOpen = Number.NEGATIVE_INFINITY;
  for (const raw of input.candles) {
    const barNotes: string[] = [];
    const timeframe = normalizeTimeframe(raw.timeframe ?? input.timeframe);
    if (timeframe.timeframe !== input.timeframe) {
      throw new TradingDomainError("unsupported_timeframe", "candle timeframe does not match the request");
    }
    note(barNotes, timeframe.normalization);
    const time = canonicalizeUtc(raw.time);
    note(barNotes, time.normalization);
    const open = positivePrice(raw.open, "open", barNotes);
    const high = positivePrice(raw.high, "high", barNotes);
    const low = positivePrice(raw.low, "low", barNotes);
    const close = positivePrice(raw.close, "close", barNotes);
    if (high < low || high < open || high < close || low > open || low > close) {
      throw new TradingDomainError("market_data_rejected", "OHLC range is impossible");
    }
    let volume: number | undefined;
    if (raw.volume !== undefined) {
      volume = parseDecimal(raw.volume, "volume", barNotes);
      if (volume < 0) throw new TradingDomainError("market_data_rejected", "volume cannot be negative");
    }
    const candle: XauUsdCandle = {
      timeframe: input.timeframe,
      time: time.iso,
      open,
      high,
      low,
      close,
      ...(volume !== undefined ? { volume } : {}),
    };
    const openMs = Date.parse(time.iso);
    if (barCloseMs(time.iso, input.timeframe) > Date.parse(asOf.iso)) {
      throw new TradingDomainError("future_timestamp", "candle close is after the snapshot clock");
    }
    const signature = candleSignature(candle);
    const prior = seen.get(openMs);
    if (prior !== undefined) {
      throw new TradingDomainError(
        "conflicting_candles",
        prior === signature ? "duplicate candle" : "conflicting candle",
      );
    }
    seen.set(openMs, signature);
    if (openMs < previousOpen) unsorted = true;
    previousOpen = openMs;
    parsed.push(candle);
    for (const item of barNotes) note(notes, item);
  }
  if (unsorted) {
    parsed.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    note(notes, "candles sorted by open time");
  }
  return {
    instrument: "XAUUSD",
    timeframe: input.timeframe,
    candles: Object.freeze(parsed),
    providerId: input.providerId,
    providerTimestamp: stamped.iso,
    receivedAt: received.iso,
    processedAt: processed.iso,
    latencyMs: clock.latencyMs,
    skewMs: clock.skewMs,
    abnormalLatency: clock.abnormalLatency,
    environment: input.environment,
    provenance: resolved.provenance,
    freshness: clock.freshness,
    normalizations: Object.freeze([...notes, ...resolved.normalizations]),
  };
}
