import { describe, expect, it } from "vitest";

import { parseTradingEvent } from "../../../shared/trading/events.ts";
import { tradingHealthReport, queryTokenRejected } from "../production/health.ts";
import { projectDesk, toTradingViewQuote, tradingDeskReport, tradingViewChartStatus } from "./project.ts";

const AT = "2026-08-15T14:30:00.000Z";

function event(type: "monitoring.started" | "decision.created" | "emergency.stop" | "review.created", at = AT) {
  return parseTradingEvent({
    schemaVersion: 1,
    eventId: `evt-${type}`,
    type,
    source: "trading-domain",
    at,
    agentRunId: "run-1",
    correlationId: "occ-1",
    environment: "PAPER",
    instrument: "XAUUSD",
    actor: "xauusd-monitoring",
    runtimeThreadId: "thread-1",
    runtimeTurnId: "turn-1",
    payload: {
      occurrenceId: "occ-1",
      routineId: "routine-1",
      routineRunId: "44444444-4444-4444-8444-444444444444",
      executionRequestId: "exr-1",
      positionId: "pos-9",
    },
  });
}

describe("phase 15 desk, health, and chart", () => {
  it("projects presence from real events and keeps correlation ids", () => {
    const idle = projectDesk({ events: [] });
    expect(idle.presence).toBe("IDLE");
    expect(idle.at).toBeNull();
    const desk = projectDesk({
      events: [event("monitoring.started"), event("decision.created", "2026-08-15T14:31:00.000Z"), event("emergency.stop", "2026-08-15T14:32:00.000Z")],
      positionState: "POSITION_OPEN",
    });
    expect(desk.presence).toBe("BLOCKED");
    expect(desk.at).toBe("2026-08-15T14:32:00.000Z");
    expect(desk.killSwitchEngaged).toBe(true);
    expect(desk.positionState).toBe("POSITION_OPEN");
    expect(desk.correlation).toMatchObject({
      agentRunId: "run-1",
      occurrenceId: "occ-1",
      routineId: "routine-1",
      threadId: "thread-1",
      providerTurnId: "turn-1",
      executionRequestId: "exr-1",
      positionId: "pos-9",
    });
    const review = projectDesk({ events: [event("review.created")] });
    expect(review.presence).toBe("REVIEWING");
  });

  it("reports unhealthy trading dependencies and rejects a query token", () => {
    const health = tradingHealthReport({});
    expect(health.application).toBe("up");
    expect(health.tradingStore).toBe("unconfigured");
    expect(health.marketData).toBe("unconfigured");
    expect(health.broker).toBe("UNKNOWN");
    expect(health.healthy).toBe(false);
    expect(health.queryTokenAccepted).toBe(false);
    expect(tradingDeskReport({}).source).toBe("unconfigured");
    expect(tradingDeskReport({}).presence).toBe("IDLE");
    expect(queryTokenRejected("?token=secret")).toBe(true);
    expect(queryTokenRejected("")).toBe(false);
    expect(JSON.stringify(health)).not.toContain("token");
  });

  it("adapts a live XAUUSD quote for TradingView and does not substitute another engine", () => {
    expect(tradingViewChartStatus(false)).toEqual({ engine: "unavailable", fallback: false });
    expect(tradingViewChartStatus(true)).toEqual({ engine: "tradingview", fallback: false });
    expect(toTradingViewQuote({
      symbol: "XAUUSD",
      bid: 2300,
      ask: 2301,
      timestamp: AT,
      provenance: "LIVE",
    })).toEqual({ ok: true, symbol: "XAUUSD", bid: 2300, ask: 2301, time: AT });
    expect(toTradingViewQuote({
      symbol: "EURUSD",
      bid: 1,
      ask: 1.1,
      timestamp: AT,
      provenance: "LIVE",
    }).ok).toBe(false);
    expect(toTradingViewQuote({
      symbol: "XAUUSD",
      bid: 2300,
      ask: 2301,
      timestamp: AT,
      provenance: "SIMULATOR",
    })).toEqual({ ok: false, reason: "UNAVAILABLE" });
  });
});
