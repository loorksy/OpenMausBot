import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { XauUsdTimeframe } from "../../../../shared/trading/snapshot.ts";
import { readDeskChartCandles } from "../../desk/market.ts";
import { XAUUSD_ENVIRONMENT_ENV } from "../../jobs/mount.ts";
import {
  installXauUsdMarketDataProvider,
  readInstalledXauUsdMarketDataProvider,
} from "../../occurrence/runtime.ts";
import type { MarketRequest } from "./model.ts";
import {
  OANDA_ACCOUNT_ID_ENV,
  OANDA_API_TOKEN_ENV,
  OANDA_ENVIRONMENT_ENV,
  createOandaXauUsdMarketDataProvider,
  installConfiguredOandaProvider,
  readOandaMarketConfig,
  type OandaHttpExchange,
  type OandaMarketConfig,
  type OandaTransport,
} from "./oanda.ts";
import { readXauUsdCandles, readXauUsdQuote } from "./read.ts";

const TOKEN = "fixture-oanda-token-0123456789";
const ACCOUNT = "001-001-1234567-001";
const NOW = "2026-10-01T12:00:00.000Z";
const FRESH = "2026-10-01T11:59:30.000Z";
const STALE = "2026-10-01T11:58:00.000Z";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

afterEach(() => {
  installXauUsdMarketDataProvider(null);
  vi.restoreAllMocks();
});

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    [OANDA_API_TOKEN_ENV]: TOKEN,
    [OANDA_ACCOUNT_ID_ENV]: ACCOUNT,
    [OANDA_ENVIRONMENT_ENV]: "live",
    [XAUUSD_ENVIRONMENT_ENV]: "LIVE",
    ...overrides,
  };
}

function configFrom(record: Record<string, string | undefined> = env()): OandaMarketConfig {
  const read = readOandaMarketConfig(record);
  if (!read.ok) throw new Error(read.reason);
  return read.config;
}

function request(receivedAt = NOW): MarketRequest {
  let n = 0;
  return {
    agentRunId: "run-1",
    correlationId: "corr-1",
    versionManifestId: "ver-1",
    clock: {
      receivedAt,
      processedAt: receivedAt,
      limits: { staleAfterMs: 60_000, futureSkewMs: 2_000, abnormalLatencyMs: 5_000 },
    },
    nextEventId: () => `evt-${++n}`,
  };
}

function quotePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    prices: [{
      instrument: "XAU_USD",
      time: FRESH,
      status: "tradeable",
      bids: [{ price: "2320.50", liquidity: 100 }],
      asks: [{ price: "2321.20", liquidity: 100 }],
      closeoutBid: "2310.00",
      closeoutAsk: "2330.00",
      ...overrides,
    }],
  });
}

function candle(time: string, overrides: Record<string, unknown> = {}) {
  return {
    complete: true,
    volume: 12,
    time,
    mid: { o: "2320.50", h: "2328.20", l: "2316.40", c: "2324.10" },
    ...overrides,
  };
}

function candlePayload(candles: readonly unknown[], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    instrument: "XAU_USD",
    granularity: "M1",
    candles,
    ...overrides,
  });
}

function transportOf(status: number, body: string, calls: OandaHttpExchange[] = []): OandaTransport {
  return async (exchange) => {
    calls.push(exchange);
    return { status, body };
  };
}

function hidden(value: unknown): void {
  const text = JSON.stringify(value);
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(ACCOUNT);
  expect(text).not.toMatch(/bearer\s+\S+/i);
  expect(text).not.toContain("api-fxtrade.oanda.com");
  expect(text).not.toContain("api-fxpractice.oanda.com");
}

