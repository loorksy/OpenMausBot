import type { XauUsdTimeframe } from "../../../shared/trading/snapshot.ts";
import type { RawProviderResult } from "../infrastructure/market_data/model.ts";
import type { CandleRange, XauUsdMarketDataProvider } from "../infrastructure/market_data/provider.ts";
import { TIMEFRAME_MS } from "../infrastructure/market_data/timeframe.ts";
import type { ReplayClock } from "./clock.ts";
import type { ReplayDataset } from "./dataset.ts";

export interface ReplayProviderCall {
  readonly op: "quote" | "candles";
  readonly at: string;
  readonly timeframe?: XauUsdTimeframe;
}

export interface ReplayMarketProvider extends XauUsdMarketDataProvider {
  readonly calls: readonly ReplayProviderCall[];
}

/** Serves only the XAUUSD facts whose time is already knowable on `clock`.
 * A closed candle is included only when its close time is at or before now.
 * This provider does not read the wall clock, the network, or credentials. */
export function createReplayMarketProvider(dataset: ReplayDataset, clock: ReplayClock): ReplayMarketProvider {
  const calls: ReplayProviderCall[] = [];
  return {
    providerId: `replay:${dataset.datasetId}`,
    environment: "SIMULATOR",
    successProvenance: "REPLAY",
    calls,
    async getXauUsdQuote(): Promise<RawProviderResult> {
      const at = clock.now();
      calls.push({ op: "quote", at });
      const now = Date.parse(at);
      let selected: (typeof dataset.quotes)[number] | undefined;
      for (const quote of dataset.quotes) {
        if (Date.parse(quote.time) <= now) selected = quote;
      }
      if (!selected) {
        return { ok: false, failure: "unavailable", message: "no XAUUSD quote is knowable at the replay time" };
      }
      return {
        ok: true,
        providerTimestamp: selected.time,
        provenance: "REPLAY",
        instrument: "XAUUSD",
        quote: { bid: selected.bid, ask: selected.ask, spread: selected.spread },
      };
    },
    async getXauUsdCandles(timeframe: XauUsdTimeframe, range: CandleRange): Promise<RawProviderResult> {
      const at = clock.now();
      calls.push({ op: "candles", at, timeframe });
      const now = Date.parse(at);
      const from = Date.parse(range.from);
      const to = Date.parse(range.to);
      if (Number.isNaN(from) || Number.isNaN(to)) {
        return { ok: false, failure: "malformed_response", message: "candle range is invalid" };
      }
      const step = TIMEFRAME_MS[timeframe];
      const candles = dataset.candles[timeframe].filter((candle) => {
        const open = Date.parse(candle.time);
        const close = open + step;
        return close <= now && open >= from && open < to;
      });
      const latest = candles.length === 0
        ? at
        : new Date(Date.parse(candles[candles.length - 1].time) + step).toISOString();
      return {
        ok: true,
        providerTimestamp: latest,
        provenance: "REPLAY",
        instrument: "XAUUSD",
        explicitEmpty: candles.length === 0,
        candles: candles.map((candle) => ({ ...candle })),
      };
    },
  };
}
