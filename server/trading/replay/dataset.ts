import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { assertNoSecretFields, recordIdSchema, seal } from "../../../shared/trading/ids.ts";
import { XAUUSD_TIMEFRAMES, type XauUsdCandle, type XauUsdTimeframe } from "../../../shared/trading/snapshot.ts";
import type { MarketClock } from "../infrastructure/market_data/model.ts";
import { TIMEFRAME_MS, normalizeTimeframe } from "../infrastructure/market_data/timeframe.ts";
import { validateCandles, validateQuote } from "../infrastructure/market_data/validate.ts";
import { contentHash } from "./hash.ts";
import { replayInstant } from "./clock.ts";

/** Equal market timestamps sort by kind, then timeframe, then input sequence.
 * Sequence is the index in the submitted array. Object key order is not used. */
export const REPLAY_ORDERING_RULE = "time,kind,timeframe,seq" as const;

export const REPLAY_DATASET_SCHEMA_VERSION = 1 as const;

const KIND_RANK = { quote: 0, print: 1, candle: 2 } as const;

const DATASET_KEYS = [
  "schemaVersion",
  "datasetId",
  "datasetVersion",
  "instrument",
  "source",
  "timezone",
  "coverageStart",
  "coverageEnd",
  "quotes",
  "candles",
  "prints",
  "contentHash",
] as const;

const QUOTE_KEYS = ["time", "bid", "ask", "spread"] as const;
const CANDLE_KEYS = ["timeframe", "time", "open", "high", "low", "close", "volume"] as const;
const PRINT_KEYS = ["time", "price", "volume"] as const;

export interface ReplayQuote {
  readonly seq: number;
  readonly time: string;
  readonly bid: number;
  readonly ask: number;
  readonly spread: number;
}

export interface ReplayPrint {
  readonly seq: number;
  readonly time: string;
  readonly price: number;
  readonly volume?: number;
}

export interface ReplayMarketEvent {
  readonly seq: number;
  readonly kind: "quote" | "print" | "candle";
  readonly time: string;
  readonly timeframe?: XauUsdTimeframe;
}

export interface ReplayDataset {
  readonly schemaVersion: typeof REPLAY_DATASET_SCHEMA_VERSION;
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly fingerprint: string;
  readonly instrument: "XAUUSD";
  readonly source: string;
  readonly timezone: "UTC";
  readonly coverageStart: string;
  readonly coverageEnd: string;
  readonly quotes: readonly ReplayQuote[];
  readonly candles: Readonly<Record<XauUsdTimeframe, readonly XauUsdCandle[]>>;
  readonly prints: readonly ReplayPrint[];
  readonly events: readonly ReplayMarketEvent[];
  readonly orderingRule: typeof REPLAY_ORDERING_RULE;
}

export interface ReplayDatasetInput {
  readonly schemaVersion: 1;
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly instrument: "XAUUSD";
  readonly source: string;
  readonly timezone: "UTC";
  readonly coverageStart: string;
  readonly coverageEnd: string;
  readonly quotes?: readonly Record<string, unknown>[];
  readonly candles?: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  readonly prints?: readonly Record<string, unknown>[];
  readonly contentHash?: string;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TradingDomainError("replay_rejected", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new TradingDomainError("replay_rejected", `${label} field ${key} is not part of the dataset contract`);
    }
  }
}

function versionField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > 128) {
    throw new TradingDomainError("replay_rejected", `${label} is missing`);
  }
  return value.trim();
}

function emptyCandles(): Record<XauUsdTimeframe, XauUsdCandle[]> {
  return { M1: [], M5: [], M15: [], M30: [], H1: [], H4: [], D1: [] };
}

function timeframeIndex(timeframe: XauUsdTimeframe | undefined): number {
  if (!timeframe) return -1;
  return XAUUSD_TIMEFRAMES.indexOf(timeframe);
}

function compareEvents(a: ReplayMarketEvent, b: ReplayMarketEvent): number {
  const time = Date.parse(a.time) - Date.parse(b.time);
  if (time !== 0) return time;
  const kind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (kind !== 0) return kind;
  const frame = timeframeIndex(a.timeframe) - timeframeIndex(b.timeframe);
  if (frame !== 0) return frame;
  return a.seq - b.seq;
}

/** Load an immutable local XAUUSD dataset. Malformed bars are rejected.
 * The fingerprint changes when the canonical contents change. */
