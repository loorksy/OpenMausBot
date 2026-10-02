import { provenanceStatusSchema, type ProvenanceStatus } from "../../../shared/trading/environment.ts";
import { utcTimestampSchema } from "../../../shared/trading/ids.ts";
import { MARKET_FRESHNESS_STATES, type MarketFreshness } from "../../../shared/trading/snapshot.ts";

/** Authoritative account facts supplied by the caller. This is not a broker
 * account adapter and it does not mutate equity or positions. */

export const EXPOSURE_SIDES = ["none", "long", "short", "unknown"] as const;

export type ExposureSide = (typeof EXPOSURE_SIDES)[number];

export interface AccountRiskState {
  readonly equity: number;
  readonly currency: "USD";
  readonly exposureSide: ExposureSide;
  readonly exposureLots: number | null;
  readonly openRiskAmount: number | null;
  readonly asOf: string;
  readonly provenance: ProvenanceStatus;
  readonly freshness: MarketFreshness;
  readonly sourceId: string;
  readonly sourceVersion: string;
}

export interface MarketRiskFacts {
  readonly snapshotId: string;
  readonly provenance: ProvenanceStatus;
  readonly freshness: MarketFreshness;
  readonly providerTimestamp: string;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly spread: number | null;
}

const ACCOUNT_KEYS = new Set([
  "equity",
  "currency",
  "exposureSide",
  "exposureLots",
  "openRiskAmount",
  "asOf",
  "provenance",
  "freshness",
  "sourceId",
  "sourceVersion",
]);

const MARKET_KEYS = new Set([
  "snapshotId",
  "provenance",
  "freshness",
  "providerTimestamp",
  "bid",
  "ask",
  "spread",
]);

function idOk(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 128;
}

function optionalNonNegative(value: unknown): number | null | "bad" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "bad";
  return value;
}

function optionalPrice(value: unknown): number | null | "bad" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "bad";
  return value;
}

export type AccountRead =
  | { ok: true; account: AccountRiskState }
  | { ok: false; reason: "INVALID_EQUITY" | "ACCOUNT_STATE_UNAVAILABLE" | "ACCOUNT_STATE_STALE" | "INVALID_INPUT" };

export function readAccountRiskState(value: unknown): AccountRead {
  if (value === null || value === undefined) return { ok: false, reason: "ACCOUNT_STATE_UNAVAILABLE" };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "INVALID_INPUT" };
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ACCOUNT_KEYS.has(key)) return { ok: false, reason: "INVALID_INPUT" };
  }
  if (typeof record.equity !== "number" || !Number.isFinite(record.equity) || record.equity <= 0) {
    return { ok: false, reason: "INVALID_EQUITY" };
  }
  if (record.currency !== "USD") return { ok: false, reason: "INVALID_EQUITY" };
  if (typeof record.exposureSide !== "string" || !(EXPOSURE_SIDES as readonly string[]).includes(record.exposureSide)) {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  const side = record.exposureSide as ExposureSide;
  const lots = optionalNonNegative(record.exposureLots);
  const openRisk = optionalNonNegative(record.openRiskAmount);
  if (lots === "bad" || openRisk === "bad") return { ok: false, reason: "INVALID_INPUT" };
  if (side === "unknown" && lots !== null) return { ok: false, reason: "INVALID_INPUT" };
  if ((side === "long" || side === "short") && (lots === null || lots <= 0)) return { ok: false, reason: "INVALID_INPUT" };
  if (side === "none" && lots !== 0) return { ok: false, reason: "INVALID_INPUT" };
  if (typeof record.asOf !== "string" || !utcTimestampSchema.safeParse(record.asOf).success) return { ok: false, reason: "INVALID_INPUT" };
  const provenance = provenanceStatusSchema.safeParse(record.provenance);
  if (!provenance.success) return { ok: false, reason: "INVALID_INPUT" };
  if (typeof record.freshness !== "string" || !(MARKET_FRESHNESS_STATES as readonly string[]).includes(record.freshness)) {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  if (!idOk(record.sourceId) || !idOk(record.sourceVersion)) return { ok: false, reason: "INVALID_INPUT" };
  const freshness = record.freshness as MarketFreshness;
  if (provenance.data === "UNAVAILABLE" || freshness === "unavailable" || freshness === "invalid" || freshness === "future_dated") {
    return { ok: false, reason: "ACCOUNT_STATE_UNAVAILABLE" };
  }
  if (provenance.data === "STALE" || freshness === "stale") {
    return { ok: false, reason: "ACCOUNT_STATE_STALE" };
  }
  return {
    ok: true,
    account: {
      equity: record.equity,
      currency: "USD",
      exposureSide: side,
      exposureLots: side === "none" ? 0 : lots,
      openRiskAmount: openRisk,
      asOf: record.asOf,
      provenance: provenance.data,
      freshness,
      sourceId: record.sourceId.trim(),
      sourceVersion: record.sourceVersion.trim(),
    },
  };
}

export type MarketRead =
  | { ok: true; market: MarketRiskFacts }
  | { ok: false; reason: "MARKET_DATA_UNAVAILABLE" | "MARKET_DATA_STALE" | "INVALID_INPUT"; snapshotId: string | null };

export function readMarketRiskFacts(value: unknown, rejectStale: boolean): MarketRead {
  if (value === null || value === undefined) return { ok: false, reason: "MARKET_DATA_UNAVAILABLE", snapshotId: null };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "INVALID_INPUT", snapshotId: null };
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!MARKET_KEYS.has(key)) return { ok: false, reason: "INVALID_INPUT", snapshotId: null };
  }
  const snapshotId = idOk(record.snapshotId) ? record.snapshotId.trim() : null;
  if (snapshotId === null) return { ok: false, reason: "MARKET_DATA_UNAVAILABLE", snapshotId: null };
  if (typeof record.providerTimestamp !== "string" || !utcTimestampSchema.safeParse(record.providerTimestamp).success) {
    return { ok: false, reason: "INVALID_INPUT", snapshotId };
  }
  const provenance = provenanceStatusSchema.safeParse(record.provenance);
  if (!provenance.success) return { ok: false, reason: "INVALID_INPUT", snapshotId };
  if (typeof record.freshness !== "string" || !(MARKET_FRESHNESS_STATES as readonly string[]).includes(record.freshness)) {
    return { ok: false, reason: "INVALID_INPUT", snapshotId };
  }
  const bid = optionalPrice(record.bid);
  const ask = optionalPrice(record.ask);
  const spread = optionalNonNegative(record.spread);
  if (bid === "bad" || ask === "bad" || spread === "bad") return { ok: false, reason: "INVALID_INPUT", snapshotId };
  const freshness = record.freshness as MarketFreshness;
  if (rejectStale) {
    if (provenance.data === "UNAVAILABLE" || freshness === "unavailable" || freshness === "invalid" || freshness === "future_dated") {
      return { ok: false, reason: "MARKET_DATA_UNAVAILABLE", snapshotId };
    }
    if (provenance.data === "STALE" || freshness === "stale") {
      return { ok: false, reason: "MARKET_DATA_STALE", snapshotId };
    }
  }
  return {
    ok: true,
    market: {
      snapshotId,
      provenance: provenance.data,
      freshness,
      providerTimestamp: record.providerTimestamp,
      bid,
      ask,
      spread,
    },
  };
}
