import { assertProvenanceForEnvironment, type ProvenanceStatus, type TradingEnvironment } from "../../../shared/trading/environment.ts";
import { assertNoSecretFields, seal } from "../../../shared/trading/ids.ts";
import { XAUUSD_INSTRUMENT } from "../../../shared/trading/instrument.ts";
import type { ReconciliationState } from "../../../shared/trading/reconciliation.ts";
import { readXauUsdQuote } from "../infrastructure/market_data/read.ts";
import type { MarketRequest } from "../infrastructure/market_data/model.ts";
import type { XauUsdMarketDataProvider } from "../infrastructure/market_data/provider.ts";
import type { MetaApiReconciliationAdapter } from "../reconciliation/capture.ts";
import type { BrokerAccountSnapshot } from "../reconciliation/snapshot.ts";

/** Production market and account truth. Version `xauusd-production-truth-1`.
 * A missing provider stays unavailable. This module does not open a socket,
 * invent a feed, or substitute a fixture. */
export const PRODUCTION_TRUTH_VERSION = "xauusd-production-truth-1" as const;

export const BROKER_HEALTH_STATES = ["HEALTHY", "DEGRADED", "UNAVAILABLE", "UNKNOWN"] as const;
export type BrokerHealth = (typeof BROKER_HEALTH_STATES)[number];

export interface ProductionMarketObservation {
  readonly symbol: "XAUUSD";
  readonly bid: number | null;
  readonly ask: number | null;
  readonly timestamp: string | null;
  readonly source: string | null;
  readonly provenance: ProvenanceStatus;
  readonly freshness: string;
  readonly marketStatus: "quoted" | "stale" | "unavailable" | "unknown";
  readonly failure: string | null;
  readonly executionPermitted: false;
}

export interface ProductionAccountObservation {
  readonly accountIdentity: string | null;
  readonly balance: number | null;
  readonly equity: number | null;
  readonly currency: string | null;
  readonly openPositions: readonly { readonly positionId: string; readonly direction: "LONG" | "SHORT"; readonly quantity: number }[];
  readonly foreignSymbols: readonly string[];
  readonly brokerHealth: BrokerHealth;
  readonly timestamp: string | null;
  readonly provenance: ProvenanceStatus;
  readonly reconciliationState: ReconciliationState | null;
  readonly failure: string | null;
  readonly executionPermitted: false;
}

export interface ProductionTruth {
  readonly schemaVersion: typeof PRODUCTION_TRUTH_VERSION;
  readonly environment: TradingEnvironment;
  readonly market: ProductionMarketObservation;
  readonly account: ProductionAccountObservation;
  readonly executionPermitted: boolean;
  readonly failureCodes: readonly string[];
}

export function brokerHealthOf(snapshot: BrokerAccountSnapshot | null, environment: TradingEnvironment): BrokerHealth {
  if (snapshot === null) return "UNKNOWN";
  if (snapshot.environment !== environment) return "UNKNOWN";
  if (snapshot.unavailable || snapshot.brokerCallSkipped) return "UNAVAILABLE";
  if (snapshot.invalid) return "UNKNOWN";
  if (!snapshot.complete) return "DEGRADED";
  return "HEALTHY";
}

/** Reads the installed provider. A null provider, a foreign environment, or
 * simulator/replay provenance on paper or live does not call a substitute. */
export async function readProductionMarket(input: {
  readonly provider: XauUsdMarketDataProvider | null;
  readonly environment: TradingEnvironment;
  readonly request: MarketRequest;
}): Promise<ProductionMarketObservation> {
  if (input.provider === null) return marketClosed("UNAVAILABLE", "unavailable", "MARKET_UNAVAILABLE", "unknown");
  if (input.provider.environment !== input.environment) {
    return marketClosed("UNAVAILABLE", "unavailable", "MARKET_UNAVAILABLE", "unknown");
  }
  const declared = input.provider.successProvenance;
  if (declared === "SIMULATOR" || declared === "REPLAY") {
    try {
      assertProvenanceForEnvironment(input.environment, declared);
    } catch {
      return marketClosed("UNAVAILABLE", "unavailable", "PROVENANCE_REJECTED", "unknown");
    }
    return marketClosed(declared, "unavailable", "PROVENANCE_REJECTED", "unknown");
  }
  const read = await readXauUsdQuote(input.provider, input.request);
  if (!read.ok) {
    const stale = read.provenance === "STALE";
    return marketClosed(read.provenance, read.freshness, stale ? "MARKET_STALE" : "MARKET_UNAVAILABLE", stale ? "stale" : "unavailable");
  }
  const fresh = read.data.provenance === "LIVE" && read.data.freshness === "fresh";
  const observation: ProductionMarketObservation = {
    symbol: "XAUUSD",
    bid: read.data.bid,
    ask: read.data.ask,
    timestamp: read.data.providerTimestamp,
    source: read.data.providerId,
    provenance: read.data.provenance,
    freshness: read.data.freshness,
    marketStatus: fresh ? "quoted" : read.data.freshness === "stale" || read.data.provenance === "STALE" ? "stale" : "unknown",
    failure: fresh ? null : read.data.provenance === "STALE" || read.data.freshness === "stale" ? "MARKET_STALE" : "MARKET_UNAVAILABLE",
    executionPermitted: false,
  };
  assertNoSecretFields(observation, "production market");
  return seal(observation);
}

