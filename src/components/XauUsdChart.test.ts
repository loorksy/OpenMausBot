import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { XauUsdChart } from "./XauUsdChart.tsx";

describe("XAUUSD chart view", () => {
  it("shows the canonical unavailable state and does not mount a candle series", () => {
    const html = renderToStaticMarkup(createElement(XauUsdChart, {
      symbol: "XAUUSD",
      provenance: "UNAVAILABLE",
      candles: [],
    }));
    expect(html).toContain("data-chart-engine=\"klinechart-pro\"");
    expect(html).toContain("UNAVAILABLE · Waiting for live XAUUSD market data");
    expect(html).not.toContain("class=\"xauusd-kline\"");
    expect(html).not.toContain("metaapi");
    expect(html).not.toContain("token");
  });

  it("keeps a foreign symbol off the chart", () => {
    const html = renderToStaticMarkup(createElement(XauUsdChart, {
      symbol: "EURUSD",
      provenance: "LIVE",
      candles: [{
        timeframe: "M15",
        time: "2026-08-15T14:30:00.000Z",
        open: 1.1,
        high: 1.2,
        low: 1.0,
        close: 1.15,
      }],
    }));
    expect(html).toContain("Waiting for live XAUUSD market data");
    expect(html).not.toContain("class=\"xauusd-kline\"");
    expect(html).not.toContain("1.15");
  });

  it("shows STALE on a drawable series and keeps simulator candles off the mount", () => {
    const bar = {
      timeframe: "H1",
      time: "2026-08-15T14:00:00.000Z",
      open: 2320.5,
      high: 2331,
      low: 2316.4,
      close: 2327.6,
      volume: 1964,
    };
    const stale = renderToStaticMarkup(createElement(XauUsdChart, {
      symbol: "XAUUSD",
      provenance: "STALE",
      candles: [bar],
    }));
    expect(stale).toContain("STALE · XAUUSD · stale");
    expect(stale).toContain("class=\"xauusd-kline");
    expect(stale).not.toContain("LIVE · XAUUSD · ready");

    const simulator = renderToStaticMarkup(createElement(XauUsdChart, {
      symbol: "XAUUSD",
      provenance: "SIMULATOR",
      candles: [bar],
    }));
    expect(simulator).toContain("SIMULATOR · Waiting for live XAUUSD market data");
    expect(simulator).not.toContain("class=\"xauusd-kline");
    expect(simulator).not.toContain("2327.6");
  });
});
