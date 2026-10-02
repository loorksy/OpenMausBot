import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { parseTradingEvent, type TradingEvent } from "../../../shared/trading/events.ts";
import { recordIdSchema, seal } from "../../../shared/trading/ids.ts";
import {
  XAUUSD_TIMEFRAMES,
  parseMarketSnapshot,
  type MarketFreshness,
  type MarketSnapshot,
  type XauUsdTimeframe,
} from "../../../shared/trading/snapshot.ts";
import { assertClockLimits } from "../infrastructure/market_data/clock.ts";
import {
  redactMarketText,
  type MarketClock,
  type MarketClockLimits,
  type MarketRequest,
  type XauUsdCandleSeries,
  type XauUsdQuote,
} from "../infrastructure/market_data/model.ts";
import { readXauUsdCandles, readXauUsdQuote } from "../infrastructure/market_data/read.ts";
import { TIMEFRAME_MS, normalizeTimeframe } from "../infrastructure/market_data/timeframe.ts";
import type { ReplayClock } from "./clock.ts";
import { REPLAY_CLOCK_VERSION, createReplayClock } from "./clock.ts";
import type { ReplayDataset } from "./dataset.ts";
import { REPLAY_ORDERING_RULE } from "./dataset.ts";
import { contentHash } from "./hash.ts";
import { createReplayMarketProvider, type ReplayMarketProvider } from "./provider.ts";

export const REPLAY_CONFIG_VERSION = "xauusd-replay-1";
export const REPLAY_FORMING_POLICY = "prints-only" as const;

export type ReplayDataQuality = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";

const FRESHNESS_RANK: Record<MarketFreshness, number> = {
  fresh: 0,
  stale: 1,
  unavailable: 2,
  invalid: 3,
  future_dated: 4,
};

export interface FormingCandle {
  readonly timeframe: XauUsdTimeframe;
  readonly status: "available" | "unavailable";
  readonly reason?: "insufficient-data";
  readonly openTime: string;
  readonly closeTime: string;
  readonly open?: number;
  readonly high?: number;
  readonly low?: number;
  readonly close?: number;
  readonly volume?: number;
  readonly printCount?: number;
}

/** One knowable XAUUSD state at one replay time. Closed bars, the forming
 * bar, and the quote stay separate. The snapshot holds only closed bars. */
export interface MarketObservation {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly contentHash: string;
  readonly snapshotHash: string;
  readonly replaySessionId: string;
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly datasetFingerprint: string;
  readonly configVersion: typeof REPLAY_CONFIG_VERSION;
  readonly clockVersion: typeof REPLAY_CLOCK_VERSION;
  readonly formingPolicy: typeof REPLAY_FORMING_POLICY;
  readonly instrument: "XAUUSD";
  readonly environment: "SIMULATOR";
  readonly provenance: "REPLAY";
  readonly observationAt: string;
  readonly quality: ReplayDataQuality;
  readonly qualityReasons: readonly string[];
  readonly quote: XauUsdQuote | null;
  readonly closed: readonly XauUsdCandleSeries[];
  readonly forming: readonly FormingCandle[];
  readonly snapshot: MarketSnapshot | null;
  readonly snapshotId: string | null;
}

export interface ReplaySession {
  readonly replaySessionId: string;
  readonly instrument: "XAUUSD";
  readonly environment: "SIMULATOR";
  readonly provenance: "REPLAY";
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly datasetFingerprint: string;
  readonly configVersion: typeof REPLAY_CONFIG_VERSION;
  readonly clockVersion: typeof REPLAY_CLOCK_VERSION;
  readonly formingPolicy: typeof REPLAY_FORMING_POLICY;
  readonly orderingRule: typeof REPLAY_ORDERING_RULE;
  readonly startAt: string;
  readonly endAt: string;
  readonly timeframes: readonly XauUsdTimeframe[];
  readonly limits: MarketClockLimits;
  readonly agentRunId: string;
  readonly provider: ReplayMarketProvider;
  readonly events: readonly TradingEvent[];
  readonly completed: boolean;
  currentAt(): string;
  now(): string;
  advanceTo(timestamp: string): { readonly advanced: boolean; readonly at: string };
  advanceBy(ms: number): { readonly advanced: boolean; readonly at: string };
  marketClock(): MarketClock;
  observe(options?: ObserveOptions): Promise<MarketObservation>;
  complete(): void;
}