export async function readProductionAccount(input: {
  readonly adapter: MetaApiReconciliationAdapter | null;
  readonly environment: TradingEnvironment;
  readonly provenance: ProvenanceStatus;
  readonly observedAt: string;
  readonly reconciliationState: ReconciliationState | null;
}): Promise<ProductionAccountObservation> {
  if (input.adapter === null) {
    return accountClosed(input.provenance, input.reconciliationState, input.observedAt, "ACCOUNT_UNAVAILABLE", "UNKNOWN");
  }
  const snapshot = await input.adapter.capture({
    environment: input.environment,
    provenance: input.provenance,
    observedAt: input.observedAt,
  });
  const health = brokerHealthOf(snapshot, input.environment);
  const foreign = [...new Set(snapshot.positions.filter((item) => item.symbol !== XAUUSD_INSTRUMENT).map((item) => item.symbol))].sort();
  const own = snapshot.positions.filter((item) => item.symbol === XAUUSD_INSTRUMENT && item.volume > 0 && (item.direction === "LONG" || item.direction === "SHORT"));
  let failure: string | null = null;
  if (health === "UNAVAILABLE") failure = snapshot.brokerCallSkipped ? "ACCOUNT_UNAVAILABLE" : "BROKER_UNAVAILABLE";
  else if (health === "UNKNOWN") failure = "BROKER_UNKNOWN";
  else if (health === "DEGRADED") failure = "BROKER_DEGRADED";
  else if (input.provenance === "STALE") failure = "ACCOUNT_STALE";
  else if (input.reconciliationState === null || input.reconciliationState === "UNKNOWN") failure = "RECONCILIATION_UNKNOWN";
  else if (input.reconciliationState === "DESYNCED") failure = "RECONCILIATION_DESYNCED";
  else if (input.reconciliationState === "DEGRADED") failure = "RECONCILIATION_DEGRADED";
  const observation: ProductionAccountObservation = {
    accountIdentity: snapshot.bindingId.length > 0 ? snapshot.bindingId : null,
    balance: snapshot.account.balance,
    equity: snapshot.account.equity,
    currency: snapshot.account.currency,
    openPositions: own.map((item) => ({
      positionId: item.positionId,
      direction: item.direction as "LONG" | "SHORT",
      quantity: item.volume,
    })),
    foreignSymbols: foreign,
    brokerHealth: health,
    timestamp: snapshot.observedAt,
    provenance: input.provenance,
    reconciliationState: input.reconciliationState,
    failure,
    executionPermitted: false,
  };
  assertNoSecretFields(observation, "production account");
  return seal(observation);
}

export async function readProductionTruth(input: {
  readonly provider: XauUsdMarketDataProvider | null;
  readonly adapter: MetaApiReconciliationAdapter | null;
  readonly environment: TradingEnvironment;
  readonly provenance: ProvenanceStatus;
  readonly request: MarketRequest;
  readonly observedAt: string;
  readonly reconciliationState: ReconciliationState | null;
}): Promise<ProductionTruth> {
  const market = await readProductionMarket({
    provider: input.provider,
    environment: input.environment,
    request: input.request,
  });
  const account = await readProductionAccount({
    adapter: input.adapter,
    environment: input.environment,
    provenance: input.provenance,
    observedAt: input.observedAt,
    reconciliationState: input.reconciliationState,
  });
  const failureCodes = [market.failure, account.failure].filter((code): code is string => code !== null);
  const truth: ProductionTruth = {
    schemaVersion: PRODUCTION_TRUTH_VERSION,
    environment: input.environment,
    market,
    account,
    executionPermitted: failureCodes.length === 0 && market.provenance === "LIVE" && account.brokerHealth === "HEALTHY",
    failureCodes,
  };
  assertNoSecretFields(truth, "production truth");
  return seal(truth);
}

function marketClosed(
  provenance: ProvenanceStatus,
  freshness: string,
  failure: string,
  marketStatus: ProductionMarketObservation["marketStatus"],
): ProductionMarketObservation {
  return seal({
    symbol: "XAUUSD",
    bid: null,
    ask: null,
    timestamp: null,
    source: null,
    provenance,
    freshness,
    marketStatus,
    failure,
    executionPermitted: false,
  });
}

function accountClosed(
  provenance: ProvenanceStatus,
  reconciliationState: ReconciliationState | null,
  timestamp: string,
  failure: string,
  brokerHealth: BrokerHealth,
): ProductionAccountObservation {
  return seal({
    accountIdentity: null,
    balance: null,
    equity: null,
    currency: null,
    openPositions: [],
    foreignSymbols: [],
    brokerHealth,
    timestamp,
    provenance,
    reconciliationState,
    failure,
    executionPermitted: false,
  });
}
