import { describe, expect, it } from "vitest";

import { TradingDomainError } from "../../../../shared/trading/errors.ts";
import { assessClock } from "./clock.ts";
import {
  buildXauUsdMarketContext,
  createDeterministicXauUsdProvider,
  createXauUsdMarketSnapshot,
  readXauUsdCandles,
  readXauUsdQuote,
  type MarketRequest,
  type RawProviderResult,
} from "./index.ts";

const RECEIVED = "2026-10-01T12:00:00.000Z";
const PROCESSED = "2026-10-01T12:00:00.100Z";
const FRESH_STAMP = "2026-10-01T11:59:30.000Z";

function request(overrides: Partial<MarketRequest> = {}): MarketRequest {
  let n = 0;
  return {
    agentRunId: "run-1",
    correlationId: "corr-1",
    versionManifestId: "ver-1",
    clock: {
      receivedAt: RECEIVED,
      processedAt: PROCESSED,
      limits: { staleAfterMs: 60_000, futureSkewMs: 2_000, abnormalLatencyMs: 5_000 },
    },
    nextEventId: () => `evt-${++n}`,
    ...overrides,
  };
}

function quoteBody(overrides: Record<string, unknown> = {}): RawProviderResult {
  return {
    ok: true,
    providerTimestamp: FRESH_STAMP,
    provenance: "LIVE",
    instrument: "XAUUSD",
    quote: { bid: 2300, ask: 2301 },
    ...overrides,
  } as RawProviderResult;
}

function bar(time: string, close = 2305, timeframe = "M15") {
  return { timeframe, time, open: 2300, high: 2310, low: 2290, close };
}

