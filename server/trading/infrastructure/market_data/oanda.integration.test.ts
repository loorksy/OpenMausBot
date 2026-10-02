import { describe, expect, it } from "vitest";

import { adaptXauUsdChart } from "../../../../src/trading/kline-adapter.ts";
import { projectDesk } from "../../desk/project.ts";
import { readDeskChartCandles } from "../../desk/market.ts";
import {
  OANDA_ACCOUNT_ID_ENV,
  OANDA_API_TOKEN_ENV,
  OANDA_ENVIRONMENT_ENV,
  createOandaXauUsdMarketDataProvider,
  readOandaMarketConfig,
  type OandaHttpExchange,
} from "./oanda.ts";

const TOKEN = "fixture-oanda-token-0123456789";
const ACCOUNT = "001-001-1234567-001";
const NOW = "2026-10-01T12:00:00.000Z";
const OPEN = "2026-10-01T11:59:00.000Z";

describe("OANDA desk chart path", () => {
  it("carries a mocked XAUUSD series through the desk reader into the chart adapter", async () => {
    const read = readOandaMarketConfig({
      [OANDA_API_TOKEN_ENV]: TOKEN,
      [OANDA_ACCOUNT_ID_ENV]: ACCOUNT,
      [OANDA_ENVIRONMENT_ENV]: "live",
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const calls: OandaHttpExchange[] = [];
    const provider = createOandaXauUsdMarketDataProvider(read.config, {
      transport: async (exchange) => {
        calls.push(exchange);
        return {
          status: 200,
          body: JSON.stringify({
            instrument: "XAU_USD",
            granularity: "M1",
            candles: [{
              complete: true,
              volume: 1840,
              time: OPEN,
              mid: { o: "2320.50", h: "2328.20", l: "2316.40", c: "2324.10" },
            }],
          }),
        };
      },
    });
    const chart = await readDeskChartCandles({ provider, now: NOW, timeframe: "M1" });
    const model = adaptXauUsdChart({
      symbol: "XAUUSD",
      provenance: chart.provenance,
      candles: chart.candles,
    });
    const desk = { ...projectDesk({ events: [] }), chart };
    expect(chart.provenance).toBe("LIVE");
    expect(chart.timeframe).toBe("M1");
    expect(chart.candles).toEqual([{
      timeframe: "M1",
      time: OPEN,
      open: Number("2320.50"),
      high: Number("2328.20"),
      low: Number("2316.40"),
      close: Number("2324.10"),
      volume: 1840,
    }]);
    expect(model.engine).toBe("klinechart-pro");
    expect(model.symbol?.ticker).toBe("XAUUSD");
    expect(model.period?.text).toBe("M1");
    expect(model.labeledLive).toBe(true);
    expect(model.status).toBe("ready");
    expect(model.candles).toEqual([{
      timestamp: Date.parse(OPEN),
      open: Number("2320.50"),
      high: Number("2328.20"),
      low: Number("2316.40"),
      close: Number("2324.10"),
      volume: 1840,
    }]);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe(`/v3/accounts/${ACCOUNT}/instruments/XAU_USD/candles`);
    expect(calls[0]!.url).not.toMatch(/orders|positions|trades/);
    const published = JSON.stringify({ desk, model });
    expect(published).not.toContain(TOKEN);
    expect(published).not.toContain(ACCOUNT);
    expect(published).not.toContain("api-fxtrade.oanda.com");
    expect(published).not.toContain("Authorization");
    expect(published).not.toMatch(/SIMULATOR|REPLAY/);
  });
});
