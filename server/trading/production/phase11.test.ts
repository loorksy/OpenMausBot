import { describe, expect, it } from "vitest";

import { createDeterministicXauUsdProvider } from "../infrastructure/market_data/provider.ts";
import type { MarketRequest } from "../infrastructure/market_data/model.ts";
import { createMetaApiReconciliationAdapter, type MetaApiReconciliationReader } from "../reconciliation/capture.ts";
import { readProductionMarket, readProductionTruth } from "./truth.ts";

const AT = "2026-10-01T12:00:00.000Z";
const STAMP = "2026-10-01T11:59:30.000Z";
const TOKEN = "metaapi-token-value";

function request(): MarketRequest {
  let n = 0;
  return {
    agentRunId: "run-1",
    correlationId: "corr-1",
    versionManifestId: "ver-1",
    clock: {
      receivedAt: AT,
      processedAt: "2026-10-01T12:00:00.100Z",
      limits: { staleAfterMs: 60_000, futureSkewMs: 2_000, abnormalLatencyMs: 5_000 },
    },
    nextEventId: () => `evt-${++n}`,
  };
}

function liveProvider(provenance: "LIVE" | "SIMULATOR" | "REPLAY" | "STALE" = "LIVE", environment: "PAPER" | "LIVE" = "PAPER") {
  return createDeterministicXauUsdProvider({
    providerId: "explicit-paper-feed",
    environment,
    successProvenance: provenance,
    quote: {
      ok: true,
      providerTimestamp: provenance === "STALE" ? "2026-10-01T11:00:00.000Z" : STAMP,
      provenance,
      instrument: "XAUUSD",
      quote: { bid: 2300, ask: 2301 },
    },
  });
}

function reader(positions: unknown[] = []): MetaApiReconciliationReader {
  return {
    getOrders: async () => ({ kind: "ok", value: [] }),
    getDeals: async () => ({ kind: "ok", value: [] }),
    getPositions: async () => ({ kind: "ok", value: positions }),
    getAccountState: async () => ({ kind: "ok", value: { balance: 10000, equity: 10000, margin: 100, currency: "USD" } }),
  };
}

function adapter(positions: unknown[] = []) {
  return createMetaApiReconciliationAdapter({
    binding: {
      schemaVersion: "xauusd-metaapi-account-1",
      bindingId: "paper-binding-1",
      environment: "PAPER",
      credentialSlot: "paper",
      brokerSymbol: "XAUUSD",
      provider: "metaapi-cloud",
      region: "london",
    },
    token: TOKEN,
    accountId: "account-uuid-value",
    reader: reader(positions),
  });
}

describe("phase 11 production truth", () => {
  it("accepts a live quote and does not invent a provider when none is installed", async () => {
    const live = await readProductionMarket({ provider: liveProvider(), environment: "PAPER", request: request() });
    expect(live.symbol).toBe("XAUUSD");
    expect(live.provenance).toBe("LIVE");
    expect(live.bid).toBe(2300);
    expect(live.ask).toBe(2301);
    expect(live.marketStatus).toBe("quoted");
    expect(live.failure).toBeNull();

    const missing = await readProductionMarket({ provider: null, environment: "PAPER", request: request() });
    expect(missing.provenance).toBe("UNAVAILABLE");
    expect(missing.failure).toBe("MARKET_UNAVAILABLE");
    expect(missing.bid).toBeNull();
    expect(missing.executionPermitted).toBe(false);
  });

  it("keeps stale data observable and blocks simulator, replay, and a foreign symbol", async () => {
    const stale = await readProductionMarket({ provider: liveProvider("STALE"), environment: "PAPER", request: request() });
    expect(stale.failure === "MARKET_STALE" || stale.provenance === "STALE" || stale.marketStatus === "stale").toBe(true);
    expect(stale.executionPermitted).toBe(false);

    const simulated = await readProductionMarket({ provider: liveProvider("SIMULATOR"), environment: "PAPER", request: request() });
    expect(simulated.failure).toBe("PROVENANCE_REJECTED");
    expect(simulated.bid).toBeNull();

    const replay = await readProductionMarket({ provider: liveProvider("REPLAY", "LIVE"), environment: "LIVE", request: request() });
    expect(replay.failure).toBe("PROVENANCE_REJECTED");
    expect(replay.source).toBeNull();
  });

  it("reads account truth, broker health, and keeps credentials out", async () => {
    const truth = await readProductionTruth({
      provider: liveProvider(),
      adapter: adapter([{ positionId: "pos-9", symbol: "XAUUSD", volume: 0.12, direction: "LONG" }, { positionId: "fx-1", symbol: "EURUSD", volume: 1, direction: "SHORT" }]),
      environment: "PAPER",
      provenance: "LIVE",
      request: request(),
      observedAt: AT,
      reconciliationState: "RECONCILED",
    });
    expect(truth.account.accountIdentity).toBe("paper-binding-1");
    expect(truth.account.balance).toBe(10000);
    expect(truth.account.equity).toBe(10000);
    expect(truth.account.currency).toBe("USD");
    expect(truth.account.openPositions).toEqual([{ positionId: "pos-9", direction: "LONG", quantity: 0.12 }]);
    expect(truth.account.foreignSymbols).toEqual(["EURUSD"]);
    expect(JSON.stringify(truth.account.openPositions)).not.toContain("EURUSD");
    expect(truth.account.brokerHealth).toBe("HEALTHY");
    expect(truth.executionPermitted).toBe(true);
    expect(JSON.stringify(truth)).not.toContain(TOKEN);
    expect(JSON.stringify(truth)).not.toContain("account-uuid-value");

    const unavailable = await readProductionTruth({
      provider: null,
      adapter: null,
      environment: "PAPER",
      provenance: "LIVE",
      request: request(),
      observedAt: AT,
      reconciliationState: null,
    });
    expect(unavailable.executionPermitted).toBe(false);
    expect(unavailable.failureCodes).toContain("MARKET_UNAVAILABLE");
    expect(unavailable.failureCodes).toContain("ACCOUNT_UNAVAILABLE");
    expect(unavailable.account.brokerHealth).toBe("UNKNOWN");
  });

  it("blocks unknown reconciliation and a mismatched provider environment", async () => {
    const unknown = await readProductionTruth({
      provider: liveProvider(),
      adapter: adapter(),
      environment: "PAPER",
      provenance: "LIVE",
      request: request(),
      observedAt: AT,
      reconciliationState: "UNKNOWN",
    });
    expect(unknown.failureCodes).toContain("RECONCILIATION_UNKNOWN");
    expect(unknown.executionPermitted).toBe(false);

    const crossed = await readProductionMarket({ provider: liveProvider("LIVE", "LIVE"), environment: "PAPER", request: request() });
    expect(crossed.failure).toBe("MARKET_UNAVAILABLE");
    expect(crossed.source).toBeNull();
  });
});
