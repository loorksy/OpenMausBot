import { describe, expect, it } from "vitest";

import { parseDecision, type Decision } from "../../../shared/trading/decision.ts";
import { parseTradingEvent, type TradingEvent } from "../../../shared/trading/events.ts";
import { parseKillSwitchState, type KillSwitchState } from "../../../shared/trading/kill-switch.ts";
import type { PositionLifecycleInput } from "../lifecycle/position.ts";
import { loadTradingRoom } from "./load.ts";
import { projectTradingRoom, selectBrokerPosition, type TradingRoomInput } from "./room.ts";

const AT = "2026-08-15T14:30:00.000Z";
const LATER = "2026-08-15T14:31:00.000Z";

function kill(engaged: boolean): KillSwitchState {
  return parseKillSwitchState({
    schemaVersion: 1,
    environment: "PAPER",
    engaged,
    agentRunId: "run-1",
    updatedAt: AT,
    source: "operator",
  });
}

function decision(direction: Decision["direction"], status: Decision["status"] = "DRAFT"): Decision {
  return parseDecision({
    schemaVersion: 1,
    id: "dec-1",
    agentRunId: "run-1",
    environment: "PAPER",
    instrument: "XAUUSD",
    createdAt: AT,
    status,
    thesis: "A stored decision.",
    contextId: "ctx-1",
    snapshotId: "snap-1",
    evidenceIds: [],
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingInformation: [],
    direction,
    targets: [],
    expiry: "2026-08-15T18:00:00.000Z",
    evidenceQuality: "insufficient",
    versionManifestId: "ver-1",
  });
}

function event(type: TradingEvent["type"], at: string, extra: Record<string, unknown> = {}, actor = "xauusd-monitoring"): TradingEvent {
  return parseTradingEvent({
    schemaVersion: 1,
    eventId: `evt-${type}-${at}`,
    type,
    source: "trading-domain",
    at,
    agentRunId: "run-1",
    correlationId: "occ-1",
    environment: "PAPER",
    instrument: "XAUUSD",
    actor,
    nextState: typeof extra.nextState === "string" ? extra.nextState : undefined,
    payload: { occurrenceId: "occ-1", ...extra },
  });
}

function flat(): PositionLifecycleInput {
  return {
    executionState: null,
    reconciliationState: "RECONCILED",
    brokerPositionId: null,
    brokerQuantity: null,
    authorizedQuantity: null,
    exitState: null,
    ambiguous: false,
  };
}

function room(overrides: Partial<TradingRoomInput> = {}) {
  const input: TradingRoomInput = {
    source: "store",
    serverNow: AT,
    environment: "PAPER",
    events: [],
    market: {
      provider: "available",
      observation: {
        provenance: "LIVE",
        timeframe: "M15",
        bid: 4630,
        ask: 4633,
        spread: 3,
        providerTimestamp: AT,
        receivedAt: AT,
        ageMs: 0,
        candleCount: 2,
      },
    },
    positionInputs: flat(),
    brokerView: { positionId: null, direction: null, quantity: null },
    killSwitch: kill(false),
    job: null,
    occurrence: null,
    decision: null,
    risk: null,
    policy: null,
    gate: null,
    approvalOpen: null,
    approvalDecision: null,
    execution: null,
    exitExecution: null,
    reconciliation: { id: "rec-1", state: "RECONCILED" },
    monitoring: null,
    memory: [],
    learning: null,
    ...overrides,
  };
  return projectTradingRoom(input);
}

