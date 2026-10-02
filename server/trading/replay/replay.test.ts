import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { environmentBinding } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { XAUUSD_TIMEFRAMES, type XauUsdTimeframe } from "../../../shared/trading/snapshot.ts";
import { createXauUsdToolSession, type XauUsdToolSession, type XauUsdTurnGrant } from "../agent/index.ts";
import { assertToolSchema } from "../agent/schema.ts";
import { XAUUSD_TOOL_CATALOG } from "../agent/catalog.ts";
import { TIMEFRAME_MS } from "../infrastructure/market_data/timeframe.ts";
import { contentHash } from "./hash.ts";
import { createReplayClock } from "./clock.ts";
import { createReplayDataset, type ReplayDataset, type ReplayDatasetInput } from "./dataset.ts";
import { bindReplayGrant, createReplaySession, type ReplaySession } from "./session.ts";

const LIMITS = { staleAfterMs: 86_400_000, futureSkewMs: 0, abnormalLatencyMs: 86_400_000 };
const FUTURE = 4242.42;

function candle(timeframe: string, time: string, close = 100.5, high = 101): Record<string, unknown> {
  return { timeframe, time, open: 100, high, low: 99, close, volume: 1 };
}

function load(overrides: Partial<ReplayDatasetInput> & Pick<ReplayDatasetInput, "coverageStart" | "coverageEnd">): ReplayDataset {
  return createReplayDataset({
    schemaVersion: 1,
    datasetId: "xau-aug",
    datasetVersion: "v1",
    instrument: "XAUUSD",
    source: "fixture",
    timezone: "UTC",
    quotes: [],
    candles: {},
    prints: [],
    ...overrides,
  });
}