export interface ObserveOptions {
  readonly versionManifestId?: string;
  readonly runtimeEventId?: string;
}

export interface ReplaySessionOptions {
  readonly dataset: ReplayDataset;
  readonly startAt: unknown;
  readonly endAt: unknown;
  readonly timeframes: readonly XauUsdTimeframe[];
  readonly limits: MarketClockLimits;
  readonly agentRunId: string;
  readonly versionManifestId?: string;
  readonly runtime?: {
    readonly threadId: string;
    readonly turnId: string;
  };
}

function canonicalTimeframes(values: readonly XauUsdTimeframe[]): XauUsdTimeframe[] {
  if (values.length === 0) {
    throw new TradingDomainError("replay_rejected", "replay observation needs at least one timeframe");
  }
  const seen = new Set<XauUsdTimeframe>();
  for (const value of values) {
    const normalized = normalizeTimeframe(value);
    if (normalized.normalization) {
      throw new TradingDomainError("replay_rejected", "replay timeframes must be canonical");
    }
    seen.add(normalized.timeframe);
  }
  return XAUUSD_TIMEFRAMES.filter((timeframe) => seen.has(timeframe));
}

function requireRecordId(value: string, label: string): string {
  if (!recordIdSchema.safeParse(value).success) {
    throw new TradingDomainError("agent_run_required", `${label} is not a valid id`);
  }
  return value;
}

/** Opens expected to have closed by `nowMs`. A bar is expected once its close
 * is at or before now and its whole interval sits inside coverage. */
export function expectedClosedOpens(coverageStartMs: number, nowMs: number, step: number): number[] {
  const first = coverageStartMs % step === 0
    ? coverageStartMs
    : coverageStartMs + (step - (coverageStartMs % step));
  const formingOpen = nowMs - (nowMs % step);
  const last = formingOpen - step;
  const opens: number[] = [];
  if (last < first) return opens;
  for (let open = first; open <= last; open += step) opens.push(open);
  return opens;
}

function formingCandle(dataset: ReplayDataset, timeframe: XauUsdTimeframe, nowMs: number): FormingCandle {
  const step = TIMEFRAME_MS[timeframe];
  const openMs = nowMs - (nowMs % step);
  const closeMs = openMs + step;
  const openTime = new Date(openMs).toISOString();
  const closeTime = new Date(closeMs).toISOString();
  const base = { timeframe, openTime, closeTime };
  if (openMs < Date.parse(dataset.coverageStart)) {
    return { ...base, status: "unavailable", reason: "insufficient-data" };
  }
  const prints = dataset.prints.filter((print) => {
    const time = Date.parse(print.time);
    return time >= openMs && time <= nowMs && time < closeMs;
  });
  if (prints.length === 0) return { ...base, status: "unavailable", reason: "insufficient-data" };
  const volumeKnown = prints.every((print) => print.volume !== undefined);
  return {
    ...base,
    status: "available",
    open: prints[0].price,
    close: prints[prints.length - 1].price,
    high: Math.max(...prints.map((print) => print.price)),
    low: Math.min(...prints.map((print) => print.price)),
    printCount: prints.length,
    ...(volumeKnown ? { volume: prints.reduce((sum, print) => sum + (print.volume ?? 0), 0) } : {}),
  };
}

function worstFreshness(values: readonly MarketFreshness[]): MarketFreshness {
  return values.reduce((worst, value) => (
    FRESHNESS_RANK[value] > FRESHNESS_RANK[worst] ? value : worst
  ));
}