describe("OANDA configuration", () => {
  it("accepts an explicit live configuration", () => {
    const read = readOandaMarketConfig(env({ [OANDA_ENVIRONMENT_ENV]: "live", [XAUUSD_ENVIRONMENT_ENV]: "LIVE" }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.config.environment).toBe("live");
    expect(read.config.tradingEnvironment).toBe("LIVE");
    expect(read.config.providerId).toBe("oanda-live");
    expect(read.config.origin).toBe("https://api-fxtrade.oanda.com");
    expect(read.config.accountId).toBe(ACCOUNT);
  });

  it("accepts an explicit practice configuration", () => {
    const read = readOandaMarketConfig(env({ [OANDA_ENVIRONMENT_ENV]: "practice", [XAUUSD_ENVIRONMENT_ENV]: "PAPER" }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.config.environment).toBe("practice");
    expect(read.config.tradingEnvironment).toBe("PAPER");
    expect(read.config.providerId).toBe("oanda-practice");
    expect(read.config.origin).toBe("https://api-fxpractice.oanda.com");
  });

  it.each([
    ["missing_token", { [OANDA_API_TOKEN_ENV]: "" }],
    ["missing_account", { [OANDA_ACCOUNT_ID_ENV]: "" }],
    ["missing_environment", { [OANDA_ENVIRONMENT_ENV]: "" }],
    ["invalid_environment", { [OANDA_ENVIRONMENT_ENV]: "demo" }],
    ["invalid_account", { [OANDA_ACCOUNT_ID_ENV]: "001/001" }],
    ["invalid_token", { [OANDA_API_TOKEN_ENV]: "short token" }],
    ["environment_mismatch", { [XAUUSD_ENVIRONMENT_ENV]: "SIMULATOR" }],
  ] as const)("rejects %s without installing a provider", (reason, overrides) => {
    const read = readOandaMarketConfig(env(overrides));
    expect(read).toEqual({ ok: false, reason });
    hidden(read);
    expect(installConfiguredOandaProvider(env(overrides))).toBe(false);
    expect(readInstalledXauUsdMarketDataProvider()).toBeNull();
  });

  it("rejects every environment pairing except practice/PAPER and live/LIVE", () => {
    const rejected = [
      env({ [OANDA_ENVIRONMENT_ENV]: "practice", [XAUUSD_ENVIRONMENT_ENV]: "LIVE" }),
      env({ [OANDA_ENVIRONMENT_ENV]: "live", [XAUUSD_ENVIRONMENT_ENV]: "PAPER" }),
      env({ [XAUUSD_ENVIRONMENT_ENV]: "paper" }),
      env({ [XAUUSD_ENVIRONMENT_ENV]: "" }),
    ];
    for (const record of rejected) {
      expect(readOandaMarketConfig(record)).toEqual({ ok: false, reason: "environment_mismatch" });
      expect(installConfiguredOandaProvider(record)).toBe(false);
    }
    const missing = env();
    delete missing[XAUUSD_ENVIRONMENT_ENV];
    expect(readOandaMarketConfig(missing)).toEqual({ ok: false, reason: "environment_mismatch" });
    expect(readInstalledXauUsdMarketDataProvider()).toBeNull();
  });

  it("stays unconfigured when every OANDA variable is absent", () => {
    expect(readOandaMarketConfig({})).toEqual({ ok: false, reason: "unconfigured" });
    expect(installConfiguredOandaProvider({})).toBe(false);
  });

  it("does not replace an installed provider when configuration is partial", () => {
    const installed = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: async () => { throw new Error("not called"); },
    });
    installXauUsdMarketDataProvider(installed);
    expect(installConfiguredOandaProvider(env({ [OANDA_API_TOKEN_ENV]: "" }))).toBe(false);
    expect(readInstalledXauUsdMarketDataProvider()).toBe(installed);
  });

  it("does not infer the host from the account id", async () => {
    const calls: OandaHttpExchange[] = [];
    const provider = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(404, "{}", calls),
    });
    await provider.getXauUsdQuote();
    expect(calls[0]?.url.startsWith("https://api-fxtrade.oanda.com/v3/accounts/")).toBe(true);
    expect(calls[0]?.url).not.toContain("api-fxpractice");
  });
});

