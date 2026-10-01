import { describe, expect, it } from "vitest";

import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { foundationControl } from "./boundaries.ts";
import { applyTradingMigrations, openTradingStore, tradingPartitionKey, TRADING_STORE_SCHEMA_VERSION } from "../persistence/store.ts";

describe("foundation control plane", () => {
  it("fails closed instead of pretending to trade", () => {
    expect(foundationControl.implemented).toBe(false);
    const calls = [
      foundationControl.assessRisk,
      foundationControl.assessPolicy,
      foundationControl.runExecutionGate,
      foundationControl.reconcile,
      foundationControl.enforceKillSwitch,
      foundationControl.submitToBroker,
    ];
    for (const call of calls) {
      expect(call).toThrow(TradingDomainError);
      try {
        call();
      } catch (error) {
        expect(error).toMatchObject({ failClosed: true });
      }
    }
  });
});

describe("trading store foundation", () => {
  it("does not open a database without an explicit path and keeps partitions apart", () => {
    expect(TRADING_STORE_SCHEMA_VERSION).toBe(2);
    expect(tradingPartitionKey("SIMULATOR")).toBe("xauusd/SIMULATOR");
    expect(tradingPartitionKey("PAPER")).toBe("xauusd/PAPER");
    expect(tradingPartitionKey("LIVE")).toBe("xauusd/LIVE");
    expect(new Set([
      tradingPartitionKey("SIMULATOR"),
      tradingPartitionKey("PAPER"),
      tradingPartitionKey("LIVE"),
    ]).size).toBe(3);
    expect(applyTradingMigrations).toThrow(TradingDomainError);
    expect(openTradingStore).toThrow(TradingDomainError);
    try {
      openTradingStore();
    } catch (error) {
      expect(error).toMatchObject({ code: "trading_store_not_implemented", failClosed: true });
    }
  });
});
