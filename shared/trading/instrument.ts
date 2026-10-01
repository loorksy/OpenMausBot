import { z } from "zod";

import { TradingDomainError } from "./errors.ts";

/** The only trading instrument. This is a literal, not a symbol registry. */
export const XAUUSD_INSTRUMENT = "XAUUSD" as const;

export type XauUsdInstrument = typeof XAUUSD_INSTRUMENT;

export const xauUsdInstrumentSchema = z.literal(XAUUSD_INSTRUMENT, {
  error: "instrument must be XAUUSD",
});

export function parseXauUsdInstrument(value: unknown): XauUsdInstrument {
  const parsed = xauUsdInstrumentSchema.safeParse(value);
  if (!parsed.success) {
    throw new TradingDomainError("instrument_rejected", "The trading domain accepts only XAUUSD");
  }
  return parsed.data;
}

/** Any trading payload that names an instrument must name XAUUSD before it
 * can move to the next boundary. */
export function assertXauUsdBoundary(value: unknown): XauUsdInstrument {
  if (value === null || typeof value !== "object" || !("instrument" in value)) {
    throw new TradingDomainError("instrument_rejected", "A trading record must include the XAUUSD instrument");
  }
  return parseXauUsdInstrument((value as { instrument: unknown }).instrument);
}