describe("OANDA pricing", () => {
  it("returns top-of-book bid and ask as decimal strings", async () => {
    const calls: OandaHttpExchange[] = [];
    const provider = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(200, quotePayload(), calls),
    });
    const result = await provider.getXauUsdQuote();
    expect(result).toMatchObject({
      ok: true,
      instrument: "XAUUSD",
      provenance: "LIVE",
      providerTimestamp: FRESH,
      quote: { bid: "2320.50", ask: "2321.20" },
    });
    expect(result.ok && result.quote && "spread" in result.quote).toBe(false);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`/v3/accounts/${ACCOUNT}/pricing`);
    expect(url.searchParams.get("instruments")).toBe("XAU_USD");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.headers["Accept-Datetime-Format"]).toBe("RFC3339");
    expect(calls[0]?.url).not.toContain(TOKEN);
    hidden(result);
  });

  it("keeps a nine-digit OANDA timestamp and rejects a longer fraction", async () => {
    const nanos = "2026-10-01T11:59:30.123456789Z";
    const provider = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(200, quotePayload({ time: nanos })),
    });
    const result = await provider.getXauUsdQuote();
    expect(result).toMatchObject({ ok: true, providerTimestamp: nanos });
    const rejected = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(200, quotePayload({ time: "2026-10-01T11:59:30.1234567890Z" })),
    });
    expect(await rejected.getXauUsdQuote()).toMatchObject({
      ok: false,
      failure: "malformed_response",
      message: "OANDA timestamp is malformed",
    });
    const invalid = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(200, quotePayload({ time: "yesterday" })),
    });
    expect(await invalid.getXauUsdQuote()).toMatchObject({
      ok: false,
      failure: "malformed_response",
      message: "OANDA timestamp is malformed",
    });
  });

  it("fails closed for a missing or non-tradeable instrument", async () => {
    const missing = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(200, JSON.stringify({ prices: [] })),
    });
    expect(await missing.getXauUsdQuote()).toMatchObject({ ok: false, failure: "unavailable" });
    const foreign = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(200, quotePayload({ instrument: "EUR_USD" })),
    });
    expect(await foreign.getXauUsdQuote()).toMatchObject({ ok: false, failure: "unavailable" });
    const halted = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(200, quotePayload({ status: "non-tradeable" })),
    });
    const haltedResult = await halted.getXauUsdQuote();
    expect(haltedResult).toMatchObject({ ok: false, failure: "unavailable" });
    expect(JSON.stringify(haltedResult)).not.toContain("2330.00");
  });

  it("rejects malformed bid or ask without using closeout prices", async () => {
    const provider = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(200, quotePayload({ bids: [], asks: [{ price: "2321.20" }] })),
    });
    const result = await provider.getXauUsdQuote();
    expect(result).toMatchObject({ ok: false, failure: "malformed_response", message: "OANDA quote is malformed" });
    expect(JSON.stringify(result)).not.toContain("2310.00");
    const numeric = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(200, quotePayload({ bids: [{ price: 2320.5 }] })),
    });
    expect(await numeric.getXauUsdQuote()).toMatchObject({ ok: false, failure: "malformed_response" });
  });

  it("labels a fresh quote LIVE and an old quote STALE through the read layer", async () => {
    const fresh = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(200, quotePayload()),
    });
    const live = await readXauUsdQuote(fresh, request());
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    expect(live.data.provenance).toBe("LIVE");
    expect(live.data.freshness).toBe("fresh");
    expect(live.data.bid).toBe(Number("2320.50"));
    expect(live.data.ask).toBe(Number("2321.20"));
    expect(live.events[0]?.type).toBe("market.quote.updated");
    hidden(live);

    const staleProvider = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(200, quotePayload({ time: STALE })),
    });
    const stale = await readXauUsdQuote(staleProvider, request());
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.data.provenance).toBe("STALE");
    expect(stale.data.providerTimestamp).toBe(STALE);
    expect(stale.events[0]?.type).toBe("market.stale");
    hidden(stale);
  });
});