export function createReplayDataset(input: ReplayDatasetInput): ReplayDataset {
  assertNoSecretFields(input, "replay dataset");
  const record = asRecord(input, "replay dataset");
  assertKeys(record, DATASET_KEYS, "replay dataset");
  if (input.schemaVersion !== REPLAY_DATASET_SCHEMA_VERSION) {
    throw new TradingDomainError("replay_rejected", "replay dataset schema version is not supported");
  }
  if (!recordIdSchema.safeParse(input.datasetId).success) {
    throw new TradingDomainError("replay_rejected", "dataset id is not a valid id");
  }
  const datasetVersion = versionField(input.datasetVersion, "dataset version");
  if (input.instrument !== "XAUUSD") {
    throw new TradingDomainError("instrument_rejected", "replay data must be XAUUSD");
  }
  if (input.timezone !== "UTC") {
    throw new TradingDomainError("replay_rejected", "replay dataset timezone must be UTC");
  }
  const source = versionField(input.source, "dataset source");
  const coverageStart = replayInstant(input.coverageStart);
  const coverageEnd = replayInstant(input.coverageEnd);
  if (Date.parse(coverageEnd) <= Date.parse(coverageStart)) {
    throw new TradingDomainError("replay_rejected", "dataset coverage end must be after the start");
  }
  const clock: MarketClock = {
    receivedAt: coverageEnd,
    processedAt: coverageEnd,
    limits: {
      staleAfterMs: Number.MAX_SAFE_INTEGER,
      futureSkewMs: 0,
      abnormalLatencyMs: Number.MAX_SAFE_INTEGER,
    },
  };
  const quotes = loadQuotes(input.quotes ?? [], coverageStart, coverageEnd, clock, input.datasetId);
  const candles = loadCandles(input.candles ?? {}, coverageStart, coverageEnd, clock, input.datasetId);
  const prints = loadPrints(input.prints ?? [], coverageStart, coverageEnd);
  const events = orderEvents(quotes, prints, candles);
  const fingerprint = contentHash({
    schemaVersion: REPLAY_DATASET_SCHEMA_VERSION,
    datasetId: input.datasetId,
    datasetVersion,
    instrument: "XAUUSD",
    source,
    timezone: "UTC",
    coverageStart,
    coverageEnd,
    quotes: quotes.map((quote) => ({
      time: quote.time,
      bid: quote.bid,
      ask: quote.ask,
      spread: quote.spread,
    })),
    candles: XAUUSD_TIMEFRAMES.flatMap((timeframe) => (
      candles[timeframe].length === 0
        ? []
        : [{
          timeframe,
          bars: candles[timeframe].map((candle) => ({
            time: candle.time,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            ...(candle.volume !== undefined ? { volume: candle.volume } : {}),
          })),
        }]
    )),
    prints: prints.map((print) => ({
      time: print.time,
      price: print.price,
      ...(print.volume !== undefined ? { volume: print.volume } : {}),
    })),
  });
  if (input.contentHash !== undefined && input.contentHash !== fingerprint) {
    throw new TradingDomainError("replay_rejected", "dataset content hash does not match its contents");
  }
  return seal({
    schemaVersion: REPLAY_DATASET_SCHEMA_VERSION,
    datasetId: input.datasetId,
    datasetVersion,
    fingerprint,
    instrument: "XAUUSD" as const,
    source,
    timezone: "UTC" as const,
    coverageStart,
    coverageEnd,
    quotes,
    candles,
    prints,
    events,
    orderingRule: REPLAY_ORDERING_RULE,
  });
}

function loadQuotes(
  rows: readonly Record<string, unknown>[],
  coverageStart: string,
  coverageEnd: string,
  clock: MarketClock,
  datasetId: string,
): ReplayQuote[] {
  const seen = new Set<number>();
  const quotes: ReplayQuote[] = [];
  rows.forEach((row, seq) => {
    assertKeys(row, QUOTE_KEYS, "quote");
    const time = replayInstant(row.time);
    const timeMs = Date.parse(time);
    if (timeMs < Date.parse(coverageStart) || timeMs > Date.parse(coverageEnd)) {
      throw new TradingDomainError("replay_rejected", "quote is outside dataset coverage");
    }
    if (seen.has(timeMs)) throw new TradingDomainError("replay_rejected", "duplicate quote timestamp");
    seen.add(timeMs);
    const validated = validateQuote({
      providerId: `replay:${datasetId}`,
      environment: "SIMULATOR",
      declaredProvenance: "REPLAY",
      instrument: "XAUUSD",
      providerTimestamp: time,
      provenance: "REPLAY",
      bid: row.bid,
      ask: row.ask,
      spread: row.spread,
      clock,
    });
    quotes.push({ seq, time: validated.providerTimestamp, bid: validated.bid, ask: validated.ask, spread: validated.spread });
  });
  quotes.sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || a.seq - b.seq);
  return quotes;
}

