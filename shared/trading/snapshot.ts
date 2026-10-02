import { z } from "zod";

import { assertProvenanceForEnvironment, provenanceStatusSchema, tradingEnvironmentSchema, type ProvenanceStatus, type TradingEnvironment } from "./environment.ts";
import { TradingDomainError } from "./errors.ts";
import { assertNoSecretFields, formatZodError, recordIdSchema, seal, TRADING_SCHEMA_VERSION, utcTimestampSchema, zodCode } from "./ids.ts";
import { xauUsdInstrumentSchema, type XauUsdInstrument } from "./instrument.ts";

export const XAUUSD_TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"] as const;

export type XauUsdTimeframe = (typeof XAUUSD_TIMEFRAMES)[number];

/** Data-quality label. This is not an execution permission. */
export const MARKET_FRESHNESS_STATES = ["fresh", "stale", "unavailable", "invalid", "future_dated"] as const;

export type MarketFreshness = (typeof MARKET_FRESHNESS_STATES)[number];

/** One bar inside an immutable snapshot. Validation checks the bar shape.
 * It does not compute indicators. */
export interface XauUsdCandle {
  readonly timeframe: XauUsdTimeframe;
  readonly time: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume?: number;
}

export interface MarketSnapshot {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly agentRunId: string;
  readonly environment: TradingEnvironment;
  readonly instrument: XauUsdInstrument;
  readonly createdAt: string;
  readonly supersedes?: string;
  readonly capturedAt: string;
  readonly provider: string;
  readonly providerTimestamp: string;
  readonly receivedAt: string;
  readonly provenance: ProvenanceStatus;
  readonly latencyMs?: number;
  readonly processedAt?: string;
  readonly freshness?: MarketFreshness;
  readonly versionManifestId?: string;
  readonly normalizations: readonly string[];
  readonly bid?: number;
  readonly ask?: number;
  readonly spread?: number;
  readonly candles: readonly XauUsdCandle[];
}

const price = z.number().finite().positive();

const candleSchema = z.object({
  timeframe: z.enum(XAUUSD_TIMEFRAMES),
  time: utcTimestampSchema,
  open: price,
  high: price,
  low: price,
  close: price,
  volume: z.number().finite().nonnegative().optional(),
}).strict().superRefine((candle, ctx) => {
  if (candle.high < candle.open || candle.high < candle.close || candle.high < candle.low) {
    ctx.addIssue({ code: "custom", path: ["high"], message: "high must cover the bar" });
  }
  if (candle.low > candle.open || candle.low > candle.close || candle.low > candle.high) {
    ctx.addIssue({ code: "custom", path: ["low"], message: "low must sit under the bar" });
  }
});

const snapshotSchema = z.object({
  schemaVersion: z.literal(TRADING_SCHEMA_VERSION),
  id: recordIdSchema,
  agentRunId: recordIdSchema,
  environment: tradingEnvironmentSchema,
  instrument: xauUsdInstrumentSchema,
  createdAt: utcTimestampSchema,
  supersedes: recordIdSchema.optional(),
  capturedAt: utcTimestampSchema,
  provider: z.string().trim().min(1).max(200),
  providerTimestamp: utcTimestampSchema,
  receivedAt: utcTimestampSchema,
  provenance: provenanceStatusSchema,
  latencyMs: z.number().finite().nonnegative().optional(),
  processedAt: utcTimestampSchema.optional(),
  freshness: z.enum(MARKET_FRESHNESS_STATES).optional(),
  versionManifestId: recordIdSchema.optional(),
  normalizations: z.array(z.string().trim().min(1).max(200)).max(40).default([]),
  bid: price.optional(),
  ask: price.optional(),
  spread: z.number().finite().nonnegative().optional(),
  candles: z.array(candleSchema).max(2_048),
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.bid !== undefined && snapshot.ask !== undefined && snapshot.bid > snapshot.ask) {
    ctx.addIssue({ code: "custom", path: ["bid"], message: "bid cannot exceed ask" });
  }
  const lastByTimeframe = new Map<string, number>();
  snapshot.candles.forEach((candle, index) => {
    const timeMs = Date.parse(candle.time);
    const previous = lastByTimeframe.get(candle.timeframe);
    if (previous !== undefined && timeMs <= previous) {
      ctx.addIssue({
        code: "custom",
        path: ["candles", index, "time"],
        message: "candles in one timeframe must be strictly increasing and unique",
      });
    }
    lastByTimeframe.set(candle.timeframe, timeMs);
  });
});

export function parseMarketSnapshot(value: unknown): MarketSnapshot {
  assertNoSecretFields(value, "market snapshot");
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new TradingDomainError(zodCode(parsed.error, "invalid_snapshot"), formatZodError(parsed.error));
  }
  assertProvenanceForEnvironment(parsed.data.environment, parsed.data.provenance);
  return seal(parsed.data);
}
