import { TradingDomainError } from "../../../../shared/trading/errors.ts";
import { XAUUSD_TIMEFRAMES, type XauUsdTimeframe } from "../../../../shared/trading/snapshot.ts";

/** Closed alias table. Unknown tokens are rejected. M5 is never rewritten as M1. */
const TIMEFRAME_ALIASES: Readonly<Record<string, XauUsdTimeframe>> = {
  M1: "M1",
  m1: "M1",
  "1m": "M1",
  "1min": "M1",
  M5: "M5",
  m5: "M5",
  "5m": "M5",
  "5min": "M5",
  M15: "M15",
  m15: "M15",
  "15m": "M15",
  "15min": "M15",
  M30: "M30",
  m30: "M30",
  "30m": "M30",
  "30min": "M30",
  H1: "H1",
  h1: "H1",
  "1h": "H1",
  "60m": "H1",
  H4: "H4",
  h4: "H4",
  "4h": "H4",
  D1: "D1",
  d1: "D1",
  "1d": "D1",
};

/** Fixed bar length used only to decide whether a bar's close is already knowable. */
export const TIMEFRAME_MS: Readonly<Record<XauUsdTimeframe, number>> = {
  M1: 60_000,
  M5: 300_000,
  M15: 900_000,
  M30: 1_800_000,
  H1: 3_600_000,
  H4: 14_400_000,
  D1: 86_400_000,
};

export function normalizeTimeframe(value: unknown): { timeframe: XauUsdTimeframe; normalization?: string } {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TradingDomainError("unsupported_timeframe", "timeframe is missing");
  }
  const token = value.trim();
  const canonical = TIMEFRAME_ALIASES[token];
  if (!canonical || !(XAUUSD_TIMEFRAMES as readonly string[]).includes(canonical)) {
    throw new TradingDomainError("unsupported_timeframe", `unsupported timeframe ${token}`);
  }
  if (token === canonical) return { timeframe: canonical };
  return { timeframe: canonical, normalization: `timeframe ${token} normalized to ${canonical}` };
}

export function barCloseMs(openIso: string, timeframe: XauUsdTimeframe): number {
  return Date.parse(openIso) + TIMEFRAME_MS[timeframe];
}