function loadCandles(
  raw: Readonly<Record<string, readonly Record<string, unknown>[]>>,
  coverageStart: string,
  coverageEnd: string,
  clock: MarketClock,
  datasetId: string,
): Record<XauUsdTimeframe, XauUsdCandle[]> {
  assertKeys(asRecord(raw, "candles"), XAUUSD_TIMEFRAMES, "candles");
  const candles = emptyCandles();
  for (const timeframe of XAUUSD_TIMEFRAMES) {
    const rows = raw[timeframe];
    if (!rows) continue;
    if (!Array.isArray(rows)) throw new TradingDomainError("replay_rejected", "candles must be an array");
    const seen = new Set<number>();
    const prepared = rows.map((row) => {
      assertKeys(row, CANDLE_KEYS, "candle");
      const named = row.timeframe === undefined ? timeframe : normalizeTimeframe(row.timeframe).timeframe;
      if (named !== timeframe) {
        throw new TradingDomainError("unsupported_timeframe", "candle timeframe does not match its series");
      }
      const time = replayInstant(row.time);
      const openMs = Date.parse(time);
      if (openMs % TIMEFRAME_MS[timeframe] !== 0) {
        throw new TradingDomainError("replay_rejected", "candle open is not aligned to the timeframe");
      }
      const closeMs = openMs + TIMEFRAME_MS[timeframe];
      if (openMs < Date.parse(coverageStart) || closeMs > Date.parse(coverageEnd)) {
        throw new TradingDomainError("replay_rejected", "candle is outside dataset coverage");
      }
      if (seen.has(openMs)) throw new TradingDomainError("conflicting_candles", "duplicate candle");
      seen.add(openMs);
      return {
        timeframe,
        time,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        ...(row.volume !== undefined ? { volume: row.volume } : {}),
      };
    });
    const validated = validateCandles({
      providerId: `replay:${datasetId}`,
      environment: "SIMULATOR",
      declaredProvenance: "REPLAY",
      instrument: "XAUUSD",
      providerTimestamp: coverageEnd,
      provenance: "REPLAY",
      timeframe,
      candles: prepared,
      asOf: coverageEnd,
      clock,
    });
    candles[timeframe] = validated.candles.map((candle) => ({ ...candle }));
  }
  return candles;
}

function loadPrints(
  rows: readonly Record<string, unknown>[],
  coverageStart: string,
  coverageEnd: string,
): ReplayPrint[] {
  const seen = new Set<string>();
  const prints: ReplayPrint[] = [];
  rows.forEach((row, seq) => {
    assertKeys(row, PRINT_KEYS, "print");
    const time = replayInstant(row.time);
    const timeMs = Date.parse(time);
    if (timeMs < Date.parse(coverageStart) || timeMs > Date.parse(coverageEnd)) {
      throw new TradingDomainError("replay_rejected", "print is outside dataset coverage");
    }
    if (typeof row.price !== "number" || !Number.isFinite(row.price) || row.price <= 0) {
      throw new TradingDomainError("market_data_rejected", "print price must be positive");
    }
    let volume: number | undefined;
    if (row.volume !== undefined) {
      if (typeof row.volume !== "number" || !Number.isFinite(row.volume) || row.volume < 0) {
        throw new TradingDomainError("market_data_rejected", "print volume cannot be negative");
      }
      volume = row.volume;
    }
    const signature = `${timeMs}|${row.price}|${volume ?? ""}`;
    if (seen.has(signature)) throw new TradingDomainError("replay_rejected", "duplicate print");
    seen.add(signature);
    prints.push({ seq, time, price: row.price, ...(volume !== undefined ? { volume } : {}) });
  });
  prints.sort((a, b) => compareEvents(
    { seq: a.seq, kind: "print", time: a.time },
    { seq: b.seq, kind: "print", time: b.time },
  ));
  return prints;
}

function orderEvents(
  quotes: readonly ReplayQuote[],
  prints: readonly ReplayPrint[],
  candles: Readonly<Record<XauUsdTimeframe, readonly XauUsdCandle[]>>,
): ReplayMarketEvent[] {
  const events: ReplayMarketEvent[] = [
    ...quotes.map((quote) => ({ seq: quote.seq, kind: "quote" as const, time: quote.time })),
    ...prints.map((print) => ({ seq: print.seq, kind: "print" as const, time: print.time })),
  ];
  for (const timeframe of XAUUSD_TIMEFRAMES) {
    candles[timeframe].forEach((candle, index) => {
      events.push({ seq: index, kind: "candle", time: candle.time, timeframe });
    });
  }
  events.sort(compareEvents);
  return events;
}
