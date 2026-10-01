import type { ProvenanceStatus, TradingEnvironment, XauUsdTimeframe } from "../../../../shared/trading/index.ts";
import { MarketDataProviderError, type ProviderFailureKind, type RawCandleInput, type RawProviderResult } from "./model.ts";

export interface CandleRange {
  readonly from: string;
  readonly to: string;
}

/** XAUUSD-only feed. There is no symbol argument. */
export interface XauUsdMarketDataProvider {
  readonly providerId: string;
  readonly environment: TradingEnvironment;
  readonly successProvenance: ProvenanceStatus;
  getXauUsdQuote(): Promise<RawProviderResult>;
  getXauUsdCandles(timeframe: XauUsdTimeframe, range: CandleRange): Promise<RawProviderResult>;
}

export interface DeterministicProviderCall {
  readonly op: "quote" | "candles";
  readonly timeframe?: XauUsdTimeframe;
}

export interface DeterministicXauUsdProvider extends XauUsdMarketDataProvider {
  readonly calls: readonly DeterministicProviderCall[];
}

export interface DeterministicFixture {
  readonly providerId: string;
  readonly environment: TradingEnvironment;
  readonly successProvenance: ProvenanceStatus;
  readonly quote?: RawProviderResult;
  readonly candles?: Partial<Record<XauUsdTimeframe, RawProviderResult>>;
  readonly failure?: { readonly kind: ProviderFailureKind; readonly message?: string };
  readonly throwKind?: ProviderFailureKind;
}

/** In-memory fixture. It does not open a socket or read credentials. */
export function createDeterministicXauUsdProvider(fixture: DeterministicFixture): DeterministicXauUsdProvider {
  const calls: DeterministicProviderCall[] = [];
  const fail = (): RawProviderResult => {
    if (fixture.throwKind) throw new MarketDataProviderError(fixture.throwKind, fixture.failure?.message ?? fixture.throwKind);
    if (fixture.failure) return { ok: false, failure: fixture.failure.kind, message: fixture.failure.message };
    return { ok: false, failure: "unavailable", message: "fixture has no payload" };
  };
  return {
    providerId: fixture.providerId,
    environment: fixture.environment,
    successProvenance: fixture.successProvenance,
    calls,
    async getXauUsdQuote() {
      calls.push({ op: "quote" });
      if (fixture.throwKind || fixture.failure) return fail();
      return fixture.quote ?? fail();
    },
    async getXauUsdCandles(timeframe, range) {
      calls.push({ op: "candles", timeframe });
      if (fixture.throwKind || fixture.failure) return fail();
      const body = fixture.candles?.[timeframe] ?? { ok: false as const, failure: "empty_response" as const, message: "no candles for timeframe" };
      if (!body.ok || !body.candles) return body;
      const from = Date.parse(range.from);
      const to = Date.parse(range.to);
      const candles = body.candles.filter((candle) => inRange(candle, from, to));
      return { ...body, candles };
    },
  };
}

function inRange(candle: RawCandleInput, from: number, to: number): boolean {
  if (typeof candle.time !== "string" || Number.isNaN(from) || Number.isNaN(to)) return true;
  const time = Date.parse(candle.time);
  if (Number.isNaN(time)) return true;
  return time >= from && time < to;
}