export function createReplaySession(options: ReplaySessionOptions): ReplaySession {
  const dataset = options.dataset;
  if (dataset.instrument !== "XAUUSD") {
    throw new TradingDomainError("instrument_rejected", "replay data must be XAUUSD");
  }
  const agentRunId = requireRecordId(options.agentRunId, "agentRunId");
  const timeframes = canonicalTimeframes(options.timeframes);
  assertClockLimits(options.limits);
  const limits = {
    staleAfterMs: options.limits.staleAfterMs,
    futureSkewMs: options.limits.futureSkewMs,
    abnormalLatencyMs: options.limits.abnormalLatencyMs,
  };
  const clock: ReplayClock = createReplayClock({ startAt: options.startAt, endAt: options.endAt });
  if (options.runtime) {
    requireRecordId(options.runtime.threadId, "runtimeThreadId");
    requireRecordId(options.runtime.turnId, "runtimeTurnId");
  }
  const versionManifestId = options.versionManifestId
    ? requireRecordId(options.versionManifestId, "versionManifestId")
    : undefined;
  const replaySessionId = `replay-${contentHash({
    configVersion: REPLAY_CONFIG_VERSION,
    clockVersion: REPLAY_CLOCK_VERSION,
    formingPolicy: REPLAY_FORMING_POLICY,
    orderingRule: REPLAY_ORDERING_RULE,
    datasetFingerprint: dataset.fingerprint,
    instrument: "XAUUSD",
    startAt: clock.startAt,
    endAt: clock.endAt,
    timeframes,
    limits,
  })}`;
  const manifestId = versionManifestId ?? `mf-${dataset.fingerprint}`;
  const provider = createReplayMarketProvider(dataset, clock);
  const events: TradingEvent[] = [];
  const cache = new Map<string, MarketObservation>();
  let sequence = 0;
  let completed = false;
  const nextEventId = (): string => {
    sequence += 1;
    return `rev${sequence.toString(36)}.${replaySessionId.slice("replay-".length, "replay-".length + 48)}`;
  };
  const marketClock = (): MarketClock => ({
    receivedAt: clock.now(),
    processedAt: clock.now(),
    limits,
  });
  const emit = (
    type: "market.replay.started" | "market.replay.advanced" | "market.replay.completed" | "market.replay.failed" | "market.snapshot.created",
    payload: Record<string, unknown>,
    runtimeEventId?: string,
  ): TradingEvent => parseTradingEvent({
    schemaVersion: 1,
    eventId: nextEventId(),
    type,
    source: "trading-domain",
    at: clock.now(),
    agentRunId,
    correlationId: options.runtime?.turnId ?? replaySessionId,
    environment: "SIMULATOR",
    instrument: "XAUUSD",
    actor: "xauusd-replay",
    ...(runtimeEventId ? { runtimeEventId } : {}),
    ...(options.runtime ? {
      runtimeThreadId: options.runtime.threadId,
      runtimeTurnId: options.runtime.turnId,
    } : {}),
    payload: {
      replaySessionId,
      timestamp: clock.now(),
      instrument: "XAUUSD",
      datasetId: dataset.datasetId,
      datasetVersion: dataset.datasetVersion,
      ...payload,
    },
  });
  const assertOpen = (): void => {
    if (completed) throw new TradingDomainError("replay_rejected", "replay session is completed");
  };
  const requestFor = (runtimeEventId: string | undefined, manifest: string): MarketRequest => ({
    agentRunId,
    correlationId: options.runtime?.turnId ?? replaySessionId,
    versionManifestId: manifest,
    clock: marketClock(),
    ...(options.runtime ? {
      runtime: {
        ...(runtimeEventId ? { eventId: runtimeEventId } : {}),
        threadId: options.runtime.threadId,
        turnId: options.runtime.turnId,
      },
    } : {}),
    nextEventId,
  });
  events.push(emit("market.replay.started", { startAt: clock.startAt, endAt: clock.endAt }));
  return {
    replaySessionId,
    instrument: "XAUUSD",
    environment: "SIMULATOR",
    provenance: "REPLAY",
    datasetId: dataset.datasetId,
    datasetVersion: dataset.datasetVersion,
    datasetFingerprint: dataset.fingerprint,
    configVersion: REPLAY_CONFIG_VERSION,
    clockVersion: REPLAY_CLOCK_VERSION,
    formingPolicy: REPLAY_FORMING_POLICY,
    orderingRule: REPLAY_ORDERING_RULE,
    startAt: clock.startAt,
    endAt: clock.endAt,
    timeframes,
    limits,
    agentRunId,
    provider,
    events,
    get completed() {
      return completed;
    },
    currentAt: () => clock.currentAt(),
    now: () => clock.now(),
    advanceTo(timestamp: string) {
      assertOpen();
      const before = clock.now();
      const moved = clock.advanceTo(timestamp);
      if (moved.advanced) {
        events.push(emit("market.replay.advanced", { previousTimestamp: before, advancedTo: moved.at }));
      }
      return moved;
    },
    advanceBy(ms: number) {
      assertOpen();
      const before = clock.now();
      const moved = clock.advanceBy(ms);
      if (moved.advanced) {
        events.push(emit("market.replay.advanced", { previousTimestamp: before, advancedTo: moved.at }));
      }
      return moved;
    },
    marketClock,
    async observe(observeOptions: ObserveOptions = {}) {
      assertOpen();
      const manifest = observeOptions.versionManifestId
        ? requireRecordId(observeOptions.versionManifestId, "versionManifestId")
        : manifestId;
      const at = clock.now();
      const cacheKey = `${at}|${manifest}|${agentRunId}`;
      const cached = cache.get(cacheKey);
      if (cached) return cached;
      const pending: TradingEvent[] = [];
      try {
        const observation = await buildObservation({
          dataset,
          clock,
          provider,
          timeframes,
          replaySessionId,
          agentRunId,
          manifestId: manifest,
          request: requestFor(observeOptions.runtimeEventId, manifest),
          pending,
          emit: (payload) => pending.push(emit("market.snapshot.created", payload, observeOptions.runtimeEventId)),
        });
        events.push(...pending);
        cache.set(cacheKey, observation);
        return observation;
      } catch (error) {
        const message = error instanceof Error ? error.message : "replay observation failed";
        events.push(emit("market.replay.failed", { message: redactMarketText(message) }, observeOptions.runtimeEventId));
        if (error instanceof TradingDomainError) throw error;
        throw new TradingDomainError("replay_rejected", message);
      }
    },
    complete() {
      assertOpen();
      completed = true;
      events.push(emit("market.replay.completed", { endAt: clock.now() }));
    },
  };
}

