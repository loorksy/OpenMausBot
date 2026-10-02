import { XAUUSD_TIMEFRAMES, type XauUsdTimeframe } from "../../shared/trading/snapshot.ts";

/** Presentation conversion for KLineChart Pro. The chart is not a market
 * provider and these objects are not broker orders. */
export const CHART_ENGINE = "klinechart-pro" as const;

export const XAUUSD_CHART_SYMBOL = Object.freeze({
  ticker: "XAUUSD",
  name: "XAUUSD",
  shortName: "XAUUSD",
  priceCurrency: "usd",
  type: "metal",
});

const PERIODS: Record<XauUsdTimeframe, { readonly multiplier: number; readonly timespan: string; readonly text: XauUsdTimeframe }> = {
  M1: { multiplier: 1, timespan: "minute", text: "M1" },
  M5: { multiplier: 5, timespan: "minute", text: "M5" },
  M15: { multiplier: 15, timespan: "minute", text: "M15" },
  M30: { multiplier: 30, timespan: "minute", text: "M30" },
  H1: { multiplier: 1, timespan: "hour", text: "H1" },
  H4: { multiplier: 4, timespan: "hour", text: "H4" },
  D1: { multiplier: 1, timespan: "day", text: "D1" },
};

const PROVENANCE = ["LIVE", "STALE", "SIMULATOR", "REPLAY", "UNAVAILABLE"] as const;
const POSITION_STATES = new Set(["POSITION_OPEN", "POSITION_PARTIALLY_OPEN", "POSITION_CLOSING", "POSITION_CLOSED"]);
const MARKER_EVENTS: Record<string, string> = {
  "decision.created": "decision",
  "approval.approved": "approval",
  "execution.accepted": "execution",
  "execution.filled": "fill",
  "position.observed": "position",
};

export interface CanonicalCandle {
  readonly timeframe: string;
  readonly time: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume?: number;
}

export interface KLineCandle {
  readonly timestamp: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume?: number;
}

export interface ChartMarker {
  readonly kind: string;
  readonly at: string;
}

export interface XauUsdChartModel {
  readonly engine: typeof CHART_ENGINE;
  readonly symbol: typeof XAUUSD_CHART_SYMBOL | null;
  readonly provenance: string;
  readonly labeledLive: boolean;
  readonly status: "ready" | "stale" | "unavailable";
  readonly reason: string | null;
  readonly period: { readonly multiplier: number; readonly timespan: string; readonly text: string } | null;
  readonly periods: readonly { readonly multiplier: number; readonly timespan: string; readonly text: string }[];
  readonly candles: readonly KLineCandle[];
  readonly markers: readonly ChartMarker[];
}

export function adaptXauUsdChart(input: {
  readonly symbol: string;
  readonly provenance: string;
  readonly candles: readonly CanonicalCandle[];
  readonly positionState?: string | null;
  readonly events?: readonly { readonly type: string; readonly at: string }[];
}): XauUsdChartModel {
  const provenance = (PROVENANCE as readonly string[]).includes(input.provenance) ? input.provenance : "UNAVAILABLE";
  const xauusd = input.symbol === "XAUUSD";
  const empty = (reason: string, status: XauUsdChartModel["status"] = "unavailable"): XauUsdChartModel => ({
    engine: CHART_ENGINE,
    symbol: xauusd ? XAUUSD_CHART_SYMBOL : null,
    provenance,
    labeledLive: false,
    status,
    reason,
    period: null,
    periods: [],
    candles: [],
    markers: xauusd ? chartMarkers(input.events ?? [], input.positionState ?? null) : [],
  });
  if (input.symbol !== "XAUUSD") return empty("INSTRUMENT_REJECTED");
  if (provenance === "SIMULATOR" || provenance === "REPLAY" || provenance === "UNAVAILABLE") return empty("UNAVAILABLE");
  if (input.candles.length === 0) return empty("MISSING_CANDLES", provenance === "STALE" ? "stale" : "unavailable");
  const timeframe = input.candles[0]?.timeframe;
  if (timeframe === undefined || !isTimeframe(timeframe) || input.candles.some((candle) => candle.timeframe !== timeframe)) {
    return empty("UNSUPPORTED_TIMEFRAME");
  }
  const candles: KLineCandle[] = [];
  for (const candle of input.candles) {
    const mapped = toKLineCandle(candle);
    if (mapped === null) return empty("INVALID_OHLC");
    candles.push(mapped);
  }
  const period = PERIODS[timeframe];
  return {
    engine: CHART_ENGINE,
    symbol: XAUUSD_CHART_SYMBOL,
    provenance,
    labeledLive: provenance === "LIVE",
    status: provenance === "STALE" ? "stale" : "ready",
    reason: null,
    period,
    periods: [period],
    candles,
    markers: chartMarkers(input.events ?? [], input.positionState ?? null),
  };
}

/** Bars the chart widget asked for. A wall-clock window that misses an older
 * canonical series still returns that series. It does not invent bars. */
export function candlesInRequestWindow(rows: readonly KLineCandle[], from: number, to: number): KLineCandle[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  const matched = rows.filter((row) => row.timestamp >= from && row.timestamp <= to);
  if (matched.length > 0) return matched.map((row) => ({ ...row }));
  const newest = rows.reduce((max, row) => Math.max(max, row.timestamp), Number.NEGATIVE_INFINITY);
  if (rows.length > 0 && to >= newest) return rows.map((row) => ({ ...row }));
  return [];
}

export function toKLineCandle(candle: CanonicalCandle): KLineCandle | null {
  const timestamp = Date.parse(candle.time);
  if (!Number.isFinite(timestamp)) return null;
  const { open, high, low, close } = candle;
  if (![open, high, low, close].every((price) => Number.isFinite(price) && price > 0)) return null;
  if (high < open || high < close || high < low || low > open || low > close) return null;
  if (candle.volume !== undefined && (!Number.isFinite(candle.volume) || candle.volume < 0)) return null;
  return {
    timestamp,
    open,
    high,
    low,
    close,
    ...(candle.volume === undefined ? {} : { volume: candle.volume }),
  };
}

function chartMarkers(
  events: readonly { readonly type: string; readonly at: string }[],
  positionState: string | null,
): ChartMarker[] {
  const markers: ChartMarker[] = [];
  for (const event of events) {
    const kind = MARKER_EVENTS[event.type];
    if (kind === undefined || event.at.length === 0) continue;
    if (kind === "position" && (positionState === null || !POSITION_STATES.has(positionState))) continue;
    if (kind === "execution" && positionState === "POSITION_OPEN") continue;
    markers.push({ kind, at: event.at });
  }
  return markers;
}

function isTimeframe(value: string): value is XauUsdTimeframe {
  return (XAUUSD_TIMEFRAMES as readonly string[]).includes(value);
}
