import { useEffect, useMemo, useState } from "react";

import { XauUsdChart } from "./XauUsdChart.tsx";
import type { CanonicalCandle } from "../trading/kline-adapter.ts";

type TradingHealth = {
  application: string;
  tradingStore: string;
  marketData: string;
  broker: string;
  reconciliation: string;
  healthy: boolean;
};

type DeskChart = {
  provenance: string;
  timeframe: string | null;
  candles: readonly CanonicalCandle[];
};

type DeskView = {
  presence: string;
  at: string | null;
  eventType: string | null;
  positionState: string | null;
  source: string;
  chart?: DeskChart;
};

const SECTIONS = ["desk", "trading", "research", "automation", "lab", "settings"] as const;
const EMPTY_CANDLES: readonly CanonicalCandle[] = [];
const EMPTY_EVENTS: readonly { readonly type: string; readonly at: string }[] = [];

/** Production desk shell. Presence stays idle until a real event arrives.
 * The chart is KLineChart Pro and only draws a canonical XAUUSD series. */
export function TradingDesk({ section }: { section: (typeof SECTIONS)[number] }) {
  const [health, setHealth] = useState<TradingHealth | null>(null);
  const [desk, setDesk] = useState<DeskView | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/health/trading", { signal: controller.signal, credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("trading health unavailable");
        return response.json() as Promise<TradingHealth>;
      })
      .then((body) => setHealth(body))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setHealthError("Trading health is unavailable.");
      });
    void fetch("/api/trading/desk", { signal: controller.signal, credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<DeskView>;
      })
      .then((body) => {
        if (body) setDesk(body);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
      });
    return () => controller.abort();
  }, []);
  const provenance = desk?.chart?.provenance ?? "UNAVAILABLE";
  const candles = desk?.chart?.candles ?? EMPTY_CANDLES;
  const events = useMemo(
    () => (desk?.eventType && desk.at ? [{ type: desk.eventType, at: desk.at }] : EMPTY_EVENTS),
    [desk?.eventType, desk?.at],
  );
  return (
    <main className="trading-desk min-h-dvh bg-app px-4 py-6 text-ink" dir="auto" data-section={section}>
      <header className="mb-6">
        <h1 className="text-xl">XAUUSD desk</h1>
        <p className="text-ink-secondary">{section}</p>
      </header>
      <section aria-label="Agent presence" className="mb-6">
        <h2 className="text-sm text-ink-secondary">Agent</h2>
        <p>{desk?.presence ?? "IDLE"}</p>
        <p>{desk?.eventType ? `${desk.eventType} at ${desk.at ?? ""}` : "No trading event has been recorded for this view."}</p>
        <p>{desk?.positionState ? `Position state ${desk.positionState}` : "Broker position is not inferred from this page."}</p>
      </section>
      <section aria-label="Chart" className="mb-6">
        <XauUsdChart
          symbol="XAUUSD"
          provenance={provenance}
          candles={candles}
          positionState={desk?.positionState}
          events={events}
        />
      </section>
      <section aria-label="Position" className="mb-6">
        <h2 className="text-sm text-ink-secondary">Position</h2>
        <p>{desk?.positionState ? `Position state ${desk.positionState}` : "Broker position is not inferred from this page."}</p>
      </section>
      <section aria-label="Trading health">
        <h2 className="text-sm text-ink-secondary">Health</h2>
        {healthError ? <p>{healthError}</p> : null}
        {health ? (
          <ul>
            <li>application: {health.application}</li>
            <li>trading store: {health.tradingStore}</li>
            <li>market data: {health.marketData}</li>
            <li>broker: {health.broker}</li>
            <li>reconciliation: {health.reconciliation}</li>
          </ul>
        ) : null}
      </section>
    </main>
  );
}

export function tradingDeskSection(pathname: string): (typeof SECTIONS)[number] | null {
  const name = pathname.replace(/\/+$/, "").slice(1);
  return (SECTIONS as readonly string[]).includes(name) ? name as (typeof SECTIONS)[number] : null;
}
