import { useEffect, useMemo, useRef } from "react";
import "@klinecharts/pro/dist/klinecharts-pro.css";

import { adaptXauUsdChart, candlesInRequestWindow, type CanonicalCandle } from "../trading/kline-adapter.ts";

/** Renders KLineChart Pro from a canonical series. It does not fetch market
 * data, and it does not create candles when the series is unavailable. */
export function XauUsdChart({
  symbol,
  provenance,
  candles,
  positionState,
  events,
}: {
  readonly symbol: string;
  readonly provenance: string;
  readonly candles: readonly CanonicalCandle[];
  readonly positionState?: string | null;
  readonly events?: readonly { readonly type: string; readonly at: string }[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const model = useMemo(
    () => adaptXauUsdChart({ symbol, provenance, candles, positionState, events }),
    [symbol, provenance, candles, positionState, events],
  );
  useEffect(() => {
    const node = host.current;
    const period = model.period;
    const chartSymbol = model.symbol;
    if (node === null || period === null || chartSymbol === null || model.candles.length === 0) return;
    let disposed = false;
    const rows = model.candles.map((candle) => ({ ...candle }));
    const periodCopy = { ...period };
    const symbolCopy = { ...chartSymbol };
    void import("@klinecharts/pro").then(({ KLineChartPro }) => {
      if (disposed) return;
      const chart = new KLineChartPro({
        container: node,
        theme: "dark",
        locale: "en-US",
        timezone: "UTC",
        drawingBarVisible: false,
        symbol: symbolCopy,
        period: periodCopy,
        periods: [periodCopy],
        mainIndicators: [],
        subIndicators: [],
        datafeed: {
          searchSymbols: async (search) => {
            const query = search?.trim().toUpperCase() ?? "";
            return query.length === 0 || "XAUUSD".includes(query) ? [symbolCopy] : [];
          },
          getHistoryKLineData: async (requested, requestedPeriod, from, to) => (
            requested.ticker === "XAUUSD" && requestedPeriod.timespan === periodCopy.timespan && requestedPeriod.multiplier === periodCopy.multiplier
              ? candlesInRequestWindow(rows, from, to)
              : []
          ),
          subscribe: () => undefined,
          unsubscribe: () => undefined,
        },
      });
      chart.setTheme("dark");
    }).catch(() => undefined);
    return () => {
      disposed = true;
      node.replaceChildren();
    };
  }, [model]);
  const waiting = model.status === "unavailable" || model.candles.length === 0;
  return (
    <div data-chart-engine={model.engine} data-provenance={model.provenance} data-chart-status={model.status}>
      <div className="flex items-center gap-3 px-1">
        <strong>XAUUSD</strong>
        {model.period ? <span>{model.period.text}</span> : null}
      </div>
      {waiting ? (
        <p className="px-1 py-6 text-ink-secondary">{model.provenance} · Waiting for live XAUUSD market data</p>
      ) : (
        <div
          ref={host}
          dir="ltr"
          className="xauusd-kline mt-2 w-full bg-inset"
          style={{ height: "min(70vh, 560px)", minHeight: 280, touchAction: "pan-x pinch-zoom" }}
        />
      )}
      <p className="px-1 pt-2 text-ink-secondary">{model.provenance} · XAUUSD · {model.status}</p>
      {model.markers.length > 0 ? (
        <ul className="px-1 text-ink-secondary">
          {model.markers.map((marker, index) => (
            <li key={`${marker.kind}-${marker.at}-${index}`}>{marker.kind} · {marker.at}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
