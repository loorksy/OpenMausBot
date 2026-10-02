import type { TradingEnvironment, XauUsdTimeframe } from "../../../../shared/trading/index.ts";
import { XAUUSD_TIMEFRAMES } from "../../../../shared/trading/snapshot.ts";
import { XAUUSD_ENVIRONMENT_ENV } from "../../jobs/mount.ts";
import { installXauUsdMarketDataProvider } from "../../occurrence/runtime.ts";
import { canonicalizeUtc } from "./clock.ts";
import { MarketDataProviderError, type RawProviderResult } from "./model.ts";
import type { CandleRange, XauUsdMarketDataProvider } from "./provider.ts";

/**
 * OANDA v20 REST adapter for the existing `XauUsdMarketDataProvider`.
 *
 * Market data only. This module does not place, modify, or close orders and
 * it does not read MetaApi, the trading store, or a scheduler.
 *
 * Contract mismatches, left unchanged:
 * - `XauUsdCandle` is one OHLC series and has no bid/ask/mid field. This
 *   adapter requests OANDA `price=M` and reads only `mid`. Bid and ask candle
 *   objects are never relabeled as midpoint. A missing `mid` fails the payload.
 * - The canonical candle has no `complete` flag. OANDA `complete: false` bars
 *   are excluded. A missing or non-boolean `complete` fails the payload.
 *   Incomplete bars are not returned as completed history.
 * - The canonical quote has bid, ask, and a timestamp. It has no market-status
 *   field. A price whose OANDA status is not `tradeable` is UNAVAILABLE.
 * - Daily bars use OANDA granularity `D` and OANDA's default alignment.
 *   Returned timestamps stay UTC. This adapter does not send an alignment.
 * - The canonical OHLC fields are finite numbers. Decimal strings are passed
 *   through to the existing validator, which is the only numeric coercion.
 */

export const OANDA_API_TOKEN_ENV = "OMB_OANDA_API_TOKEN";
export const OANDA_ACCOUNT_ID_ENV = "OMB_OANDA_ACCOUNT_ID";
export const OANDA_ENVIRONMENT_ENV = "OMB_OANDA_ENVIRONMENT";

export const OANDA_ENVIRONMENTS = ["practice", "live"] as const;
export type OandaEnvironmentName = (typeof OANDA_ENVIRONMENTS)[number];

export const OANDA_CONFIG_REASONS = [
  "unconfigured",
  "missing_token",
  "missing_account",
  "missing_environment",
  "invalid_environment",
  "invalid_account",
  "invalid_token",
  "environment_mismatch",
] as const;
export type OandaConfigReason = (typeof OANDA_CONFIG_REASONS)[number];

/** Official REST hosts. The host is never taken from the environment. */
const OANDA_ORIGIN: Readonly<Record<OandaEnvironmentName, string>> = {
  practice: "https://api-fxpractice.oanda.com",
  live: "https://api-fxtrade.oanda.com",
};

const TRADING_ENVIRONMENT: Readonly<Record<OandaEnvironmentName, "PAPER" | "LIVE">> = {
  practice: "PAPER",
  live: "LIVE",
};

const PROVIDER_ID: Readonly<Record<OandaEnvironmentName, "oanda-practice" | "oanda-live">> = {
  practice: "oanda-practice",
  live: "oanda-live",
};

/** OANDA spot gold. The canonical instrument remains XAUUSD. */
const OANDA_INSTRUMENT = "XAU_USD";

const OANDA_GRANULARITY: Readonly<Record<XauUsdTimeframe, string>> = {
  M1: "M1",
  M5: "M5",
  M15: "M15",
  M30: "M30",
  H1: "H1",
  H4: "H4",
  D1: "D",
};