async function buildObservation(input: {
  dataset: ReplayDataset;
  clock: ReplayClock;
  provider: ReplayMarketProvider;
  timeframes: readonly XauUsdTimeframe[];
  replaySessionId: string;
  agentRunId: string;
  manifestId: string;
  request: MarketRequest;
  pending: TradingEvent[];
  emit: (payload: Record<string, unknown>) => void;
}): Promise<MarketObservation> {
  const now = input.clock.now();
  const nowMs = Date.parse(now);
  const inCoverage = nowMs >= Date.parse(input.dataset.coverageStart) && nowMs <= Date.parse(input.dataset.coverageEnd);
  const forming = input.timeframes.map((timeframe) => (
    inCoverage
      ? formingCandle(input.dataset, timeframe, nowMs)
      : {
        timeframe,
        status: "unavailable" as const,
        reason: "insufficient-data" as const,
        openTime: new Date(nowMs - (nowMs % TIMEFRAME_MS[timeframe])).toISOString(),
        closeTime: new Date(nowMs - (nowMs % TIMEFRAME_MS[timeframe]) + TIMEFRAME_MS[timeframe]).toISOString(),
      }
  ));
  let quote: XauUsdQuote | null = null;
  const closed: XauUsdCandleSeries[] = [];
  if (inCoverage) {
    if (input.dataset.quotes.length > 0) {
      const read = await readXauUsdQuote(input.provider, input.request);
      input.pending.push(...read.events);
      if (!read.ok) {
        if (read.failure !== "unavailable") {
          throw new TradingDomainError("replay_rejected", read.message);
        }
      } else if (Date.parse(read.data.providerTimestamp) > nowMs) {
        throw new TradingDomainError("replay_rejected", "replay quote is after the replay time");
      } else {
        quote = read.data;
      }
    }
    for (const timeframe of input.timeframes) {
      const read = await readXauUsdCandles(
        input.provider,
        timeframe,
        { from: input.dataset.coverageStart, to: now },
        input.request,
      );
      input.pending.push(...read.events);
      if (!read.ok) throw new TradingDomainError("replay_rejected", read.message);
      for (const candle of read.data.candles) {
        if (Date.parse(candle.time) + TIMEFRAME_MS[timeframe] > nowMs) {
          throw new TradingDomainError("replay_rejected", "replay provider returned a candle that is not closed");
        }
      }
      if (read.data.candles.length > 0) closed.push(read.data);
      const expected = expectedClosedOpens(
        Date.parse(input.dataset.coverageStart),
        nowMs,
        TIMEFRAME_MS[timeframe],
      );
      const actual = new Set(read.data.candles.map((candle) => Date.parse(candle.time)));
      for (const open of actual) {
        if (!expected.includes(open)) {
          throw new TradingDomainError("replay_rejected", "replay provider returned a candle outside the knowable window");
        }
      }
    }
  }
  const reasons: string[] = [];
  let quality: ReplayDataQuality;
  if (!inCoverage) {
    quality = "UNAVAILABLE";
    reasons.push("replay time is outside dataset coverage");
  } else {
    const holes: string[] = [];
    for (const timeframe of input.timeframes) {
      const expected = expectedClosedOpens(
        Date.parse(input.dataset.coverageStart),
        nowMs,
        TIMEFRAME_MS[timeframe],
      );
      const actual = new Set(
        (closed.find((series) => series.timeframe === timeframe)?.candles ?? []).map((candle) => Date.parse(candle.time)),
      );
      if (expected.some((open) => !actual.has(open))) holes.push(timeframe);
    }
    const quoteMissing = input.dataset.quotes.length > 0 && quote === null;
    if (quote === null && closed.every((series) => series.candles.length === 0)) {
      quality = "UNAVAILABLE";
      reasons.push("no quote or closed candle is knowable");
      for (const timeframe of holes) reasons.push(`gap in ${timeframe}`);
      if (quoteMissing) reasons.push("no quote is knowable at the replay time");
    } else if (holes.length > 0 || quoteMissing) {
      quality = "PARTIAL";
      for (const timeframe of holes) reasons.push(`gap in ${timeframe}`);
      if (quoteMissing) reasons.push("no quote is knowable at the replay time");
    } else {
      quality = "COMPLETE";
    }
  }
  const snapshotIdentity = {
    datasetFingerprint: input.dataset.fingerprint,
    observationAt: now,
    provenance: "REPLAY" as const,
    environment: "SIMULATOR" as const,
    quote: quote === null ? null : {
      bid: quote.bid,
      ask: quote.ask,
      spread: quote.spread,
      providerTimestamp: quote.providerTimestamp,
      freshness: quote.freshness,
    },
    closed: closed.map((series) => ({
      timeframe: series.timeframe,
      freshness: series.freshness,
      candles: series.candles.map((candle) => ({
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        ...(candle.volume !== undefined ? { volume: candle.volume } : {}),
      })),
    })),
  };
  const observationIdentity = {
    ...snapshotIdentity,
    configVersion: REPLAY_CONFIG_VERSION,
    clockVersion: REPLAY_CLOCK_VERSION,
    formingPolicy: REPLAY_FORMING_POLICY,
    replaySessionId: input.replaySessionId,
    quality,
    qualityReasons: reasons,
    forming: forming.map((bar) => ({
      timeframe: bar.timeframe,
      status: bar.status,
      ...(bar.reason ? { reason: bar.reason } : {}),
      openTime: bar.openTime,
      closeTime: bar.closeTime,
      ...(bar.open !== undefined ? {
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        printCount: bar.printCount,
        ...(bar.volume !== undefined ? { volume: bar.volume } : {}),
      } : {}),
    })),
  };
  const snapshotHash = contentHash(snapshotIdentity);
  const hashed = contentHash(observationIdentity);
  const snapshot = sealSnapshot({
    snapshotHash,
    quote,
    closed,
    now,
    agentRunId: input.agentRunId,
    manifestId: input.manifestId,
    providerId: input.provider.providerId,
  });
  if (snapshot) {
    input.emit({
      snapshotId: snapshot.id,
      observationId: `obs-${hashed}`,
      provenance: snapshot.provenance,
      freshness: snapshot.freshness,
      providerTimestamp: snapshot.providerTimestamp,
      candleCount: snapshot.candles.length,
      quality,
    });
  }
  return seal({
    schemaVersion: 1 as const,
    id: `obs-${hashed}`,
    contentHash: hashed,
    snapshotHash,
    replaySessionId: input.replaySessionId,
    datasetId: input.dataset.datasetId,
    datasetVersion: input.dataset.datasetVersion,
    datasetFingerprint: input.dataset.fingerprint,
    configVersion: REPLAY_CONFIG_VERSION,
    clockVersion: REPLAY_CLOCK_VERSION,
    formingPolicy: REPLAY_FORMING_POLICY,
    instrument: "XAUUSD" as const,
    environment: "SIMULATOR" as const,
    provenance: "REPLAY" as const,
    observationAt: now,
    quality,
    qualityReasons: reasons,
    quote,
    closed,
    forming,
    snapshot,
    snapshotId: snapshot?.id ?? null,
  });
}

