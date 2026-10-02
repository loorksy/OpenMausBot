import { describe, expect, it } from "vitest";

import { parseTradingEvent } from "../../../shared/trading/events.ts";
import { tradingHealthReport, queryTokenRejected } from "../production/health.ts";
import { projectDesk, tradingDeskReport } from "./project.ts";

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
  it("does not derive room presence, position, or the kill switch from events", () => {
    const desk = projectDesk({
      events: [event("monitoring.started"), event("decision.created", "2026-08-15T14:31:00.000Z"), event("emergency.stop", "2026-08-15T14:32:00.000Z")],
      positionState: "POSITION_OPEN",
    });
    expect(desk.authoritative).toBe(false);
    expect(desk.presence).toBeNull();
    expect(desk.killSwitchEngaged).toBeNull();
    expect(desk.positionState).toBeNull();
    expect(desk.at).toBeNull();
    expect(desk.eventType).toBeNull();
  });

  it("reports unhealthy trading dependencies and rejects a query token", () => {
    const health = tradingHealthReport({});
    expect(health.application).toBe("up");
    expect(health.tradingStore).toBe("unconfigured");
    expect(health.marketData).toBe("unconfigured");
    expect(health.broker).toBe("UNKNOWN");
    expect(health.healthy).toBe(false);
    expect(health.queryTokenAccepted).toBe(false);
    expect(tradingDeskReport({}).source).toBe("not-authoritative");
    expect(tradingDeskReport({}).authoritative).toBe(false);
    expect(tradingDeskReport({}).presence).toBeNull();
    expect(queryTokenRejected("?token=secret")).toBe(true);
    expect(queryTokenRejected("")).toBe(false);
    expect(JSON.stringify(health)).not.toContain("token");
  });

  it("keeps a chart section and does not require another chart engine", () => {
    const desk = projectDesk({ events: [] });
    expect(desk.sections).toContain("chart");
    expect(JSON.stringify(desk)).not.toContain("tradingview");
    expect(JSON.stringify(desk)).not.toContain("charting_library");
  });
});