describe("OANDA candles", () => {
  it.each([
    ["M1", "M1"],
    ["M5", "M5"],
    ["M15", "M15"],
    ["M30", "M30"],
    ["H1", "H1"],
    ["H4", "H4"],
    ["D1", "D"],
  ] as const)("maps %s to OANDA granularity %s", async (timeframe, granularity) => {
    const calls: OandaHttpExchange[] = [];
    const open = "2026-10-01T11:00:00.000Z";
    const provider = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: async (exchange) => {
        calls.push(exchange);
        return { status: 200, body: candlePayload([candle(open)], { granularity }) };
      },
    });
    const result = await provider.getXauUsdCandles(timeframe, {
      from: open,
      to: "2026-10-01T12:00:00.000Z",
    });
    expect(result).toMatchObject({
      ok: true,
      instrument: "XAUUSD",
      provenance: "LIVE",
      providerTimestamp: open,
    });
    if (!result.ok || !result.candles) return;
    expect(result.candles[0]).toMatchObject({
      timeframe,
      time: open,
      open: "2320.50",
      high: "2328.20",
      low: "2316.40",
      close: "2324.10",
      volume: 12,
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`/v3/accounts/${ACCOUNT}/instruments/XAU_USD/candles`);
    expect(url.searchParams.get("price")).toBe("M");
    expect(url.searchParams.get("granularity")).toBe(granularity);
    expect(url.searchParams.get("count")).toBeNull();
    expect(url.searchParams.has("smooth")).toBe(false);
    expect(calls[0]?.url).not.toContain(TOKEN);
  });

  it("excludes incomplete candles and rejects a missing complete flag", async () => {
    const open = "2026-10-01T11:00:00.000Z";
    const provider = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(200, candlePayload([
        candle(open),
        candle("2026-10-01T11:01:00.000Z", { complete: false, mid: { o: "1.00", h: "1.00", l: "1.00", c: "9.00" } }),
      ])),
    });
    const result = await provider.getXauUsdCandles("M1", { from: open, to: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.candles) return;
    expect(result.candles).toHaveLength(1);
    expect(result.candles[0]?.time).toBe(open);
    expect(JSON.stringify(result)).not.toContain("9.00");

    const missing = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(200, candlePayload([candle(open, { complete: undefined })])),
    });
    expect(await missing.getXauUsdCandles("M1", { from: open, to: NOW })).toMatchObject({
      ok: false,
      failure: "malformed_response",
      message: "OANDA candle is malformed",
    });
    const onlyForming = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(200, candlePayload([candle(open, { complete: false })])),
    });
    expect(await onlyForming.getXauUsdCandles("M1", { from: open, to: NOW })).toMatchObject({
      ok: false,
      failure: "unavailable",
    });
  });

  it("does not relabel bid candles as midpoint", async () => {
    const open = "2026-10-01T11:00:00.000Z";
    const provider = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(200, candlePayload([
        candle(open, { mid: undefined, bid: { o: "2320.50", h: "2328.20", l: "2316.40", c: "2324.10" } }),
      ])),
    });
    expect(await provider.getXauUsdCandles("M1", { from: open, to: NOW })).toMatchObject({
      ok: false,
      failure: "malformed_response",
      message: "OANDA candle OHLC is malformed",
    });
  });

  it("rejects impossible OHLC, duplicates, and out-of-order bars", async () => {
    const open = "2026-10-01T11:00:00.000Z";
    const later = "2026-10-01T11:01:00.000Z";
    const bad = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(200, candlePayload([
        candle(open, { mid: { o: "2320.50", h: "2310.00", l: "2316.40", c: "2324.10" } }),
      ])),
    });
    expect(await bad.getXauUsdCandles("M1", { from: open, to: NOW })).toMatchObject({
      ok: false,
      failure: "malformed_response",
      message: "OANDA candle OHLC is malformed",
    });
    const duplicate = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(200, candlePayload([candle(open), candle(open)])),
    });
    expect(await duplicate.getXauUsdCandles("M1", { from: open, to: NOW })).toMatchObject({
      message: "OANDA candles contain a duplicate timestamp",
    });
    const reversed = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(200, candlePayload([candle(later), candle(open)])),
    });
    expect(await reversed.getXauUsdCandles("M1", { from: open, to: NOW })).toMatchObject({
      message: "OANDA candles are out of order",
    });
  });

  it("compares OHLC as decimal strings", async () => {
    const open = "2026-10-01T11:00:00.000Z";
    const provider = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(200, candlePayload([
        candle(open, { mid: { o: "1.00", h: "9999999999999999999.8", l: "1.00", c: "9999999999999999999.9" } }),
      ])),
    });
    expect(await provider.getXauUsdCandles("M1", { from: open, to: NOW })).toMatchObject({
      ok: false,
      failure: "malformed_response",
    });
  });

  it("rejects a foreign instrument and an unsupported timeframe without substituting", async () => {
    const calls: OandaHttpExchange[] = [];
    const provider = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: async (exchange) => {
        calls.push(exchange);
        return { status: 200, body: candlePayload([candle("2026-10-01T11:00:00.000Z")], { instrument: "EUR_USD" }) };
      },
    });
    expect(await provider.getXauUsdCandles("M1", { from: "2026-10-01T11:00:00.000Z", to: NOW })).toMatchObject({
      ok: false,
      failure: "unavailable",
    });
    calls.length = 0;
    expect(await provider.getXauUsdCandles("W1" as XauUsdTimeframe, { from: "2026-10-01T11:00:00.000Z", to: NOW })).toMatchObject({
      ok: false,
      message: "OANDA timeframe is unsupported",
    });
    expect(calls).toHaveLength(0);
  });

  it("paginates a full page and fails closed when the cursor does not advance", async () => {
    const first = "2026-10-01T11:00:00.000Z";
    const second = "2026-10-01T11:01:00.000Z";
    const third = "2026-10-01T11:02:00.000Z";
    const calls: string[] = [];
    const provider = createOandaXauUsdMarketDataProvider(configFrom(), {
      pageSize: 2,
      transport: async (exchange) => {
        calls.push(exchange.url);
        const includeFirst = new URL(exchange.url).searchParams.get("includeFirst");
        const body = includeFirst === "true"
          ? candlePayload([candle(first), candle(second)])
          : candlePayload([candle(third)]);
        return { status: 200, body };
      },
    });
    const result = await provider.getXauUsdCandles("M1", { from: first, to: "2026-10-01T11:03:00.000Z" });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.candles) return;
    expect(result.candles.map((bar) => bar.time)).toEqual([first, second, third]);
    expect(new URL(calls[1]!).searchParams.get("includeFirst")).toBe("false");
    expect(new URL(calls[1]!).searchParams.get("from")).toBe(second);

    const stuck = createOandaXauUsdMarketDataProvider(configFrom(), {
      pageSize: 1,
      transport: async () => ({ status: 200, body: candlePayload([candle(first)]) }),
    });
    const failed = await stuck.getXauUsdCandles("M1", { from: first, to: "2026-10-01T11:03:00.000Z" });
    expect(failed).toMatchObject({ ok: false, failure: "unavailable", message: "OANDA candle page did not advance" });
    expect(JSON.stringify(failed)).not.toContain("2320.50");
  });

  it("does not return a partial page when the range still exceeds the page cap", async () => {
    const provider = createOandaXauUsdMarketDataProvider(configFrom(), {
      pageSize: 1,
      maxPages: 1,
      transport: async () => ({ status: 200, body: candlePayload([candle("2026-10-01T11:01:00.000Z")]) }),
    });
    const result = await provider.getXauUsdCandles("M1", {
      from: "2026-10-01T11:00:00.000Z",
      to: "2026-10-01T11:05:00.000Z",
    });
    expect(result).toMatchObject({ ok: false, message: "OANDA candle range exceeds the read limit" });
    expect(JSON.stringify(result)).not.toContain("2320.50");
  });
});