/** OANDA returns at most 5000 candles when both `from` and `to` are set. */
const OANDA_MAX_PAGE_SIZE = 5000;
const DEFAULT_MAX_PAGES = 4;
const REQUEST_TIMEOUT_MS = 10_000;

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export interface OandaMarketConfig {
  readonly environment: OandaEnvironmentName;
  readonly tradingEnvironment: "PAPER" | "LIVE";
  readonly providerId: "oanda-practice" | "oanda-live";
  readonly origin: string;
  readonly accountId: string;
  readonly token: string;
}

export type OandaMarketConfigResult =
  | { readonly ok: true; readonly config: OandaMarketConfig }
  | { readonly ok: false; readonly reason: OandaConfigReason };

export interface OandaHttpExchange {
  readonly url: string;
  readonly method: "GET";
  readonly headers: Readonly<Record<string, string>>;
}

export interface OandaHttpResult {
  readonly status: number;
  readonly body: string;
}

export type OandaTransport = (exchange: OandaHttpExchange) => Promise<OandaHttpResult>;

export interface OandaProviderOptions {
  readonly transport?: OandaTransport;
  /** Test seam. Production uses OANDA's 5000-candle page maximum. */
  readonly pageSize?: number;
  /** Test seam. Production reads at most four pages per call, then fails closed. */
  readonly maxPages?: number;
}

type OandaFailure = Extract<RawProviderResult, { ok: false }>;

interface MappedCandle {
  readonly time: string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume?: number;
}

interface CandlePage {
  readonly complete: readonly MappedCandle[];
  readonly rawCount: number;
  readonly lastTime: string | null;
}

export function readOandaMarketConfig(
  env: Readonly<Record<string, string | undefined>>,
): OandaMarketConfigResult {
  const token = env[OANDA_API_TOKEN_ENV];
  const accountId = env[OANDA_ACCOUNT_ID_ENV];
  const environment = env[OANDA_ENVIRONMENT_ENV];
  if (token === undefined && accountId === undefined && environment === undefined) {
    return { ok: false, reason: "unconfigured" };
  }
  if (token === undefined || token === "") return { ok: false, reason: "missing_token" };
  if (accountId === undefined || accountId === "") return { ok: false, reason: "missing_account" };
  if (environment === undefined || environment === "") return { ok: false, reason: "missing_environment" };
  if (!isOandaEnvironment(environment)) return { ok: false, reason: "invalid_environment" };
  if (!ACCOUNT_ID_PATTERN.test(accountId)) return { ok: false, reason: "invalid_account" };
  if (!isAcceptableToken(token)) return { ok: false, reason: "invalid_token" };
  const tradingEnvironment = TRADING_ENVIRONMENT[environment];
  const tradingSlot = env[XAUUSD_ENVIRONMENT_ENV];
  if (tradingSlot !== undefined && tradingSlot !== "" && tradingSlot !== tradingEnvironment) {
    return { ok: false, reason: "environment_mismatch" };
  }
  return {
    ok: true,
    config: {
      environment,
      tradingEnvironment,
      providerId: PROVIDER_ID[environment],
      origin: OANDA_ORIGIN[environment],
      accountId,
      token,
    },
  };
}

export function createOandaXauUsdMarketDataProvider(
  config: OandaMarketConfig,
  options: OandaProviderOptions = {},
): XauUsdMarketDataProvider {
  const transport = options.transport ?? fetchOanda;
  const pageSize = resolvePageSize(options.pageSize);
  const maxPages = resolveMaxPages(options.maxPages);
  const environment: TradingEnvironment = config.tradingEnvironment;

  const request = async (
    url: string,
  ): Promise<OandaFailure | { readonly json: unknown }> => {
    let response: OandaHttpResult;
    try {
      response = await transport({
        url,
        method: "GET",
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: "application/json",
          "Accept-Datetime-Format": "RFC3339",
        },
      });
    } catch (error) {
      return transportFailure(error);
    }
    if (response.status !== 200) return httpFailure(response.status);
    try {
      return { json: JSON.parse(response.body) as unknown };
    } catch {
      return { ok: false, failure: "malformed_response", message: "OANDA response is malformed" };
    }
  };

  return {
    providerId: config.providerId,
    environment,
    successProvenance: "LIVE",
    async getXauUsdQuote() {
      try {
        const called = await request(pricingUrl(config));
        if ("ok" in called) return called;
        return parseQuote(called.json);
      } catch {
        return { ok: false, failure: "unavailable", message: "OANDA request failed" };
      }
    },
    async getXauUsdCandles(timeframe, range) {
      try {
        return await readCandles(config, pageSize, maxPages, timeframe, range, request);
      } catch {
        return { ok: false, failure: "unavailable", message: "OANDA request failed" };
      }
    },
  };
}

