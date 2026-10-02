import { useEffect, useState } from "react";

type TradingHealth = {
  application: string;
  tradingStore: string;
  marketData: string;
  broker: string;
  reconciliation: string;
  healthy: boolean;
};

type DeskView = {
  presence: string;
  at: string | null;
  eventType: string | null;
  positionState: string | null;
  source: string;
};

const SECTIONS = ["desk", "trading", "research", "automation", "lab", "settings"] as const;

/** Production desk shell. Presence stays idle until a real event arrives.
 * The chart slot names TradingView and does not start another engine. */
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
  return (
    <main className="trading-desk" data-section={section}>
      <header>
        <h1>XAUUSD desk</h1>
        <p>{section}</p>
      </header>
      <section aria-label="Agent presence">
        <h2>Agent</h2>
        <p>{desk?.presence ?? "IDLE"}</p>
        <p>{desk?.eventType ? `${desk.eventType} at ${desk.at ?? ""}` : "No trading event has been recorded for this view."}</p>
        <p>{desk?.positionState ? `Position state ${desk.positionState}` : "Broker position is not inferred from this page."}</p>
      </section>
      <section aria-label="Chart">
        <h2>XAUUSD</h2>
        <p>{health?.marketData === "live" ? "Live quote available for TradingView." : "TradingView chart is unavailable until live market truth is present."}</p>
      </section>
      <section aria-label="Position">
        <h2>Position</h2>
        <p>Broker position is not inferred from this page.</p>
      </section>
      <section aria-label="Trading health">
        <h2>Health</h2>
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