describe("OANDA failures", () => {
  it.each([
    [401, "authentication_failure", "OANDA authentication failed"],
    [403, "authentication_failure", "OANDA authentication failed"],
    [404, "unavailable", "OANDA instrument unavailable"],
    [429, "rate_limit", "OANDA rate limit"],
    [500, "unavailable", "OANDA request failed"],
    [503, "unavailable", "OANDA request failed"],
  ] as const)("maps HTTP %s to %s", async (status, failure, message) => {
    const provider = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(status, JSON.stringify({ errorMessage: TOKEN, account: ACCOUNT })),
    });
    const result = await provider.getXauUsdQuote();
    expect(result).toEqual({ ok: false, failure, message });
    hidden(result);
    const read = await readXauUsdQuote(provider, request());
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.provenance).toBe("UNAVAILABLE");
    expect(read.provenance).not.toBe("SIMULATOR");
    hidden(read);
  });

  it("maps timeout, connection failure, and malformed JSON without copying the cause", async () => {
    const logs: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map((arg) => String(arg)).join(" "));
      });
    }
    const timeout = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: async () => {
        throw Object.assign(new Error(`timed out ${TOKEN} ${ACCOUNT}`), { name: "TimeoutError" });
      },
    });
    const timed = await readXauUsdQuote(timeout, request());
    expect(timed).toMatchObject({ ok: false, failure: "timeout", provenance: "UNAVAILABLE" });
    hidden(timed);

    const disconnected = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: async () => {
        throw new Error(`connect ${TOKEN} https://api-fxtrade.oanda.com/v3/accounts/${ACCOUNT}`);
      },
    });
    const failed = await disconnected.getXauUsdCandles("M1", { from: STALE, to: NOW });
    expect(failed).toEqual({ ok: false, failure: "network_failure", message: "OANDA request failed" });
    hidden(failed);

    const malformed = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: transportOf(200, `{"token":"${TOKEN}"`),
    });
    const broken = await malformed.getXauUsdQuote();
    expect(broken).toEqual({ ok: false, failure: "malformed_response", message: "OANDA response is malformed" });
    hidden(broken);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it("continues to reject unmapped timeframes before any HTTP call", async () => {
    const calls: OandaHttpExchange[] = [];
    const provider = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: async (exchange) => {
        calls.push(exchange);
        const granularity = new URL(exchange.url).searchParams.get("granularity");
        return { status: 200, body: candlePayload([candle("2026-10-01T11:00:00.000Z")], { granularity }) };
      },
    });
    for (const timeframe of ["W1", "H2", "M10", "1D"]) {
      const result = await readXauUsdCandles(provider, timeframe, { from: "2026-10-01T11:00:00.000Z", to: NOW }, request());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.provenance).toBe("UNAVAILABLE");
    }
    expect(calls).toHaveLength(0);
    const alias = await readXauUsdCandles(provider, "15m", { from: "2026-10-01T11:00:00.000Z", to: NOW }, request());
    expect(alias.ok).toBe(true);
    if (!alias.ok) return;
    expect(alias.data.timeframe).toBe("M15");
    expect(new URL(calls[0]!.url).searchParams.get("granularity")).toBe("M15");
  });
});

