import { describe, expect, it } from "vitest";

import { XAUUSD_TIMEFRAMES } from "../../shared/trading/snapshot.ts";
import { adaptXauUsdChart, candlesInRequestWindow, toKLineCandle } from "./kline-adapter.ts";

const AT = "2026-08-15T14:30:00.000Z";

function candle(overrides: Record<string, unknown> = {}) {
  return {
    timeframe: "M15",
    time: AT,
    open: 2300,
    high: 2310,
    low: 2290,
    close: 2305,
    volume: 12,
    ...overrides,
  };
}

describe("klinechart pro adapter", () => {
  it("maps a canonical XAUUSD candle and keeps the engine name", () => {
    const mapped = toKLineCandle(candle());
    expect(mapped).toEqual({ timestamp: Date.parse(AT), open: 2300, high: 2310, low: 2290, close: 2305, volume: 12 });
    const chart = adaptXauUsdChart({ symbol: "XAUUSD", provenance: "LIVE", candles: [candle()] });
    expect(chart.engine).toBe("klinechart-pro");
    expect(chart.status).toBe("ready");
    expect(chart.labeledLive).toBe(true);
    expect(chart.provenance).toBe("LIVE");
    expect(chart.period).toEqual({ multiplier: 15, timespan: "minute", text: "M15" });
    expect(chart.symbol?.ticker).toBe("XAUUSD");
    expect(chart.candles).toEqual([mapped]);
  });

  it("labels stale, simulator, replay, and unavailable data without calling them live", () => {
    const stale = adaptXauUsdChart({ symbol: "XAUUSD", provenance: "STALE", candles: [candle()] });
    expect(stale.status).toBe("stale");
    expect(stale.provenance).toBe("STALE");
    expect(stale.labeledLive).toBe(false);
    expect(stale.candles).toHaveLength(1);

    for (const provenance of ["SIMULATOR", "REPLAY", "UNAVAILABLE"] as const) {
      const chart = adaptXauUsdChart({ symbol: "XAUUSD", provenance, candles: [candle()] });
      expect(chart.provenance).toBe(provenance);
      expect(chart.labeledLive).toBe(false);
      expect(chart.status).toBe("unavailable");
      expect(chart.candles).toEqual([]);
    }
  });

  it("does not relabel an unknown source as live", () => {
    const chart = adaptXauUsdChart({ symbol: "XAUUSD", provenance: "FIXTURE", candles: [candle()] });
    expect(chart.provenance).toBe("UNAVAILABLE");
    expect(chart.labeledLive).toBe(false);
    expect(chart.candles).toEqual([]);
    expect(chart.status).toBe("unavailable");
  });

  it("accepts only the canonical timeframes and does not rename another frame", () => {
    for (const timeframe of XAUUSD_TIMEFRAMES) {
      const chart = adaptXauUsdChart({ symbol: "XAUUSD", provenance: "LIVE", candles: [candle({ timeframe })] });
      expect(chart.reason).toBeNull();
      expect(chart.period?.text).toBe(timeframe);
      expect(chart.candles).toHaveLength(1);
    }
    for (const timeframe of ["W1", "15m", "H2", "M10", "1D"]) {
      const chart = adaptXauUsdChart({ symbol: "XAUUSD", provenance: "LIVE", candles: [candle({ timeframe })] });
      expect(chart.reason).toBe("UNSUPPORTED_TIMEFRAME");
      expect(chart.period).toBeNull();
      expect(chart.candles).toEqual([]);
    }
  });

  it("rejects a foreign symbol, a missing series, and an invalid bar", () => {
    for (const symbol of ["EURUSD", "GBPUSD", "USDJPY", "XAGUSD", "BTCUSD", "NZDCHF"]) {
      const rejected = adaptXauUsdChart({ symbol, provenance: "LIVE", candles: [candle()] });
      expect(rejected.reason).toBe("INSTRUMENT_REJECTED");
      expect(rejected.candles).toEqual([]);
      expect(rejected.symbol).toBeNull();
    }
    expect(adaptXauUsdChart({ symbol: "XAUUSD", provenance: "LIVE", candles: [] }).reason).toBe("MISSING_CANDLES");
    expect(adaptXauUsdChart({ symbol: "XAUUSD", provenance: "LIVE", candles: [candle({ high: 1 })] }).reason).toBe("INVALID_OHLC");
    expect(adaptXauUsdChart({ symbol: "XAUUSD", provenance: "LIVE", candles: [candle({ timeframe: "W1" })] }).reason).toBe("UNSUPPORTED_TIMEFRAME");
    expect(adaptXauUsdChart({
      symbol: "XAUUSD",
      provenance: "LIVE",
      candles: [candle({ timeframe: "W1" })],
    }).candles).toEqual([]);
  });

  it("marks a position only after authoritative position state, not after acceptance alone", () => {
    const events = [
      { type: "decision.created", at: AT },
      { type: "execution.accepted", at: AT },
      { type: "position.observed", at: AT },
    ];
    const pending = adaptXauUsdChart({
      symbol: "XAUUSD",
      provenance: "LIVE",
      candles: [candle()],
      positionState: "POSITION_PENDING",
      events,
    });
    expect(pending.markers.map((marker) => marker.kind)).toEqual(["decision", "execution"]);
    const open = adaptXauUsdChart({
      symbol: "XAUUSD",
      provenance: "LIVE",
      candles: [candle()],
      positionState: "POSITION_OPEN",
      events,
    });
    expect(open.markers.map((marker) => marker.kind)).toEqual(["decision", "position"]);
    expect(JSON.stringify(open)).not.toContain("metaapi");
    expect(JSON.stringify(open)).not.toContain("token");
    expect(JSON.stringify(open)).not.toContain("apiKey");
    expect(JSON.stringify(open)).not.toContain("secret");
  });

  it("draws fill and approval marks from those events and does not invent an exit or a fill from reconciliation", () => {
    const chart = adaptXauUsdChart({
      symbol: "XAUUSD",
      provenance: "LIVE",
      candles: [candle()],
      positionState: "POSITION_CLOSED",
      events: [
        { type: "approval.approved", at: AT },
        { type: "execution.filled", at: AT },
        { type: "position.closed", at: AT },
        { type: "reconciliation.completed", at: AT },
      ],
    });
    expect(chart.markers.map((marker) => marker.kind)).toEqual(["approval", "fill"]);
    expect(chart.markers.some((marker) => marker.kind === "exit" || marker.kind === "position")).toBe(false);
  });

  it("keeps a real decision marker when candles are missing and does not invent a position", () => {
    const chart = adaptXauUsdChart({
      symbol: "XAUUSD",
      provenance: "UNAVAILABLE",
      candles: [],
      positionState: "POSITION_PENDING",
      events: [
        { type: "decision.created", at: AT },
        { type: "execution.accepted", at: AT },
        { type: "position.observed", at: AT },
      ],
    });
    expect(chart.candles).toEqual([]);
    expect(chart.labeledLive).toBe(false);
    expect(chart.markers.map((marker) => marker.kind)).toEqual(["decision", "execution"]);
  });

  it("returns the supplied series when the widget window misses it and does not fill the gap", () => {
    const mapped = toKLineCandle(candle());
    expect(mapped).not.toBeNull();
    const stamp = mapped?.timestamp ?? 0;
    expect(candlesInRequestWindow([mapped!], stamp + 86_400_000, stamp + 90_000_000)).toEqual([mapped]);
    expect(candlesInRequestWindow([mapped!], stamp - 60_000, stamp + 60_000)).toEqual([mapped]);
    expect(candlesInRequestWindow([mapped!], stamp - 120_000, stamp - 60_000)).toEqual([]);
  });
});