function sealSnapshot(input: {
  snapshotHash: string;
  quote: XauUsdQuote | null;
  closed: readonly XauUsdCandleSeries[];
  now: string;
  agentRunId: string;
  manifestId: string;
  providerId: string;
}): MarketSnapshot | null {
  if (!input.quote && input.closed.length === 0) return null;
  const freshness = worstFreshness([
    ...(input.quote ? [input.quote.freshness] : []),
    ...input.closed.map((series) => series.freshness),
  ]);
  const stamps = [
    ...(input.quote ? [Date.parse(input.quote.providerTimestamp)] : []),
    ...input.closed.map((series) => Date.parse(series.providerTimestamp)),
  ];
  const providerTimestamp = new Date(Math.max(...stamps)).toISOString();
  const normalizations: string[] = [];
  for (const note of [
    ...(input.quote?.normalizations ?? []),
    ...input.closed.flatMap((series) => series.normalizations),
  ]) {
    if (!normalizations.includes(note)) normalizations.push(note);
  }
  if (normalizations.length > 40) {
    throw new TradingDomainError("replay_rejected", "replay observation has too many normalizations");
  }
  return parseMarketSnapshot({
    schemaVersion: 1,
    id: `snap-${input.snapshotHash}`,
    agentRunId: input.agentRunId,
    environment: "SIMULATOR",
    instrument: "XAUUSD",
    createdAt: input.now,
    capturedAt: input.now,
    provider: input.providerId,
    providerTimestamp,
    receivedAt: input.now,
    processedAt: input.now,
    provenance: "REPLAY",
    latencyMs: 0,
    freshness,
    versionManifestId: input.manifestId,
    normalizations,
    ...(input.quote ? { bid: input.quote.bid, ask: input.quote.ask, spread: input.quote.spread } : {}),
    candles: input.closed.flatMap((series) => series.candles.map((candle) => ({ ...candle }))),
  });
}

/** Attach a replay session to an existing grant shape.
 * PAPER and LIVE are rejected. The result cannot keep a live provider. */
export function bindReplayGrant<T extends {
  readonly environment?: "SIMULATOR" | "PAPER" | "LIVE";
  readonly provider?: unknown;
  readonly clock?: MarketClock;
}>(session: ReplaySession, grant: T): Omit<T, "environment" | "provider" | "clock"> & {
  readonly environment: "SIMULATOR";
  readonly provider: ReplayMarketProvider;
  readonly clock: MarketClock;
  readonly replay: ReplaySession;
} {
  if (session.completed) throw new TradingDomainError("replay_rejected", "replay session is completed");
  if (grant.environment !== undefined && grant.environment !== "SIMULATOR") {
    throw new TradingDomainError("environment_isolation", "replay cannot bind to PAPER or LIVE");
  }
  return {
    ...grant,
    environment: "SIMULATOR",
    provider: session.provider,
    clock: session.marketClock(),
    replay: session,
  };
}