describe("XAUUSD market data", () => {
  it("accepts XAUUSD and rejects any other instrument", async () => {
    const live = createDeterministicXauUsdProvider({
      providerId: "fixture-live",
      environment: "LIVE",
      successProvenance: "LIVE",
      quote: quoteBody(),
    });
    const accepted = await readXauUsdQuote(live, request());
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.data.instrument).toBe("XAUUSD");
    expect(accepted.events.map((event) => event.type)).toEqual(["market.quote.updated"]);

    const foreign = createDeterministicXauUsdProvider({
      providerId: "fixture-live",
      environment: "LIVE",
      successProvenance: "LIVE",
      quote: quoteBody({ instrument: "EURUSD" }),
    });
    const rejected = await readXauUsdQuote(foreign, request());
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.provenance).toBe("UNAVAILABLE");
    expect(rejected.events[0]?.type).toBe("market.invalid");
  });

  it("normalizes known timeframe aliases and rejects the rest", async () => {
    const provider = createDeterministicXauUsdProvider({
      providerId: "fixture-live",
      environment: "LIVE",
      successProvenance: "LIVE",
      candles: {
        M15: {
          ok: true,
          providerTimestamp: FRESH_STAMP,
          provenance: "LIVE",
          instrument: "XAUUSD",
          candles: [bar("2026-10-01T11:45:00.000Z", 2305, "M15")],
        },
        M5: {
          ok: true,
          providerTimestamp: FRESH_STAMP,
          provenance: "LIVE",
          instrument: "XAUUSD",
          candles: [bar("2026-10-01T11:55:00.000Z", 2302, "M5")],
        },
      },
    });
    const alias = await readXauUsdCandles(provider, "15m", {
      from: "2026-10-01T11:00:00.000Z",
      to: "2026-10-01T12:00:00.000Z",
    }, request());
    expect(alias.ok).toBe(true);
    if (!alias.ok) return;
    expect(alias.data.timeframe).toBe("M15");
    expect(alias.data.normalizations.some((note) => note.includes("15m"))).toBe(true);
    expect(provider.calls.at(-1)?.timeframe).toBe("M15");

    const wrong = await readXauUsdCandles(provider, "W1", {
      from: "2026-10-01T11:00:00.000Z",
      to: "2026-10-01T12:00:00.000Z",
    }, request());
    expect(wrong.ok).toBe(false);
    expect(provider.calls.filter((call) => call.timeframe === "M5")).toHaveLength(0);
    const before = provider.calls.length;
    await readXauUsdCandles(provider, "M2", {
      from: "2026-10-01T11:00:00.000Z",
      to: "2026-10-01T12:00:00.000Z",
    }, request());
    expect(provider.calls).toHaveLength(before);
  });

  it("rejects malformed bars, bad timestamps, duplicates, and conflicts", async () => {
    const cases: RawProviderResult[] = [
      {
        ok: true,
        providerTimestamp: FRESH_STAMP,
        provenance: "LIVE",
        instrument: "XAUUSD",
        candles: [{ timeframe: "M15", time: "2026-10-01T11:45:00.000Z", open: 2300, high: 2280, low: 2290, close: 2305 }],
      },
      {
        ok: true,
        providerTimestamp: "yesterday",
        provenance: "LIVE",
        instrument: "XAUUSD",
        candles: [bar("2026-10-01T11:45:00.000Z")],
      },
      {
        ok: true,
        providerTimestamp: FRESH_STAMP,
        provenance: "LIVE",
        instrument: "XAUUSD",
        candles: [bar("not-a-time")],
      },
      {
        ok: true,
        providerTimestamp: FRESH_STAMP,
        provenance: "LIVE",
        instrument: "XAUUSD",
        candles: [bar("2026-10-01T11:45:00.000Z"), bar("2026-10-01T11:45:00.000Z")],
      },
      {
        ok: true,
        providerTimestamp: FRESH_STAMP,
        provenance: "LIVE",
        instrument: "XAUUSD",
        candles: [bar("2026-10-01T11:45:00.000Z", 2305), bar("2026-10-01T11:45:00.000Z", 2315)],
      },
      {
        ok: true,
        providerTimestamp: FRESH_STAMP,
        provenance: "LIVE",
        instrument: "XAUUSD",
        candles: [{ ...bar("2026-10-01T11:45:00.000Z"), volume: -1 }],
      },
    ];
    for (const candles of cases) {
      const provider = createDeterministicXauUsdProvider({
        providerId: "fixture-live",
        environment: "LIVE",
        successProvenance: "LIVE",
        candles: { M15: candles },
      });
      const result = await readXauUsdCandles(provider, "M15", {
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-01T13:00:00.000Z",
      }, request());
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.events[0]?.type).toBe("market.invalid");
      expect(result.provenance).not.toBe("SIMULATOR");
    }
  });

  it("sorts unique bars without changing their prices", async () => {
    const provider = createDeterministicXauUsdProvider({
      providerId: "fixture-live",
      environment: "LIVE",
      successProvenance: "LIVE",
      candles: {
        M5: {
          ok: true,
          providerTimestamp: FRESH_STAMP,
          provenance: "LIVE",
          instrument: "XAUUSD",
          candles: [
            bar("2026-10-01T11:55:00.000Z", 2302, "M5"),
            bar("2026-10-01T11:50:00.000Z", 2298, "M5"),
          ],
        },
      },
    });
    const result = await readXauUsdCandles(provider, "M5", {
      from: "2026-10-01T11:00:00.000Z",
      to: "2026-10-01T12:00:00.000Z",
    }, request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.candles.map((candle) => candle.time)).toEqual([
      "2026-10-01T11:50:00.000Z",
      "2026-10-01T11:55:00.000Z",
    ]);
    expect(result.data.candles.map((candle) => candle.close)).toEqual([2298, 2302]);
    expect(result.data.normalizations).toContain("candles sorted by open time");
  });

  it("keeps a live failure unavailable and never labels it SIMULATOR", async () => {
    const kinds = ["timeout", "unavailable", "authentication_failure", "rate_limit", "network_failure", "empty_response", "stale_response"] as const;
    for (const kind of kinds) {
      const provider = createDeterministicXauUsdProvider({
        providerId: "fixture-live",
        environment: "LIVE",
        successProvenance: "LIVE",
        failure: { kind, message: "token=super-secret bearer abc.def" },
        quote: quoteBody({ provenance: "SIMULATOR" }),
      });
      const result = await readXauUsdQuote(provider, request());
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.provenance).toBe(kind === "stale_response" ? "STALE" : "UNAVAILABLE");
      expect(result.provenance).not.toBe("SIMULATOR");
      expect(JSON.stringify(result.events)).not.toContain("super-secret");
      expect(JSON.stringify(result.events)).not.toContain("abc.def");
      expect(result.events.some((event) => event.type === "market.quote.updated")).toBe(false);
      const eventType = result.events[0]?.type;
      if (kind === "stale_response") expect(eventType).toBe("market.stale");
      else if (kind === "unavailable") expect(eventType).toBe("market.unavailable");
      else if (kind === "empty_response") expect(eventType).toBe("market.invalid");
      else expect(eventType).toBe("market.provider_error");
    }

    const relabel = createDeterministicXauUsdProvider({
      providerId: "fixture-live",
      environment: "LIVE",
      successProvenance: "SIMULATOR",
      quote: quoteBody({ provenance: "SIMULATOR" }),
    });
    const hidden = await readXauUsdQuote(relabel, request());
    expect(hidden.ok).toBe(false);
    if (!hidden.ok) expect(hidden.provenance).toBe("UNAVAILABLE");
  });

  it("preserves provider and receive timestamps and labels stale live data", async () => {
    const provider = createDeterministicXauUsdProvider({
      providerId: "fixture-live",
      environment: "LIVE",
      successProvenance: "LIVE",
      quote: quoteBody({ providerTimestamp: "2026-10-01T10:00:00.000Z" }),
    });
    const stale = await readXauUsdQuote(provider, request());
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.data.provenance).toBe("STALE");
    expect(stale.data.freshness).toBe("stale");
    expect(stale.data.providerTimestamp).toBe("2026-10-01T10:00:00.000Z");
    expect(stale.data.receivedAt).toBe(RECEIVED);
    expect(stale.data.processedAt).toBe(PROCESSED);
    expect(stale.events[0]?.type).toBe("market.stale");

    const freshProvider = createDeterministicXauUsdProvider({
      providerId: "fixture-live",
      environment: "LIVE",
      successProvenance: "LIVE",
      quote: quoteBody(),
    });
    const fresh = await readXauUsdQuote(freshProvider, request());
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.data.provenance).toBe("LIVE");
    expect(fresh.data.freshness).toBe("fresh");
    expect(fresh.data.providerTimestamp).toBe(FRESH_STAMP);
  });

  it("detects future timestamps, clock skew, and abnormal latency", () => {
    const limits = { staleAfterMs: 60_000, futureSkewMs: 2_000, abnormalLatencyMs: 5_000 };
    expect(assessClock(FRESH_STAMP, {
      receivedAt: RECEIVED,
      processedAt: PROCESSED,
      limits,
    })).toMatchObject({ freshness: "fresh", futureDated: false, abnormalLatency: false });
    expect(assessClock("2026-10-01T12:00:10.000Z", {
      receivedAt: RECEIVED,
      processedAt: PROCESSED,
      limits,
    }).futureDated).toBe(true);
    expect(assessClock("2026-10-01T12:00:01.000Z", {
      receivedAt: RECEIVED,
      processedAt: PROCESSED,
      limits,
    })).toMatchObject({ futureDated: false, skewMs: -1_000 });
    expect(assessClock(FRESH_STAMP, {
      receivedAt: RECEIVED,
      processedAt: "2026-10-01T12:00:06.000Z",
      limits,
    }).abnormalLatency).toBe(true);
  });

  it("rejects a future provider timestamp instead of rewriting it", async () => {
    const provider = createDeterministicXauUsdProvider({
      providerId: "fixture-live",
      environment: "LIVE",
      successProvenance: "LIVE",
      quote: quoteBody({ providerTimestamp: "2026-10-01T12:00:10.000Z" }),
    });
    const result = await readXauUsdQuote(provider, request());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.freshness).toBe("future_dated");
    expect(result.events[0]?.type).toBe("market.invalid");
    expect(result.events[0]?.payload).not.toHaveProperty("bid");
  });

  it("seals a snapshot that cannot see a bar which has not closed", async () => {
    const closed = createDeterministicXauUsdProvider({
      providerId: "fixture-sim",
      environment: "SIMULATOR",
      successProvenance: "SIMULATOR",
      quote: quoteBody({ provenance: "SIMULATOR", providerTimestamp: FRESH_STAMP }),
      candles: {
        M15: {
          ok: true,
          providerTimestamp: FRESH_STAMP,
          provenance: "SIMULATOR",
          instrument: "XAUUSD",
          candles: [bar("2026-10-01T11:45:00.000Z")],
        },
      },
    });
    const quote = await readXauUsdQuote(closed, request());
    const candles = await readXauUsdCandles(closed, "M15", {
      from: "2026-10-01T11:00:00.000Z",
      to: "2026-10-01T12:00:00.000Z",
    }, request());
    expect(quote.ok && candles.ok).toBe(true);
    if (!quote.ok || !candles.ok) return;
    const sealed = createXauUsdMarketSnapshot({
      id: "snap-1",
      request: request(),
      quote: quote.data,
      series: candles.data,
    });
    expect(Object.isFrozen(sealed.snapshot)).toBe(true);
    expect(sealed.events.map((event) => event.type)).toEqual(["market.snapshot.created"]);
    expect(sealed.snapshot.providerTimestamp).toBe(FRESH_STAMP);
    expect(sealed.snapshot.candles).toHaveLength(1);
    expect(() => {
      (sealed.snapshot as { bid?: number }).bid = 1;
    }).toThrow(TypeError);
    const originalClose = candles.data.candles[0]?.close;
    (candles.data.candles[0] as { close: number }).close = 1;
    expect(sealed.snapshot.candles[0]?.close).toBe(originalClose);

    const context = buildXauUsdMarketContext(sealed.snapshot, { id: "ctx-1" });
    expect(context.snapshotId).toBe("snap-1");
    expect(context.instrument).toBe("XAUUSD");
    expect(context.asOf).toBe(RECEIVED);
    expect(context.evidenceIds).toEqual([]);
    expect(context).not.toHaveProperty("direction");

    const forming = createDeterministicXauUsdProvider({
      providerId: "fixture-sim",
      environment: "SIMULATOR",
      successProvenance: "SIMULATOR",
      candles: {
        M1: {
          ok: true,
          providerTimestamp: FRESH_STAMP,
          provenance: "SIMULATOR",
          instrument: "XAUUSD",
          candles: [bar(RECEIVED, 2305, "M1")],
        },
      },
    });
    const future = await readXauUsdCandles(forming, "M1", {
      from: "2026-10-01T11:00:00.000Z",
      to: "2026-10-01T13:00:00.000Z",
    }, request());
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.events[0]?.type).toBe("market.invalid");
    expect(() => createXauUsdMarketSnapshot({ id: "snap-empty", request: request() })).toThrow(TradingDomainError);
  });
});