describe("trading room projection", () => {
  it("does not treat a missing store as a flat position or a live market", () => {
    const projected = room({ source: "unconfigured", positionInputs: "unavailable", killSwitch: "missing" });
    expect(projected.agentPresence).toBe("IDLE");
    expect(projected.position).toMatchObject({ availability: "NOT_AVAILABLE", state: null });
    expect(projected.nextAction.action).toBe("STORE_UNAVAILABLE");
    expect(projected.tradingCursor).toBeNull();
    expect(projected.review).toBe("NOT_AVAILABLE");
  });

  it("keeps an unreadable broker book unknown", () => {
    const projected = room({ positionInputs: "unavailable", brokerView: null });
    expect(projected.position.state).toBe("POSITION_UNKNOWN");
    expect(projected.position.state).not.toBe("NO_POSITION");
    expect(projected.agentPresence).toBe("CONFIRMING");
    expect(projected.nextAction.action).toBe("WAITING_FOR_RECONCILIATION");
  });

  it("does not open a position from position.opened", () => {
    const projected = room({
      events: [event("position.opened", AT, { positionId: "pos-9" })],
    });
    expect(projected.position.state).toBe("NO_POSITION");
    expect(projected.timeline).toHaveLength(1);
    expect(projected.timeline[0]?.type).toBe("position.opened");
  });

  it("derives each lifecycle state only from broker inputs", () => {
    expect(room().position.state).toBe("NO_POSITION");
    expect(room({
      positionInputs: { ...flat(), executionState: "SUBMISSION_ACCEPTED" },
    }).position.state).toBe("POSITION_PENDING");
    expect(room({
      positionInputs: { ...flat(), executionState: "SUBMISSION_UNKNOWN" },
    }).position.state).toBe("POSITION_UNKNOWN");
    expect(room({
      positionInputs: {
        ...flat(),
        brokerPositionId: "pos-9",
        brokerQuantity: 0.12,
        reconciliationState: "RECONCILED",
      },
      brokerView: { positionId: "pos-9", direction: "LONG", quantity: 0.12 },
    }).position.state).toBe("POSITION_OPEN");
    expect(room({
      positionInputs: {
        ...flat(),
        brokerPositionId: "pos-9",
        brokerQuantity: 0.05,
        authorizedQuantity: 0.12,
        reconciliationState: "RECONCILED",
      },
      brokerView: { positionId: "pos-9", direction: "LONG", quantity: 0.05 },
    }).position.state).toBe("POSITION_PARTIALLY_OPEN");
    expect(room({
      positionInputs: {
        ...flat(),
        brokerPositionId: "pos-9",
        brokerQuantity: 0.12,
        exitState: "SUBMISSION_ACCEPTED",
        reconciliationState: "RECONCILED",
      },
      brokerView: { positionId: "pos-9", direction: "LONG", quantity: 0.12 },
      exitExecution: { id: "exr-exit", state: "SUBMISSION_ACCEPTED", brokerCalled: true, closePositionId: "pos-9", quantity: 0.12, reason: null },
    }).position.state).toBe("POSITION_CLOSING");
    expect(room({
      positionInputs: {
        ...flat(),
        exitState: "FILL_REPORTED",
        reconciliationState: "RECONCILED",
      },
    }).position.state).toBe("POSITION_CLOSED");
    expect(room({
      positionInputs: { ...flat(), ambiguous: true },
    }).position.state).toBe("POSITION_DESYNCED");
    expect(room({
      positionInputs: { ...flat(), reconciliationState: "DESYNCED" },
      reconciliation: { id: "rec-1", state: "DESYNCED" },
    }).position.state).not.toBe("NO_POSITION");
  });

  it("is unchanged when the same events arrive in another order", () => {
    const opened = event("position.opened", AT);
    const filled = event("execution.filled", LATER, {}, "execution");
    const forward = room({ events: [opened, filled], positionInputs: flat() });
    const backward = room({ events: [filled, opened], positionInputs: flat() });
    expect(backward.position).toEqual(forward.position);
    expect(backward.timeline.map((entry) => entry.eventId)).toEqual(forward.timeline.map((entry) => entry.eventId));
    expect(backward.agentPresence).toBe(forward.agentPresence);
  });

  it("does not copy secret payload fields onto the timeline", () => {
    const projected = room({
      events: [event("memory.updated", AT, { note: "desk-secret-value", failureCodes: ["EXIT_AUTHORIZATION_REQUIRED"], decision: "EXIT" })],
    });
    expect(JSON.stringify(projected)).not.toContain("desk-secret-value");
    expect(projected.timeline[0]?.failureCodes).toEqual(["EXIT_AUTHORIZATION_REQUIRED"]);
    expect(projected.review).toBe("NOT_AVAILABLE");
  });

  it("follows presence precedence instead of the latest event", () => {
    expect(room({ job: { jobId: "job-1", status: "PAUSED" }, events: [event("analysis.started", LATER, {}, "agent")] }).agentPresence).toBe("PAUSED");
    expect(room({ occurrence: { occurrenceId: "occ-1", routineId: "routine-1", routineRunId: "run-routine", threadId: "thread-1", providerTurnId: "turn-1", agentRunId: "run-1", domainStatus: "turn_failed" } }).agentPresence).toBe("ERROR");
    expect(room({ execution: { id: "exr-1", state: "SUBMISSION_UNKNOWN", reasons: ["BROKER_UNKNOWN"], brokerCalled: true } }).agentPresence).toBe("CONFIRMING");
    expect(room({
      positionInputs: {
        ...flat(),
        brokerPositionId: "pos-9",
        brokerQuantity: 0.12,
        exitState: "SUBMISSION_ACCEPTED",
      },
      brokerView: { positionId: "pos-9", direction: "LONG", quantity: 0.12 },
      exitExecution: { id: "exr-exit", state: "SUBMISSION_ACCEPTED", brokerCalled: true, closePositionId: "pos-9", quantity: 0.12, reason: null },
    }).agentPresence).toBe("EXIT_WORKING");
    expect(room({ reconciliation: { id: "rec-1", state: "DEGRADED" }, positionInputs: { ...flat(), reconciliationState: "DEGRADED", brokerPositionId: "pos-9", brokerQuantity: 0.12 } }).agentPresence).toBe("DEGRADED");
    expect(room({
      positionInputs: { ...flat(), brokerPositionId: "pos-9", brokerQuantity: 0.12 },
      brokerView: { positionId: "pos-9", direction: "LONG", quantity: 0.12 },
      monitoring: { availability: "RECORD", observedAt: AT, decision: "CONTINUE_MONITORING", failureCodes: [], brokerHealth: "HEALTHY", exitProposalRecorded: false },
    }).agentPresence).toBe("MONITORING");
    expect(room({ approvalOpen: { requestId: "req-1", expiresAt: LATER, decisionId: "dec-1" } }).agentPresence).toBe("AWAITING_APPROVAL");
    expect(room({ decision: decision("LONG") }).agentPresence).toBe("DECISION_READY");
    expect(room({ events: [event("analysis.started", AT, {}, "agent")] }).agentPresence).toBe("ANALYZING");
    expect(room({ events: [event("analysis.started", AT, {}, "agent"), event("analysis.completed", LATER, {}, "agent")] }).agentPresence).not.toBe("ANALYZING");
    expect(room({ events: [event("market.quote.updated", AT, { nextState: "LIVE" })] }).agentPresence).toBe("OBSERVING");
    expect(room({
      market: { provider: "available", observation: { provenance: "STALE", timeframe: "M15", bid: null, ask: null, spread: null, providerTimestamp: AT, receivedAt: AT, ageMs: 90_000, candleCount: 1 } },
    }).agentPresence).toBe("WAITING_FOR_DATA");
    expect(room({ events: [event("agent.tool.started", AT, {}, "runtime")] }).agentPresence).toBe("IDLE");
    expect(room().agentPresence).not.toBe("EXECUTING");
  });

  it("derives nextAction by first match and does not author prose", () => {
    expect(room({ killSwitch: "missing" }).nextAction).toMatchObject({ action: "BLOCKED_KILL_SWITCH_UNKNOWN", blockingCondition: "KILL_SWITCH_UNKNOWN", allowedUserAction: "NONE" });
    expect(room({ killSwitch: kill(true) }).nextAction.action).toBe("BLOCKED_KILL_SWITCH");
    expect(room({ positionInputs: { ...flat(), ambiguous: true }, reconciliation: { id: "rec-1", state: "DESYNCED" } }).nextAction.action).toBe("BLOCKED_DESYNCED");
    expect(room({ job: { jobId: "job-1", status: "PAUSED" } }).nextAction).toMatchObject({ action: "PAUSED", blockingCondition: "PAUSED" });
    expect(room({ approvalOpen: { requestId: "req-1", expiresAt: LATER, decisionId: "dec-1" } }).nextAction.allowedUserActions).toEqual(["APPROVE", "REJECT"]);
    expect(room({ gate: { id: "gate-1", state: "REQUIRES_RISK_REASSESSMENT", reasons: ["REQUIRES_RISK_REASSESSMENT"] } }).nextAction.action).toBe("WAITING_FOR_RISK_REASSESSMENT");
    expect(room({ gate: { id: "gate-1", state: "REQUIRES_POLICY_REASSESSMENT", reasons: ["REQUIRES_POLICY_REASSESSMENT"] } }).nextAction.action).toBe("WAITING_FOR_POLICY_REASSESSMENT");
    expect(room({ gate: { id: "gate-1", state: "REQUIRES_APPROVAL", reasons: ["REQUIRES_APPROVAL"] } }).nextAction.action).toBe("WAITING_FOR_GATE_APPROVAL");
    expect(room({ gate: { id: "gate-1", state: "ELIGIBLE_FOR_EXECUTION", reasons: ["ELIGIBLE"] } }).nextAction.action).toBe("ELIGIBLE_NOT_SUBMITTED");
    expect(room({
      monitoring: { availability: "RECORD", observedAt: AT, decision: "EXIT", failureCodes: ["EXIT_AUTHORIZATION_REQUIRED"], brokerHealth: "HEALTHY", exitProposalRecorded: true },
    }).nextAction).toMatchObject({ action: "EXIT_RECOMMENDED", blockingCondition: "EXIT_AUTHORIZATION_REQUIRED", allowedUserAction: "NONE" });
    expect(room({ decision: decision("NO_TRADE") }).nextAction.action).toBe("NO_TRADE");
    expect(room({ decision: decision("WAIT") }).nextAction.action).toBe("WAIT");
    expect(room({ decision: decision("LONG", "EXPIRED") }).nextAction.action).toBe("EXPIRED");
    expect(room({ decision: decision("LONG", "REJECTED") }).nextAction.action).toBe("REJECTED");
    expect(room({
      market: { provider: "unconfigured", observation: { provenance: "UNAVAILABLE", timeframe: null, bid: null, ask: null, spread: null, providerTimestamp: null, receivedAt: null, ageMs: null, candleCount: 0 } },
    }).nextAction).toMatchObject({ action: "WAITING_FOR_TRUSTED_MARKET", blockingCondition: "MARKET_DATA_UNAVAILABLE" });
    expect(room().nextAction.action).toBe("NO_RECORDED_NEXT_STEP");
    expect(JSON.stringify(room().nextAction)).not.toMatch(/checking the market|Preparing to execute|Waiting for broker/i);
  });

  it("does not attach a conversation when no thread is stored", () => {
    expect(room().attachedConversation.availability).toBe("NOT_AVAILABLE");
    expect(room({
      occurrence: {
        occurrenceId: "occ-1",
        routineId: "routine-1",
        routineRunId: "44444444-4444-4444-8444-444444444444",
        threadId: "thread-1",
        providerTurnId: "turn-1",
        agentRunId: "run-1",
        domainStatus: "observing",
      },
    }).attachedConversation).toMatchObject({ availability: "ATTACHED", threadId: "thread-1", providerTurnId: "turn-1" });
  });

  it("treats two XAUUSD rows as ambiguous and one usable row as that position", () => {
    expect(selectBrokerPosition([
      { positionId: "pos-9", symbol: "XAUUSD", direction: "LONG", volume: 0.12 },
      { positionId: "pos-8", symbol: "XAUUSD", direction: "SHORT", volume: 0.1 },
    ])).toEqual({ ambiguous: true });
    expect(selectBrokerPosition([
      { positionId: "pos-9", symbol: "XAUUSD", direction: "LONG", volume: 0.12 },
    ])).toEqual({ ambiguous: false, positionId: "pos-9", direction: "LONG", quantity: 0.12 });
    expect(selectBrokerPosition([])).toEqual({ ambiguous: false, positionId: null, direction: null, quantity: null });
  });

  it("does not let a monitoring decision.created become a stored decision", () => {
    const projected = room({
      events: [event("decision.created", AT, { decision: "EXIT", nextState: "EXIT" })],
    });
    expect(projected.decision).toBeNull();
    expect(projected.decisionAvailability).toBe("NOT_AVAILABLE");
    expect(projected.agentPresence).not.toBe("DECISION_READY");
    expect(projected.timeline[0]?.monitoringDecision).toBe("EXIT");
  });

  it("loads an unconfigured desk as an unavailable store rather than a flat book", () => {
    const loaded = loadTradingRoom({}, { provenance: "UNAVAILABLE", timeframe: null, candles: [] }, AT);
    expect(loaded.source).toBe("unconfigured");
    expect(loaded.position.availability).toBe("NOT_AVAILABLE");
    expect(loaded.nextAction.action).toBe("STORE_UNAVAILABLE");
    expect(loaded.market.provider).toBe("unconfigured");
    expect(loaded.market.observation?.provenance).toBe("UNAVAILABLE");
    expect(JSON.stringify(loaded)).not.toContain("token");
  });

  it("keeps an emergency.stop event from engaging the kill switch", () => {
    const projected = room({ events: [event("emergency.stop", AT, { nextState: "ENGAGED" })] });
    expect(projected.killSwitch.state).toBe("open");
    expect(projected.timeline[0]?.type).toBe("emergency.stop");
  });
});