function sessionFor(dataset: ReplayDataset, timeframes: readonly XauUsdTimeframe[], start: string, end: string, agentRunId = "run-replay"): ReplaySession {
  return createReplaySession({
    dataset,
    startAt: start,
    endAt: end,
    timeframes,
    limits: LIMITS,
    agentRunId,
    runtime: { threadId: "thread-replay", turnId: "turn-replay" },
  });
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

async function call(session: XauUsdToolSession, name: string, args: Record<string, unknown> = {}) {
  const result = await session.execute(name, args, new AbortController().signal);
  return { ...result, body: JSON.parse(result.text) as Record<string, unknown> };
}

describe("replay clock", () => {
  it("keeps UTC time and rejects backwards or past-the-end movement", () => {
    const clock = createReplayClock({
      startAt: "2026-08-15T16:30:00+02:00",
      endAt: "2026-08-15T18:00:00+02:00",
    });
    expect(clock.timezone).toBe("UTC");
    expect(clock.version).toBe("xauusd-replay-clock-1");
    expect(clock.now()).toBe("2026-08-15T14:30:00.000Z");
    expect(clock.currentAt()).toBe(clock.now());
    expect(clock.advanceBy(0)).toEqual({ advanced: false, at: "2026-08-15T14:30:00.000Z" });
    expect(clock.advanceTo("2026-08-15T14:30:00.000Z").advanced).toBe(false);
    expect(clock.advanceBy(1_000)).toEqual({ advanced: true, at: "2026-08-15T14:30:01.000Z" });
    expect(clock.now()).toBe("2026-08-15T14:30:01.000Z");
    expect(() => clock.advanceTo("2026-08-15T14:30:00.000Z")).toThrow(/backwards/);
    expect(() => clock.advanceBy(-1)).toThrow(/backwards/);
    expect(() => clock.advanceBy(1.5)).toThrow(/integer/);
    expect(clock.now()).toBe("2026-08-15T14:30:01.000Z");
    expect(() => clock.advanceTo("2026-08-15T16:00:01.000Z")).toThrow(/session end/);
    expect(clock.now()).toBe("2026-08-15T14:30:01.000Z");
    expect(() => createReplayClock({ startAt: "2026-08-15T14:30:00", endAt: "2026-08-15T15:00:00Z" })).toThrow(TradingDomainError);
  });
});

describe("replay dataset", () => {
  it("identifies XAUUSD fixtures and rejects malformed input", () => {
    const aligned = load({
      coverageStart: "2026-08-15T14:00:00.000Z",
      coverageEnd: "2026-08-15T15:00:00.000Z",
      quotes: [{ time: "2026-08-15T14:00:00.000Z", bid: "1900", ask: 1901 }],
      candles: {
        H1: [candle("H1", "2026-08-15T14:00:00.000Z")],
        M15: [candle("M15", "2026-08-15T14:00:00.000Z"), candle("M15", "2026-08-15T14:15:00.000Z")],
      },
    });
    const reordered = load({
      coverageStart: "2026-08-15T14:00:00.000Z",
      coverageEnd: "2026-08-15T15:00:00.000Z",
      quotes: [{ time: "2026-08-15T14:00:00.000Z", bid: 1900, ask: 1901 }],
      candles: {
        M15: [candle("M15", "2026-08-15T14:15:00.000Z"), candle("M15", "2026-08-15T14:00:00.000Z")],
        H1: [candle("H1", "2026-08-15T14:00:00.000Z")],
      },
    });
    expect(aligned.instrument).toBe("XAUUSD");
    expect(aligned.timezone).toBe("UTC");
    expect(aligned.fingerprint).toBe(reordered.fingerprint);
    expect(aligned.orderingRule).toBe("time,kind,timeframe,seq");
    expect(contentHash({ b: 1, a: { d: 2, c: 3 } })).toBe(contentHash({ a: { c: 3, d: 2 }, b: 1 }));
    expect(load({
      coverageStart: "2026-08-15T14:00:00.000Z",
      coverageEnd: "2026-08-15T15:00:00.000Z",
      quotes: [{ time: "2026-08-15T14:00:00.000Z", bid: 1900, ask: 1901 }],
      candles: {
        M15: [candle("M15", "2026-08-15T14:00:00.000Z"), candle("M15", "2026-08-15T14:15:00.000Z")],
        H1: [candle("H1", "2026-08-15T14:00:00.000Z")],
      },
      contentHash: aligned.fingerprint,
    }).fingerprint).toBe(aligned.fingerprint);
    expect(() => load({ ...alignedInput(), contentHash: "0".repeat(64) })).toThrow(/content hash/);
    expect(() => load({ ...alignedInput(), instrument: "EURUSD" as "XAUUSD" })).toThrow(TradingDomainError);
    expect(() => load({ ...alignedInput(), timezone: "America/New_York" as "UTC" })).toThrow(/UTC/);
    expect(() => load({ ...alignedInput(), candles: { "15m": [candle("M15", "2026-08-15T14:00:00.000Z")] } })).toThrow(TradingDomainError);
    expect(() => load({
      ...alignedInput(),
      candles: { M15: [candle("M15", "2026-08-15T14:07:00.000Z")] },
    })).toThrow(/aligned/);
    expect(() => load({
      ...alignedInput(),
      candles: { M15: [candle("M15", "2026-08-15T14:00:00.000Z", 90, 95)] },
    })).toThrow(TradingDomainError);
    expect(() => load({
      ...alignedInput(),
      candles: {
        M15: [
          candle("M15", "2026-08-15T14:00:00.000Z", 100.5, 101),
          candle("M15", "2026-08-15T14:00:00.000Z", 110, 111),
        ],
      },
    })).toThrow(/duplicate/);
    expect(() => load({
      ...alignedInput(),
      quotes: [
        { time: "2026-08-15T14:00:00.000Z", bid: 1, ask: 2 },
        { time: "2026-08-15T14:00:00.000Z", bid: 1, ask: 2 },
      ],
    })).toThrow(/duplicate quote/);
    expect(() => load({
      ...alignedInput(),
      quotes: [{ time: "2026-08-15T14:00:00.000Z", bid: 3, ask: 2 }],
    })).toThrow(/bid cannot exceed ask/);
    expect(() => load({
      ...alignedInput(),
      quotes: [{ time: "2026-08-15T16:00:00.000Z", bid: 1, ask: 2 }],
    })).toThrow(/coverage/);
    expect(() => load({
      ...alignedInput(),
      candles: { M15: [candle("M15", "2026-08-15T15:00:00.000Z")] },
    })).toThrow(/coverage/);
    expect(() => createReplayDataset({ ...alignedInput(), autonomy: 5 } as ReplayDatasetInput)).toThrow(/not part of the dataset/);
    expect(() => createReplayDataset({ ...alignedInput(), apiKey: "live-secret" } as ReplayDatasetInput)).toThrow(/credentials/);
    const rows = [candle("M15", "2026-08-15T14:00:00.000Z")];
    const frozen = load({ ...alignedInput(), candles: { M15: rows } });
    rows.push(candle("M15", "2026-08-15T14:15:00.000Z"));
    expect(frozen.candles.M15).toHaveLength(1);
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  it("orders equal timestamps by kind, timeframe, then input sequence", () => {
    const at = "2026-08-15T14:00:00.000Z";
    const dataset = load({
      coverageStart: at,
      coverageEnd: "2026-08-15T18:00:00.000Z",
      quotes: [{ time: at, bid: 10, ask: 11 }],
      prints: [
        { time: at, price: 10.2 },
        { time: at, price: 10.8 },
      ],
      candles: {
        H1: [candle("H1", at)],
        M1: [candle("M1", at)],
        M15: [candle("M15", at)],
      },
    });
    expect(dataset.events.map((event) => `${event.kind}:${event.timeframe ?? "-"}`)).toEqual([
      "quote:-",
      "print:-",
      "print:-",
      "candle:M1",
      "candle:M15",
      "candle:H1",
    ]);
    const swapped = load({
      coverageStart: at,
      coverageEnd: "2026-08-15T18:00:00.000Z",
      prints: [
        { time: at, price: 10.8 },
        { time: at, price: 10.2 },
      ],
      candles: { M1: [candle("M1", at)] },
    });
    expect(swapped.fingerprint).not.toBe(dataset.fingerprint);
    expect(swapped.prints.map((print) => print.price)).toEqual([10.8, 10.2]);
    expect(() => load({
      coverageStart: at,
      coverageEnd: "2026-08-15T15:00:00.000Z",
      prints: [{ time: at, price: 10 }, { time: at, price: 10 }],
    })).toThrow(/duplicate print/);
  });
});

describe("look-ahead", () => {
  const frames: ReadonlyArray<{ timeframe: XauUsdTimeframe; opens: [string, string, string] }> = [
    { timeframe: "M1", opens: ["2026-08-15T14:28:00.000Z", "2026-08-15T14:29:00.000Z", "2026-08-15T14:30:00.000Z"] },
    { timeframe: "M5", opens: ["2026-08-15T14:20:00.000Z", "2026-08-15T14:25:00.000Z", "2026-08-15T14:30:00.000Z"] },
    { timeframe: "M15", opens: ["2026-08-15T14:00:00.000Z", "2026-08-15T14:15:00.000Z", "2026-08-15T14:30:00.000Z"] },
    { timeframe: "M30", opens: ["2026-08-15T13:30:00.000Z", "2026-08-15T14:00:00.000Z", "2026-08-15T14:30:00.000Z"] },
    { timeframe: "H1", opens: ["2026-08-15T12:00:00.000Z", "2026-08-15T13:00:00.000Z", "2026-08-15T14:00:00.000Z"] },
    { timeframe: "H4", opens: ["2026-08-15T04:00:00.000Z", "2026-08-15T08:00:00.000Z", "2026-08-15T12:00:00.000Z"] },
    { timeframe: "D1", opens: ["2026-08-14T00:00:00.000Z", "2026-08-15T00:00:00.000Z", "2026-08-16T00:00:00.000Z"] },
  ];

  it.each(frames)("hides $timeframe until its close and not after", async ({ timeframe, opens }) => {
    const step = TIMEFRAME_MS[timeframe];
    const close = Date.parse(opens[1]) + step;
    const dataset = load({
      coverageStart: opens[0],
      coverageEnd: iso(Date.parse(opens[2]) + step),
      candles: {
        [timeframe]: [
          candle(timeframe, opens[0], 100.5, 101),
          candle(timeframe, opens[1], FUTURE, FUTURE),
          candle(timeframe, opens[2], FUTURE, FUTURE),
        ],
      },
      quotes: [
        { time: opens[0], bid: 100, ask: 101 },
        { time: iso(close + 60_000), bid: FUTURE, ask: FUTURE + 1 },
      ],
    });
    const replay = sessionFor(dataset, [timeframe], opens[0], iso(close + 1_000));
    const before = await replay.observe();
    expect(before.closed.flatMap((series) => series.candles.map((bar) => bar.time))).toEqual([]);
    expect(JSON.stringify(before)).not.toContain(String(FUTURE));

    replay.advanceTo(iso(close - 1));
    const almost = await replay.observe();
    expect(almost.closed[0]?.candles.map((bar) => bar.time)).toEqual([opens[0]]);
    expect(almost.quote?.bid).toBe(100);
    expect(JSON.stringify(almost)).not.toContain(String(FUTURE));

    replay.advanceTo(iso(close));
    const closed = await replay.observe();
    expect(closed.closed[0]?.candles.map((bar) => bar.time)).toEqual([opens[0], opens[1]]);
    expect(closed.closed[0]?.candles.map((bar) => bar.time)).not.toContain(opens[2]);

    replay.advanceTo(iso(close + 1));
    const after = await replay.observe();
    expect(after.closed[0]?.candles.map((bar) => bar.time)).toEqual([opens[0], opens[1]]);
    expect(JSON.stringify(replay.events)).not.toContain(String(FUTURE));
    expect(replay.now()).toBe(iso(close + 1));
  });

  it("uses the M15 close boundary the audit requires", async () => {
    const dataset = load({
      coverageStart: "2026-08-15T14:00:00.000Z",
      coverageEnd: "2026-08-15T14:45:00.000Z",
      candles: {
        M15: [
          candle("M15", "2026-08-15T14:00:00.000Z"),
          candle("M15", "2026-08-15T14:15:00.000Z", FUTURE, FUTURE),
          candle("M15", "2026-08-15T14:30:00.000Z", FUTURE, FUTURE),
        ],
      },
    });
    const replay = sessionFor(dataset, ["M15"], "2026-08-15T14:00:00.000Z", "2026-08-15T14:45:00.000Z");
    replay.advanceTo("2026-08-15T14:29:59.000Z");
    expect((await replay.observe()).closed[0]?.candles.map((bar) => bar.time)).toEqual(["2026-08-15T14:00:00.000Z"]);
    replay.advanceTo("2026-08-15T14:30:00.000Z");
    expect((await replay.observe()).closed[0]?.candles.map((bar) => bar.time)).toEqual([
      "2026-08-15T14:00:00.000Z",
      "2026-08-15T14:15:00.000Z",
    ]);
    replay.advanceTo("2026-08-15T14:30:01.000Z");
    const after = await replay.observe();
    expect(after.closed[0]?.candles.map((bar) => bar.time)).not.toContain("2026-08-15T14:30:00.000Z");
  });
});

describe("forming candles and quotes", () => {
  it("does not reconstruct a forming bar from future prints or the eventual OHLC", async () => {
    const dataset = load({
      coverageStart: "2026-08-15T14:00:00.000Z",
      coverageEnd: "2026-08-15T15:00:00.000Z",
      candles: {
        M15: [
          candle("M15", "2026-08-15T14:00:00.000Z"),
          candle("M15", "2026-08-15T14:15:00.000Z", 130, 2500),
          candle("M15", "2026-08-15T14:30:00.000Z"),
        ],
      },
      prints: [
        { time: "2026-08-15T14:16:00.000Z", price: 10, volume: 1 },
        { time: "2026-08-15T14:20:00.000Z", price: 12, volume: 1 },
        { time: "2026-08-15T14:30:00.000Z", price: 77, volume: 1 },
        { time: "2026-08-15T14:31:00.000Z", price: FUTURE, volume: 9 },
      ],
      quotes: [
        { time: "2026-08-15T14:20:00.000Z", bid: 10, ask: 11 },
        { time: "2026-08-15T14:31:00.000Z", bid: FUTURE, ask: FUTURE + 1 },
      ],
    });
    const replay = sessionFor(dataset, ["M15"], "2026-08-15T14:00:00.000Z", "2026-08-15T15:00:00.000Z");
    replay.advanceTo("2026-08-15T14:29:59.000Z");
    const forming = (await replay.observe()).forming[0];
    expect(forming).toMatchObject({ status: "available", open: 10, high: 12, low: 10, close: 12, volume: 2 });
    expect(JSON.stringify(forming)).not.toContain("2500");
    expect(JSON.stringify(forming)).not.toContain(String(FUTURE));
    expect((await replay.observe()).quote?.bid).toBe(10);

    replay.advanceTo("2026-08-15T14:30:00.000Z");
    const atClose = await replay.observe();
    expect(atClose.closed[0]?.candles.map((bar) => bar.time)).toEqual([
      "2026-08-15T14:00:00.000Z",
      "2026-08-15T14:15:00.000Z",
    ]);
    expect(atClose.forming[0]).toMatchObject({ openTime: "2026-08-15T14:30:00.000Z", open: 77, high: 77, close: 77 });
    expect(JSON.stringify(atClose.forming[0])).not.toContain(String(FUTURE));
    expect(atClose.quote?.bid).toBe(10);
  });

  it("returns insufficient data instead of fabricating a forming bar", async () => {
    const dataset = load({
      coverageStart: "2026-08-15T14:00:00.000Z",
      coverageEnd: "2026-08-15T15:00:00.000Z",
      candles: { M15: [candle("M15", "2026-08-15T14:00:00.000Z"), candle("M15", "2026-08-15T14:15:00.000Z")] },
      prints: [
        { time: "2026-08-15T14:16:00.000Z", price: 10 },
        { time: "2026-08-15T14:20:00.000Z", price: 12, volume: 4 },
      ],
    });
    const replay = sessionFor(dataset, ["M15"], "2026-08-15T14:00:00.000Z", "2026-08-15T15:00:00.000Z");
    const early = await replay.observe();
    expect(early.forming[0]).toMatchObject({ status: "unavailable", reason: "insufficient-data" });
    expect(early.forming[0]?.open).toBeUndefined();
    replay.advanceTo("2026-08-15T14:20:00.000Z");
    const mixed = (await replay.observe()).forming[0];
    expect(mixed?.status).toBe("available");
    expect(mixed?.volume).toBeUndefined();
  });
});

describe("observation", () => {
  it("keeps one coherent state per replay time and reports gaps", async () => {
    const start = "2026-08-15T00:00:00.000Z";
    const end = "2026-08-16T00:00:00.000Z";
    const candles: Record<string, Record<string, unknown>[]> = {};
    for (const timeframe of XAUUSD_TIMEFRAMES) {
      const step = TIMEFRAME_MS[timeframe];
      candles[timeframe] = [];
      for (let open = Date.parse(start); open + step <= Date.parse(end); open += step) {
        candles[timeframe].push(candle(timeframe, iso(open)));
      }
    }
    const dataset = load({
      coverageStart: start,
      coverageEnd: end,
      candles,
      quotes: [{ time: "2026-08-15T14:30:00.000Z", bid: 1900, ask: 1900.5 }],
    });
    const replay = sessionFor(dataset, XAUUSD_TIMEFRAMES, start, "2026-08-15T18:00:00.000Z");
    replay.advanceTo("2026-08-15T14:30:00.000Z");
    const observation = await replay.observe();
    expect(observation.observationAt).toBe("2026-08-15T14:30:00.000Z");
    expect(observation.provenance).toBe("REPLAY");
    expect(observation.environment).toBe("SIMULATOR");
    expect(observation.quality).toBe("COMPLETE");
    expect(observation.quote?.bid).toBe(1900);
    const last = (timeframe: XauUsdTimeframe) => (
      observation.closed.find((series) => series.timeframe === timeframe)?.candles.at(-1)?.time
    );
    expect(last("M1")).toBe("2026-08-15T14:29:00.000Z");
    expect(last("M5")).toBe("2026-08-15T14:25:00.000Z");
    expect(last("M15")).toBe("2026-08-15T14:15:00.000Z");
    expect(last("M30")).toBe("2026-08-15T14:00:00.000Z");
    expect(last("H1")).toBe("2026-08-15T13:00:00.000Z");
    expect(last("H4")).toBe("2026-08-15T08:00:00.000Z");
    expect(observation.closed.find((series) => series.timeframe === "D1")?.candles ?? []).toEqual([]);
    expect(observation.snapshot?.candles.some((bar) => bar.time === "2026-08-15T14:30:00.000Z")).toBe(false);
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.snapshot)).toBe(true);
    const frozenCandles = observation.closed[0]?.candles;
    expect(frozenCandles).toBeDefined();
    expect(() => {
      (frozenCandles as unknown[]).push(candle("M1", "2026-08-15T14:30:00.000Z"));
    }).toThrow(TypeError);

    const daily = load({
      coverageStart: "2026-08-14T00:00:00.000Z",
      coverageEnd: "2026-08-16T00:00:00.000Z",
      candles: {
        D1: [
          candle("D1", "2026-08-14T00:00:00.000Z"),
          candle("D1", "2026-08-15T00:00:00.000Z", FUTURE, FUTURE),
        ],
      },
    });
    const dailyReplay = sessionFor(daily, ["D1"], "2026-08-15T14:00:00.000Z", "2026-08-15T18:00:00.000Z");
    dailyReplay.advanceTo("2026-08-15T14:30:00.000Z");
    expect((await dailyReplay.observe()).closed[0]?.candles.map((bar) => bar.time)).toEqual(["2026-08-14T00:00:00.000Z"]);
  });

  it("marks a missing closed bar as partial and does not fill it", async () => {
    const dataset = load({
      coverageStart: "2026-08-15T14:00:00.000Z",
      coverageEnd: "2026-08-15T15:00:00.000Z",
      candles: {
        M15: [
          candle("M15", "2026-08-15T14:00:00.000Z"),
          candle("M15", "2026-08-15T14:30:00.000Z"),
        ],
      },
    });
    const replay = sessionFor(dataset, ["M15"], "2026-08-15T14:00:00.000Z", "2026-08-15T15:00:00.000Z");
    replay.advanceTo("2026-08-15T14:29:00.000Z");
    const early = await replay.observe();
    expect(early.quality).toBe("COMPLETE");
    expect(early.closed[0]?.candles.map((bar) => bar.time)).toEqual(["2026-08-15T14:00:00.000Z"]);
    replay.advanceTo("2026-08-15T14:30:00.000Z");
    const gap = await replay.observe();
    expect(gap.quality).toBe("PARTIAL");
    expect(gap.qualityReasons).toContain("gap in M15");
    expect(gap.closed[0]?.candles.map((bar) => bar.time)).toEqual(["2026-08-15T14:00:00.000Z"]);
    replay.advanceTo("2026-08-15T14:45:00.000Z");
    const later = await replay.observe();
    expect(later.closed[0]?.candles.map((bar) => bar.time)).toEqual([
      "2026-08-15T14:00:00.000Z",
      "2026-08-15T14:30:00.000Z",
    ]);
    expect(later.quality).toBe("PARTIAL");
  });

  it("fails closed outside coverage and when the snapshot would have to drop bars", async () => {
    const dataset = load({
      coverageStart: "2026-08-15T14:00:00.000Z",
      coverageEnd: "2026-08-15T15:00:00.000Z",
      candles: { M15: [candle("M15", "2026-08-15T14:00:00.000Z"), candle("M15", "2026-08-15T14:15:00.000Z")] },
      quotes: [{ time: "2026-08-15T14:00:00.000Z", bid: 10, ask: 11 }],
    });
    const replay = sessionFor(dataset, ["M15"], "2026-08-15T13:00:00.000Z", "2026-08-15T16:00:00.000Z");
    const before = await replay.observe();
    expect(before.quality).toBe("UNAVAILABLE");
    expect(before.snapshot).toBeNull();
    expect(before.quote).toBeNull();
    replay.advanceTo("2026-08-15T15:30:00.000Z");
    const after = await replay.observe();
    expect(after.quality).toBe("UNAVAILABLE");
    expect(after.snapshot).toBeNull();

    const bars = Array.from({ length: 2049 }, (_, index) => candle("M1", iso(Date.parse("2026-08-01T00:00:00.000Z") + index * 60_000)));
    const wide = load({
      coverageStart: "2026-08-01T00:00:00.000Z",
      coverageEnd: iso(Date.parse("2026-08-01T00:00:00.000Z") + 2050 * 60_000),
      candles: { M1: bars },
    });
    const overflow = sessionFor(wide, ["M1"], "2026-08-01T00:00:00.000Z", iso(Date.parse("2026-08-01T00:00:00.000Z") + 2050 * 60_000));
    overflow.advanceTo(iso(Date.parse("2026-08-01T00:00:00.000Z") + 2049 * 60_000));
    await expect(overflow.observe()).rejects.toThrow(TradingDomainError);
    expect(overflow.events.some((event) => event.type === "market.replay.failed")).toBe(true);
  });

  it("keeps a stale replay labeled REPLAY", async () => {
    const dataset = load({
      coverageStart: "2026-08-15T14:00:00.000Z",
      coverageEnd: "2026-08-15T18:00:00.000Z",
      quotes: [{ time: "2026-08-15T14:00:00.000Z", bid: 10, ask: 11 }],
      candles: { M15: [candle("M15", "2026-08-15T14:00:00.000Z")] },
    });
    const replay = createReplaySession({
      dataset,
      startAt: "2026-08-15T14:00:00.000Z",
      endAt: "2026-08-15T18:00:00.000Z",
      timeframes: ["M15"],
      limits: { staleAfterMs: 1_000, futureSkewMs: 0, abnormalLatencyMs: 1_000 },
      agentRunId: "run-stale",
    });
    replay.advanceTo("2026-08-15T14:30:00.000Z");
    const observation = await replay.observe();
    expect(observation.quote?.provenance).toBe("REPLAY");
    expect(observation.quote?.freshness).toBe("stale");
    expect(observation.snapshot?.provenance).toBe("REPLAY");
    expect(observation.snapshot?.freshness).toBe("stale");
  });
});

describe("determinism", () => {
  it("repeats the same observation, snapshot, and event order for the same inputs", async () => {
    const input: ReplayDatasetInput = {
      schemaVersion: 1,
      datasetId: "xau-aug",
      datasetVersion: "v1",
      instrument: "XAUUSD",
      source: "fixture",
      timezone: "UTC",
      coverageStart: "2026-08-15T14:00:00.000Z",
      coverageEnd: "2026-08-15T15:00:00.000Z",
      quotes: [
        { time: "2026-08-15T14:10:00.000Z", bid: 10, ask: 11 },
        { time: "2026-08-15T14:40:00.000Z", bid: FUTURE, ask: FUTURE + 1 },
      ],
      candles: {
        M15: [
          candle("M15", "2026-08-15T14:00:00.000Z"),
          candle("M15", "2026-08-15T14:15:00.000Z"),
          candle("M15", "2026-08-15T14:30:00.000Z", FUTURE, FUTURE),
        ],
      },
      prints: [{ time: "2026-08-15T14:16:00.000Z", price: 10.25, volume: 2 }],
    };
    const run = async () => {
      const replay = sessionFor(load(input), ["M15", "H1"], "2026-08-15T14:00:00.000Z", "2026-08-15T15:00:00.000Z");
      replay.advanceTo("2026-08-15T14:30:00.000Z");
      const observation = await replay.observe();
      return { observation, events: replay.events };
    };
    const first = await run();
    const second = await run();
    expect(first.observation.replaySessionId).toBe(second.observation.replaySessionId);
    expect(first.observation.contentHash).toBe(second.observation.contentHash);
    expect(first.observation.snapshotHash).toBe(second.observation.snapshotHash);
    expect(first.observation.snapshotId).toBe(second.observation.snapshotId);
    expect(contentHash(first.observation)).toBe(contentHash(second.observation));
    expect(contentHash(first.events)).toBe(contentHash(second.events));
    expect(first.observation.closed[0]?.candles.map((bar) => bar.time)).toEqual([
      "2026-08-15T14:00:00.000Z",
      "2026-08-15T14:15:00.000Z",
    ]);
    expect(first.observation.quote?.bid).toBe(10);

    const extended = load({
      ...input,
      datasetVersion: "v2",
      candles: {
        M15: [
          ...(input.candles?.M15 ?? []),
          candle("M15", "2026-08-15T14:45:00.000Z", FUTURE, FUTURE),
        ],
      },
    });
    const later = sessionFor(extended, ["M15", "H1"], "2026-08-15T14:00:00.000Z", "2026-08-15T15:00:00.000Z");
    later.advanceTo("2026-08-15T14:30:00.000Z");
    const extendedView = await later.observe();
    expect(extendedView.datasetFingerprint).not.toBe(first.observation.datasetFingerprint);
    expect(extendedView.closed[0]?.candles.map((bar) => bar.close)).toEqual(
      first.observation.closed[0]?.candles.map((bar) => bar.close),
    );
    expect(JSON.stringify(extendedView.closed)).not.toContain(String(FUTURE));
  });
});

describe("agent integration and isolation", () => {
  it("lets the existing tools read replay data without a second runtime", async () => {
    const dataset = load({
      coverageStart: "2026-08-15T14:00:00.000Z",
      coverageEnd: "2026-08-15T15:00:00.000Z",
      quotes: [
        { time: "2026-08-15T14:05:00.000Z", bid: 10, ask: 11 },
        { time: "2026-08-15T14:35:00.000Z", bid: FUTURE, ask: FUTURE + 1 },
      ],
      candles: {
        M15: [
          candle("M15", "2026-08-15T14:00:00.000Z"),
          candle("M15", "2026-08-15T14:15:00.000Z"),
          candle("M15", "2026-08-15T14:30:00.000Z", FUTURE, FUTURE),
        ],
        H1: [candle("H1", "2026-08-15T14:00:00.000Z", FUTURE, FUTURE)],
      },
      prints: [{ time: "2026-08-15T14:16:00.000Z", price: 12, volume: 1 }],
    });
    const replay = sessionFor(dataset, ["M15"], "2026-08-15T14:00:00.000Z", "2026-08-15T15:00:00.000Z", "run-1");
    replay.advanceTo("2026-08-15T14:20:00.000Z");
    const plain = createXauUsdToolSession({
      agentRunId: "run-plain",
      environment: "SIMULATOR",
      autonomyLevel: 2,
      permissions: ["market.read", "decision.propose", "intent.propose"],
      clock: { receivedAt: "2026-08-15T14:00:00.000Z", processedAt: "2026-08-15T14:00:00.000Z", limits: LIMITS },
      provider: replay.provider,
      correlation: ids(),
      modelProvider: "fixture",
      modelId: "model-a",
    });
    expect(plain.definitions.map((definition) => definition.function.name)).not.toContain("get_xauusd_observation");

    const replayGrant: XauUsdTurnGrant = {
      agentRunId: "run-1",
      environment: "SIMULATOR",
      autonomyLevel: 2,
      permissions: ["market.read", "decision.propose", "intent.propose"],
      clock: replay.marketClock(),
      provider: replay.provider,
      correlation: ids(),
      modelProvider: "fixture",
      modelId: "model-a",
    };
    const session = createXauUsdToolSession(bindReplayGrant(replay, replayGrant));
    const names = session.definitions.map((definition) => definition.function.name);
    expect(names).toContain("get_xauusd_quote");
    expect(names).toContain("get_xauusd_candles");
    expect(names).toContain("get_xauusd_observation");
    expect(names).not.toContain("place_order");
    expect(names).not.toContain("advance_replay");
    const quoteOnly = await call(session, "get_xauusd_quote");
    expect(quoteOnly.ok).toBe(true);
    expect(quoteOnly.body.provenance).toBe("REPLAY");
    expect((quoteOnly.body.quote as { bid: number }).bid).toBe(10);
    expect(replay.provider.calls.filter((entry) => entry.op === "candles")).toHaveLength(0);
    const candleOnly = await call(session, "get_xauusd_candles", {
      timeframe: "M15",
      from: "2026-08-15T14:00:00.000Z",
      to: "2026-08-15T18:00:00.000Z",
    });
    expect(candleOnly.body.candles).toEqual([
      expect.objectContaining({ time: "2026-08-15T14:00:00.000Z" }),
    ]);
    expect(JSON.stringify(candleOnly.body)).not.toContain(String(FUTURE));
    const rejected = await call(session, "get_xauusd_observation", { timestamp: "2026-08-15T14:45:00.000Z" });
    expect(rejected.ok).toBe(false);
    expect(replay.now()).toBe("2026-08-15T14:20:00.000Z");
    const observed = await call(session, "get_xauusd_observation");
    expect(observed.ok).toBe(true);
    expect(observed.body.quality).toBe("COMPLETE");
    assertToolSchema(
      XAUUSD_TOOL_CATALOG.find((spec) => spec.name === "get_xauusd_observation")!.outputSchema,
      observed.body,
    );
    expect(JSON.stringify(observed.body)).not.toContain(String(FUTURE));
    expect(session.invocations).toEqual([
      "get_xauusd_quote",
      "get_xauusd_candles",
      "get_xauusd_observation",
      "get_xauusd_observation",
    ]);
    const decision = await call(session, "propose_decision", {
      thesis: "The replay bar has not closed.",
      contextId: observed.body.contextId,
      snapshotId: observed.body.snapshotId,
      evidenceIds: [],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      missingInformation: ["forming bar is incomplete"],
      direction: "NO_TRADE",
      targets: [],
      expiry: "2026-08-15T18:00:00.000Z",
      evidenceQuality: "insufficient",
    });
    expect(decision.ok).toBe(true);
    const stored = decision.body.decision as { direction: string; snapshotId: string; createdAt: string; status: string };
    expect(stored.direction).toBe("NO_TRADE");
    expect(stored.status).toBe("DRAFT");
    expect(stored.snapshotId).toBe(observed.body.snapshotId);
    expect(stored.createdAt).toBe("2026-08-15T14:20:00.000Z");
    const intent = await call(session, "propose_decision", {
      thesis: "A proposal only.",
      contextId: observed.body.contextId,
      snapshotId: observed.body.snapshotId,
      evidenceIds: [],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      missingInformation: [],
      direction: "LONG",
      targets: [120],
      expiry: "2026-08-15T18:00:00.000Z",
      evidenceQuality: "low",
    });
    const proposed = await call(session, "propose_order_intent", {
      decisionId: (intent.body.decision as { id: string }).id,
      direction: "LONG",
      targets: [120],
    });
    expect(proposed.body.executed).toBe(false);
    expect(proposed.body.brokerContacted).toBe(false);
    expect((proposed.body.orderIntent as { executable: boolean; brokerSubmit: boolean }).executable).toBe(false);
    expect((proposed.body.orderIntent as { brokerSubmit: boolean }).brokerSubmit).toBe(false);
    const sealed = session.snapshot(String(observed.body.snapshotId));
    replay.advanceTo("2026-08-15T14:35:00.000Z");
    const next = await call(session, "get_xauusd_quote");
    expect((next.body.quote as { bid: number }).bid).toBe(FUTURE);
    expect(sealed?.bid).toBe(10);
    expect(replay.events.some((event) => event.type === "agent.thinking")).toBe(false);
    expect(replay.events.every((event) => event.agentRunId === "run-1")).toBe(true);
    expect(replay.events[0]).toMatchObject({
      type: "market.replay.started",
      runtimeThreadId: "thread-replay",
      runtimeTurnId: "turn-replay",
    });
    expect(() => bindReplayGrant(replay, { environment: "LIVE" })).toThrow(/PAPER or LIVE/);
    expect(() => bindReplayGrant(replay, { environment: "PAPER" })).toThrow(/PAPER or LIVE/);
    expect(environmentBinding("SIMULATOR")).toMatchObject({
      credentialSlot: "none",
      liveExecutionEnabled: false,
      brokerNetworkEnabled: false,
    });
    expect(replay.provider.successProvenance).toBe("REPLAY");
    expect(replay.provider.environment).toBe("SIMULATOR");
    replay.complete();
    expect(replay.events.some((event) => event.type === "market.replay.completed")).toBe(true);
    expect(() => replay.advanceTo("2026-08-15T14:40:00.000Z")).toThrow(/completed/);
    for (const file of readdirSync(new URL(".", import.meta.url))) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toContain("Date.now");
      expect(source).not.toContain("EventBus");
      expect(source).not.toContain("new EventEmitter");
      expect(source).not.toContain("startTurn");
      expect(source).not.toContain("place_order");
      expect(source).not.toContain("fetch(");
    }
  });
});

function alignedInput(): ReplayDatasetInput {
  return {
    schemaVersion: 1,
    datasetId: "xau-aug",
    datasetVersion: "v1",
    instrument: "XAUUSD",
    source: "fixture",
    timezone: "UTC",
    coverageStart: "2026-08-15T14:00:00.000Z",
    coverageEnd: "2026-08-15T15:00:00.000Z",
    quotes: [{ time: "2026-08-15T14:00:00.000Z", bid: 1900, ask: 1901 }],
    candles: { M15: [candle("M15", "2026-08-15T14:00:00.000Z")] },
  };
}

function ids() {
  let n = 0;
  const next = () => `id-${++n}`;
  return {
    runtimeThreadId: "thread-1",
    runtimeTurnId: "turn-1",
    nextRuntimeEventId: next,
    nextTradingEventId: next,
    nextRecordId: next,
  };
}