describe("OANDA credential boundary", () => {
  it("keeps the token out of the provider object and uses the default fetch failure path", async () => {
    const provider = createOandaXauUsdMarketDataProvider(configFrom());
    expect(Object.keys(provider).sort()).toEqual([
      "environment",
      "getXauUsdCandles",
      "getXauUsdQuote",
      "providerId",
      "successProvenance",
    ]);
    expect(provider.successProvenance).toBe("LIVE");
    hidden(provider);
    const original = globalThis.fetch;
    let init: RequestInit | undefined;
    globalThis.fetch = async (_url, options) => {
      init = options;
      return new Response(JSON.stringify({ errorMessage: TOKEN, accountID: ACCOUNT }), { status: 401 });
    };
    try {
      const result = await provider.getXauUsdQuote();
      expect(result).toEqual({ ok: false, failure: "authentication_failure", message: "OANDA authentication failed" });
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
      hidden(result);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not put OANDA hosts or credentials in the desk client", () => {
    const source = [
      "src/components/TradingDesk.tsx",
      "src/components/XauUsdChart.tsx",
      "src/trading/kline-adapter.ts",
    ].map((path) => readFileSync(join(ROOT, path), "utf8")).join("\n");
    expect(source).not.toMatch(/oanda|api-fxtrade|api-fxpractice|OMB_OANDA|Authorization/i);
  });

  it("does not call a provider that is missing or not a live feed", async () => {
    expect(await readDeskChartCandles({ provider: null, now: NOW })).toEqual({
      provenance: "UNAVAILABLE",
      timeframe: null,
      candles: [],
    });
    let calls = 0;
    const simulator = createOandaXauUsdMarketDataProvider(configFrom(), {
      transport: async () => {
        calls += 1;
        return { status: 200, body: quotePayload() };
      },
    });
    const relabeled = { ...simulator, successProvenance: "SIMULATOR" as const, environment: "SIMULATOR" as const };
    expect((await readDeskChartCandles({ provider: relabeled, now: NOW })).provenance).toBe("UNAVAILABLE");
    expect(calls).toBe(0);
  });
});