/** Installs the provider only when practice or live configuration is complete.
 * A partial or mismatched configuration leaves the current slot untouched. */
export function installConfiguredOandaProvider(
  env: Readonly<Record<string, string | undefined>>,
  options: OandaProviderOptions = {},
): boolean {
  const read = readOandaMarketConfig(env);
  if (!read.ok) return false;
  installXauUsdMarketDataProvider(createOandaXauUsdMarketDataProvider(read.config, options));
  return true;
}

async function fetchOanda(exchange: OandaHttpExchange): Promise<OandaHttpResult> {
  try {
    const response = await fetch(exchange.url, {
      method: "GET",
      headers: exchange.headers,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new MarketDataProviderError("timeout", "OANDA request timed out");
    }
    throw new MarketDataProviderError("network_failure", "OANDA request failed");
  }
}

async function readCandles(
  config: OandaMarketConfig,
  pageSize: number,
  maxPages: number,
  timeframe: XauUsdTimeframe,
  range: CandleRange,
  request: (url: string) => Promise<OandaFailure | { readonly json: unknown }>,
): Promise<RawProviderResult> {
  if (!isCanonicalTimeframe(timeframe)) {
    return { ok: false, failure: "malformed_response", message: "OANDA timeframe is unsupported" };
  }
  const from = utcInstant(range.from);
  const to = utcInstant(range.to);
  if (from === null || to === null || Date.parse(from) >= Date.parse(to)) {
    return { ok: false, failure: "malformed_response", message: "OANDA candle range is invalid" };
  }
  const granularity = OANDA_GRANULARITY[timeframe];
  const kept: MappedCandle[] = [];
  let cursor = from;
  let includeFirst = true;
  for (let page = 1; page <= maxPages; page += 1) {
    const called = await request(candleUrl(config, granularity, cursor, to, includeFirst));
    if ("ok" in called) return called;
    const parsed = parseCandlePage(called.json, granularity);
    if (!parsed.ok) return parsed;
    for (const candle of parsed.page.complete) {
      const openMs = Date.parse(candle.time);
      const previous = kept.length > 0 ? Date.parse(kept[kept.length - 1]!.time) : Number.NEGATIVE_INFINITY;
      if (openMs === previous) {
        return { ok: false, failure: "malformed_response", message: "OANDA candles contain a duplicate timestamp" };
      }
      if (openMs < previous) {
        return { ok: false, failure: "malformed_response", message: "OANDA candles are out of order" };
      }
      kept.push(candle);
    }
    if (parsed.page.rawCount < pageSize) break;
    if (parsed.page.lastTime === null) {
      return { ok: false, failure: "malformed_response", message: "OANDA response is malformed" };
    }
    const lastMs = Date.parse(parsed.page.lastTime);
    if (lastMs >= Date.parse(to)) break;
    if (lastMs <= Date.parse(cursor)) {
      return { ok: false, failure: "unavailable", message: "OANDA candle page did not advance" };
    }
    if (page === maxPages) {
      return { ok: false, failure: "unavailable", message: "OANDA candle range exceeds the read limit" };
    }
    cursor = parsed.page.lastTime;
    includeFirst = false;
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const windowed = kept.filter((candle) => {
    const openMs = Date.parse(candle.time);
    return openMs >= fromMs && openMs < toMs;
  });
  if (windowed.length === 0) {
    return { ok: false, failure: "unavailable", message: "OANDA returned no completed XAUUSD candles" };
  }
  const latest = windowed[windowed.length - 1]!;
  return {
    ok: true,
    providerTimestamp: latest.time,
    provenance: "LIVE",
    instrument: "XAUUSD",
    candles: windowed.map((candle) => ({
      timeframe,
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      ...(candle.volume === undefined ? {} : { volume: candle.volume }),
    })),
  };
}

function parseQuote(body: unknown): RawProviderResult {
  if (!isRecord(body) || !Array.isArray(body.prices)) {
    return { ok: false, failure: "malformed_response", message: "OANDA response is malformed" };
  }
  const matches = body.prices.filter((price) => isRecord(price) && price.instrument === OANDA_INSTRUMENT);
  if (matches.length === 0) {
    return { ok: false, failure: "unavailable", message: "OANDA instrument unavailable" };
  }
  if (matches.length !== 1) {
    return { ok: false, failure: "malformed_response", message: "OANDA response is malformed" };
  }
  const price = matches[0]!;
  if (!isRecord(price) || price.status !== "tradeable") {
    return { ok: false, failure: "unavailable", message: "OANDA instrument unavailable" };
  }
  const time = utcInstant(price.time);
  if (time === null) {
    return { ok: false, failure: "malformed_response", message: "OANDA timestamp is malformed" };
  }
  const bid = topPrice(price.bids);
  const ask = topPrice(price.asks);
  if (bid === null || ask === null || compareDecimal(bid, ask) > 0) {
    return { ok: false, failure: "malformed_response", message: "OANDA quote is malformed" };
  }
  return {
    ok: true,
    providerTimestamp: time,
    provenance: "LIVE",
    instrument: "XAUUSD",
    quote: { bid, ask },
  };
}

function parseCandlePage(
  body: unknown,
  granularity: string,
): { readonly ok: true; readonly page: CandlePage } | OandaFailure {
  if (!isRecord(body) || !Array.isArray(body.candles)) {
    return { ok: false, failure: "malformed_response", message: "OANDA response is malformed" };
  }
  if (body.instrument !== OANDA_INSTRUMENT) {
    return { ok: false, failure: "unavailable", message: "OANDA instrument unavailable" };
  }
  if (body.granularity !== granularity) {
    return { ok: false, failure: "malformed_response", message: "OANDA response is malformed" };
  }
  const complete: MappedCandle[] = [];
  let lastTime: string | null = null;
  for (const raw of body.candles) {
    if (!isRecord(raw) || typeof raw.complete !== "boolean") {
      return { ok: false, failure: "malformed_response", message: "OANDA candle is malformed" };
    }
    const time = utcInstant(raw.time);
    if (time === null) {
      return { ok: false, failure: "malformed_response", message: "OANDA timestamp is malformed" };
    }
    lastTime = time;
    if (!raw.complete) continue;
    const mapped = mapMidCandle(raw, time);
    if (mapped === null) {
      return { ok: false, failure: "malformed_response", message: "OANDA candle OHLC is malformed" };
    }
    complete.push(mapped);
  }
  return { ok: true, page: { complete, rawCount: body.candles.length, lastTime } };
}

function mapMidCandle(raw: Record<string, unknown>, time: string): MappedCandle | null {
  if (!isRecord(raw.mid)) return null;
  const open = decimalPrice(raw.mid.o);
  const high = decimalPrice(raw.mid.h);
  const low = decimalPrice(raw.mid.l);
  const close = decimalPrice(raw.mid.c);
  if (open === null || high === null || low === null || close === null) return null;
  if (compareDecimal(high, open) < 0 || compareDecimal(high, close) < 0) return null;
  if (compareDecimal(low, open) > 0 || compareDecimal(low, close) > 0) return null;
  if (compareDecimal(high, low) < 0) return null;
  const volume = raw.volume === undefined ? undefined : integerVolume(raw.volume);
  if (raw.volume !== undefined && volume === null) return null;
  return {
    time,
    open,
    high,
    low,
    close,
    ...(volume === undefined || volume === null ? {} : { volume }),
  };
}

function pricingUrl(config: OandaMarketConfig): string {
  const url = new URL(`/v3/accounts/${encodeURIComponent(config.accountId)}/pricing`, config.origin);
  url.searchParams.set("instruments", OANDA_INSTRUMENT);
  url.searchParams.set("includeHomeConversions", "false");
  url.searchParams.set("includeUnitsAvailable", "false");
  return url.href;
}

function candleUrl(
  config: OandaMarketConfig,
  granularity: string,
  from: string,
  to: string,
  includeFirst: boolean,
): string {
  const url = new URL(
    `/v3/accounts/${encodeURIComponent(config.accountId)}/instruments/${OANDA_INSTRUMENT}/candles`,
    config.origin,
  );
  url.searchParams.set("price", "M");
  url.searchParams.set("granularity", granularity);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("includeFirst", includeFirst ? "true" : "false");
  return url.href;
}

function httpFailure(status: number): OandaFailure {
  if (status === 401 || status === 403) {
    return { ok: false, failure: "authentication_failure", message: "OANDA authentication failed" };
  }
  if (status === 404) {
    return { ok: false, failure: "unavailable", message: "OANDA instrument unavailable" };
  }
  if (status === 429) {
    return { ok: false, failure: "rate_limit", message: "OANDA rate limit" };
  }
  return { ok: false, failure: "unavailable", message: "OANDA request failed" };
}

function transportFailure(error: unknown): OandaFailure {
  if (error instanceof MarketDataProviderError && error.kind === "timeout") {
    return { ok: false, failure: "timeout", message: "OANDA request timed out" };
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return { ok: false, failure: "timeout", message: "OANDA request timed out" };
  }
  if (error instanceof MarketDataProviderError && error.kind === "network_failure") {
    return { ok: false, failure: "network_failure", message: "OANDA request failed" };
  }
  return { ok: false, failure: "network_failure", message: "OANDA request failed" };
}

function topPrice(book: unknown): string | null {
  if (!Array.isArray(book) || book.length === 0 || !isRecord(book[0])) return null;
  return decimalPrice(book[0].price);
}

function decimalPrice(value: unknown): string | null {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) return null;
  if (/^0(?:\.0+)?$/.test(value)) return null;
  return value;
}

function integerVolume(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function compareDecimal(left: string, right: string): number {
  const [leftInt, leftFrac = ""] = left.split(".");
  const [rightInt, rightFrac = ""] = right.split(".");
  const a = leftInt!.replace(/^0+/, "") || "0";
  const b = rightInt!.replace(/^0+/, "") || "0";
  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  if (a !== b) return a > b ? 1 : -1;
  const width = Math.max(leftFrac.length, rightFrac.length);
  const af = leftFrac.padEnd(width, "0");
  const bf = rightFrac.padEnd(width, "0");
  if (af === bf) return 0;
  return af > bf ? 1 : -1;
}

function utcInstant(value: unknown): string | null {
  try {
    return canonicalizeUtc(value).iso;
  } catch {
    return null;
  }
}

function isCanonicalTimeframe(value: string): value is XauUsdTimeframe {
  return (XAUUSD_TIMEFRAMES as readonly string[]).includes(value);
}

function isOandaEnvironment(value: string): value is OandaEnvironmentName {
  return (OANDA_ENVIRONMENTS as readonly string[]).includes(value);
}

function isAcceptableToken(value: string): boolean {
  if (value.length < 16 || value.length > 256) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 33 || code > 126) return false;
  }
  return true;
}

function resolvePageSize(value: number | undefined): number {
  const pageSize = value ?? OANDA_MAX_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > OANDA_MAX_PAGE_SIZE) {
    throw new Error("OANDA page size is invalid");
  }
  return pageSize;
}

function resolveMaxPages(value: number | undefined): number {
  const maxPages = value ?? DEFAULT_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 8) {
    throw new Error("OANDA page count is invalid");
  }
  return maxPages;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
