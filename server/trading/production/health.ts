import { readInstalledXauUsdMarketDataProvider } from "../occurrence/runtime.ts";
import { readXauUsdJobMount } from "../jobs/mount.ts";
import type { BrokerHealth } from "./truth.ts";

/** Public trading dependency report. It does not include credentials and it
 * does not call a broker. Missing dependencies are not healthy. */
export function tradingHealthReport(env: Readonly<Record<string, string | undefined>>, broker: BrokerHealth = "UNKNOWN"): {
  readonly application: "up";
  readonly tradingStore: "configured" | "unconfigured" | "unavailable";
  readonly marketData: "live" | "unconfigured" | "unavailable";
  readonly broker: BrokerHealth;
  readonly reconciliation: "unknown";
  readonly healthy: false;
  readonly queryTokenAccepted: false;
} {
  let tradingStore: "configured" | "unconfigured" | "unavailable" = "unconfigured";
  try {
    const mount = readXauUsdJobMount(env);
    tradingStore = mount.mounted ? "configured" : "unconfigured";
  } catch {
    tradingStore = "unavailable";
  }
  const provider = readInstalledXauUsdMarketDataProvider();
  const marketData = provider === null
    ? "unconfigured"
    : provider.successProvenance === "LIVE"
      ? "live"
      : "unavailable";
  return {
    application: "up",
    tradingStore,
    marketData,
    broker,
    reconciliation: "unknown",
    healthy: false,
    queryTokenAccepted: false,
  };
}

export function queryTokenRejected(search: string): boolean {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return params.has("token");
}
