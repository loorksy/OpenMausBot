import type { XauUsdCandle, XauUsdTimeframe } from "../../../shared/trading/snapshot.ts";
import { canonicalizeUtc } from "../infrastructure/market_data/clock.ts";
import { readXauUsdCandles } from "../infrastructure/market_data/read.ts";
import type { XauUsdMarketDataProvider } from "../infrastructure/market_data/provider.ts";
import { TIMEFRAME_MS } from "../infrastructure/market_data/timeframe.ts";

/** Same observation window the native XAUUSD turn already uses. */
const DESK_OBSERVATION_LIMITS = {
  staleAfterMs: 60_000,
  futureSkewMs: 2_000,
  abnormalLatencyMs: 5_000,
} as const;

export const DESK_CHART_TIMEFRAME: XauUsdTimeframe = "M15";
export const DESK_CHART_BAR_COUNT = 500;

export interface DeskChartSeries {
  readonly provenance: "LIVE" | "STALE" | "UNAVAILABLE";
  readonly timeframe: XauUsdTimeframe | null;
  readonly candles: readonly XauUsdCandle[];
}

/** One market read for the authenticated desk request. It does not persist
 * events, poll, or call OANDA when the installed provider is absent or is
 * not a live-provenance feed. */
export async function readDeskChartCandles(input: {
  readonly provider: XauUsdMarketDataProvider | null;
  readonly now: string;
  readonly timeframe?: XauUsdTimeframe;
}): Promise<DeskChartSeries> {
  const timeframe = input.timeframe ?? DESK_CHART_TIMEFRAME;
  const unavailable = (): DeskChartSeries => ({ provenance: "UNAVAILABLE", timeframe: null, candles: [] });
  if (input.provider === null || input.provider.successProvenance !== "LIVE") return unavailable();
  let now: string;
  try {
    now = canonicalizeUtc(input.now).iso;
  } catch {
    return unavailable();
  }
  const toMs = Date.parse(now);
  if (Number.isNaN(toMs)) return unavailable();
  const from = new Date(toMs - DESK_CHART_BAR_COUNT * TIMEFRAME_MS[timeframe]).toISOString();
  let sequence = 0;
  const read = await readXauUsdCandles(input.provider, timeframe, { from, to: now }, {
    agentRunId: "desk-market-read",
    correlationId: "desk-market-read",
    versionManifestId: "desk-market-read",
    clock: {
      receivedAt: now,
      processedAt: now,
      limits: DESK_OBSERVATION_LIMITS,
    },
    nextEventId: () => `desk-market-${++sequence}`,
  });
  if (!read.ok) return unavailable();
  if (read.data.provenance !== "LIVE" && read.data.provenance !== "STALE") return unavailable();
  return {
    provenance: read.data.provenance,
    timeframe,
    candles: read.data.candles,
  };
}
