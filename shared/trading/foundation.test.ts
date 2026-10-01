import { describe, expect, it } from "vitest";

import {
  AUTONOMY_NAMES,
  TradingDomainError,
  XAUUSD_INSTRUMENT,
  assertAutonomousOrdersAllowed,
  assertCredentialSlot,
  assertProvenanceForEnvironment,
  assertReplayDataset,
  assertSubmitNotBlockedByKnownSwitch,
  assertXauUsdBoundary,
  autonomyAllowsDirectSubmit,
  continueInEnvironment,
  environmentBinding,
  isTradingEvent,
  orderIntentCannotExecute,
  orderIntentCannotSubmit,
  parseAutonomyState,
  parseDecision,
  parseEnvironmentBinding,
  parseEvidence,
  parseKillSwitchState,
  parseMarketSnapshot,
  parseOrderIntent,
  parsePolicyCheck,
  parseReconciliationState,
  parseRiskCheck,
  parseTradingEnvironment,
  parseTradingEvent,
  parseVersionManifest,
  parseXauUsdContext,
  parseXauUsdInstrument,
  requireAgentRun,
  reviseImmutable,
  tradingEventsAreNotRuntimeEvents,
  TRADING_EVENT_TYPES,
  transitionDecision,
  unknownKillSwitchBlocks,
} from "./index.ts";

const RUN = "run-1";
const AT = "2026-10-01T12:00:00.000Z";
const HASH = "a".repeat(64);

const RUNTIME_EVENT_TYPES = [
  "session.started",
  "session.model-variants",
  "session.exited",
  "turn.started",
  "turn.retrying",
  "turn.completed",
  "turn.wait_started",
  "turn.wait_ended",
  "item.started",
  "item.updated",
  "item.completed",
  "content.delta",
  "request.opened",
  "request.resolved",
  "thread.token-usage.updated",
  "runtime.error",
  "runtime.notice",
] as const;

function decision(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "dec-1",
    agentRunId: RUN,
    environment: "SIMULATOR",
    instrument: "XAUUSD",
    createdAt: AT,
    status: "DRAFT",
    thesis: "No fresh catalyst. Standing aside.",
    contextId: "ctx-1",
    snapshotId: "snap-1",
    evidenceIds: [],
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingInformation: ["London open still ahead"],
    direction: "NO_TRADE",
    targets: [],
    expiry: "2026-10-01T13:00:00.000Z",
    evidenceQuality: "insufficient",
    versionManifestId: "ver-1",
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "snap-1",
    agentRunId: RUN,
    environment: "SIMULATOR",
    instrument: "XAUUSD",
    createdAt: AT,
    capturedAt: AT,
    provider: "simulator",
    providerTimestamp: AT,
    receivedAt: AT,
    provenance: "SIMULATOR",
    candles: [],
    ...overrides,
  };
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "ver-1",
    agentRunId: RUN,
    environment: "SIMULATOR",
    createdAt: AT,
    runtimeVersion: "0.1.92",
    modelProvider: "claude",
    modelId: "claude-sonnet",
    promptVersion: "prompt-1",
    toolCatalogVersion: "tools-0",
    riskVersion: "risk-0",
    policyVersion: "policy-0",
    featureDataVersion: "features-0",
    ...overrides,
  };
}

describe("XAUUSD boundary", () => {
  it("accepts only the XAUUSD literal", () => {
    expect(parseXauUsdInstrument("XAUUSD")).toBe(XAUUSD_INSTRUMENT);
    expect(parseXauUsdInstrument(XAUUSD_INSTRUMENT)).toBe("XAUUSD");
  });

  it("rejects every other instrument before a record can be used", () => {
    for (const instrument of ["EURUSD", "BTCUSD", "XAUUSD ", "xauusd", "GOLD", ""]) {
      expect(() => parseXauUsdInstrument(instrument)).toThrow(TradingDomainError);
      try {
        parseXauUsdInstrument(instrument);
      } catch (error) {
        expect(error).toMatchObject({ code: "instrument_rejected", failClosed: true });
      }
    }
    expect(() => parseMarketSnapshot(snapshot({ instrument: "EURUSD" }))).toThrow(TradingDomainError);
    expect(() => parseDecision(decision({ instrument: "NAS100" }))).toThrow(TradingDomainError);
    expect(() => assertXauUsdBoundary({ instrument: "USDJPY" })).toThrow(TradingDomainError);
    expect(() => assertXauUsdBoundary({ thesis: "missing instrument" })).toThrow(TradingDomainError);
  });
});

describe("environments", () => {
  it("keeps SIMULATOR, PAPER, and LIVE distinct and isolated", () => {
    expect(parseTradingEnvironment("SIMULATOR")).toBe("SIMULATOR");
    expect(parseTradingEnvironment("PAPER")).toBe("PAPER");
    expect(parseTradingEnvironment("LIVE")).toBe("LIVE");
    const simulator = environmentBinding("SIMULATOR");
    const paper = environmentBinding("PAPER");
    const live = environmentBinding("LIVE");
    expect(new Set([simulator.credentialSlot, paper.credentialSlot, live.credentialSlot]).size).toBe(3);
    expect(simulator).toMatchObject({ credentialSlot: "none", liveExecutionEnabled: false, brokerNetworkEnabled: false });
    expect(paper).toMatchObject({ credentialSlot: "paper", liveExecutionEnabled: false, brokerNetworkEnabled: false });
    expect(live).toMatchObject({ credentialSlot: "live", liveExecutionEnabled: false, brokerNetworkEnabled: false });
    expect(() => assertCredentialSlot("SIMULATOR", "live")).toThrow(TradingDomainError);
    expect(() => assertCredentialSlot("PAPER", "live")).toThrow(TradingDomainError);
    expect(() => assertCredentialSlot("LIVE", "paper")).toThrow(TradingDomainError);
  });

  it("rejects invalid environment transitions and live execution flags", () => {
    expect(() => parseTradingEnvironment("demo")).toThrow(TradingDomainError);
    expect(continueInEnvironment("PAPER", "PAPER")).toBe("PAPER");
    expect(() => continueInEnvironment("SIMULATOR", "LIVE")).toThrow(TradingDomainError);
    try {
      continueInEnvironment("SIMULATOR", "PAPER");
    } catch (error) {
      expect(error).toMatchObject({ code: "environment_transition_rejected", failClosed: true });
    }
    expect(() => parseEnvironmentBinding({
      ...environmentBinding("LIVE"),
      liveExecutionEnabled: true,
    })).toThrow(TradingDomainError);
    expect(() => parseEnvironmentBinding({
      ...environmentBinding("SIMULATOR"),
      credentialSlot: "live",
    })).toThrow(TradingDomainError);
  });

  it("rejects silent simulator and live relabeling", () => {
    expect(() => assertProvenanceForEnvironment("LIVE", "SIMULATOR")).toThrow(TradingDomainError);
    expect(() => assertProvenanceForEnvironment("SIMULATOR", "LIVE")).toThrow(TradingDomainError);
    expect(() => assertProvenanceForEnvironment("LIVE", "REPLAY")).toThrow(TradingDomainError);
    expect(() => assertProvenanceForEnvironment("PAPER", "REPLAY")).toThrow(TradingDomainError);
    expect(parseMarketSnapshot(snapshot({ environment: "SIMULATOR", provenance: "REPLAY" })).provenance).toBe("REPLAY");
    expect(() => parseMarketSnapshot(snapshot({ environment: "LIVE", provenance: "SIMULATOR" }))).toThrow(TradingDomainError);
    try {
      parseMarketSnapshot(snapshot({ environment: "PAPER", provenance: "SIMULATOR" }));
    } catch (error) {
      expect(error).toMatchObject({ code: "silent_simulator_fallback", failClosed: true });
    }
    expect(parseMarketSnapshot(snapshot({ environment: "PAPER", provenance: "LIVE" })).provenance).toBe("LIVE");
    expect(parseMarketSnapshot(snapshot()).provenance).toBe("SIMULATOR");
  });
});

describe("decisions", () => {
  it("accepts NO_TRADE and WAIT as complete decisions", () => {
    const noTrade = parseDecision(decision());
    const wait = parseDecision(decision({ id: "dec-wait", direction: "WAIT", thesis: "Waiting for the hour to close." }));
    expect(noTrade.direction).toBe("NO_TRADE");
    expect(wait.direction).toBe("WAIT");
    expect(noTrade.instrument).toBe("XAUUSD");
  });

  it("rejects a decision that is not the canonical record", () => {
    expect(() => parseDecision(decision({ direction: "BUY" }))).toThrow(TradingDomainError);
    expect(() => parseDecision(decision({ thesis: "  " }))).toThrow(TradingDomainError);
    expect(() => parseDecision(decision({ probability: 0.87 }))).toThrow(TradingDomainError);
    try {
      parseDecision(decision({ direction: "SELL" }));
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_decision", failClosed: true });
    }
  });

  it("revises by writing a new record and leaves the original frozen", () => {
    const original = parseDecision(decision());
    expect(Object.isFrozen(original)).toBe(true);
    const revised = reviseImmutable(original, parseDecision(decision({
      id: "dec-2",
      supersedes: original.id,
      thesis: "Still no trade after the revision.",
    })));
    expect(revised.id).not.toBe(original.id);
    expect(revised.supersedes).toBe(original.id);
    expect(original.thesis).toBe("No fresh catalyst. Standing aside.");
    expect(() => reviseImmutable(original, parseDecision(decision({ id: original.id, supersedes: original.id })))).toThrow(TradingDomainError);
    expect(() => {
      (original as { thesis: string }).thesis = "changed";
    }).toThrow(TypeError);
    const moved = transitionDecision(original, "VALIDATING", { id: "dec-3", createdAt: "2026-10-01T12:05:00.000Z" });
    expect(moved.status).toBe("VALIDATING");
    expect(moved.supersedes).toBe(original.id);
    expect(original.status).toBe("DRAFT");
    expect(() => transitionDecision(original, "EXECUTED", { id: "dec-4", createdAt: AT })).toThrow(TradingDomainError);
  });
});

describe("order intents", () => {
  it("cannot represent broker execution or carry credentials", () => {
    const intent = parseOrderIntent({
      schemaVersion: 1,
      kind: "order-intent",
      id: "intent-1",
      agentRunId: RUN,
      environment: "SIMULATOR",
      instrument: "XAUUSD",
      decisionId: "dec-1",
      createdAt: AT,
      direction: "LONG",
      executable: false,
      brokerSubmit: false,
      targets: [],
    });
    expect(intent.executable).toBe(false);
    expect(intent.brokerSubmit).toBe(false);
    expect(orderIntentCannotExecute).toBe(true);
    expect(orderIntentCannotSubmit).toBe(true);
    expect("submit" in intent).toBe(false);
    expect(() => parseOrderIntent({ ...intent, executable: true })).toThrow(TradingDomainError);
    try {
      parseOrderIntent({ ...intent, brokerSubmit: true });
    } catch (error) {
      expect(error).toMatchObject({ code: "order_intent_not_executable", failClosed: true });
    }
    expect(() => parseOrderIntent({ ...intent, apiKey: "secret" })).toThrow(TradingDomainError);
    expect(() => parseOrderIntent({ ...intent, direction: "NO_TRADE" })).toThrow(TradingDomainError);
    expect(() => parseOrderIntent({ ...intent, direction: "WAIT" })).toThrow(TradingDomainError);
    expect(() => parseOrderIntent({ ...intent, instrument: "EURUSD" })).toThrow(TradingDomainError);
  });
});

describe("evidence", () => {
  it("is external and untrusted", () => {
    const evidence = parseEvidence({
      schemaVersion: 1,
      id: "ev-1",
      agentRunId: RUN,
      environment: "SIMULATOR",
      createdAt: AT,
      trust: "external",
      untrusted: true,
      kind: "news",
      receivedAt: AT,
      contentHash: HASH,
      excerpt: "Headline text is data.",
    });
    expect(evidence.trust).toBe("external");
    expect(evidence.untrusted).toBe(true);
    expect(() => parseEvidence({ ...evidence, trust: "system" })).toThrow(TradingDomainError);
    expect(() => parseEvidence({ ...evidence, untrusted: false })).toThrow(TradingDomainError);
    try {
      parseEvidence({ ...evidence, trust: "instruction" });
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_evidence", failClosed: true });
    }
  });
});

describe("agent_run_id and version manifest", () => {
  it("requires agent_run_id on trading records and events", () => {
    const { agentRunId: _ignored, ...missing } = decision();
    expect(() => parseDecision(missing)).toThrow(TradingDomainError);
    try {
      parseDecision(missing);
    } catch (error) {
      expect(error).toMatchObject({ code: "agent_run_required", failClosed: true });
    }
    expect(() => parseMarketSnapshot(snapshot({ agentRunId: "" }))).toThrow(TradingDomainError);
    expect(() => parseTradingEvent({
      schemaVersion: 1,
      eventId: "evt-1",
      type: "decision.created",
      source: "trading-domain",
      at: AT,
      correlationId: "corr-1",
      environment: "SIMULATOR",
      instrument: "XAUUSD",
      actor: "foundation",
    })).toThrow(TradingDomainError);
    const parsed = parseDecision(decision());
    expect(requireAgentRun(RUN, parsed)).toBe(parsed);
    expect(() => requireAgentRun("other-run", parsed)).toThrow(TradingDomainError);
  });

  it("validates the version manifest and requires a dataset for replay", () => {
    const parsed = parseVersionManifest(manifest());
    expect(parsed.modelProvider).toBe("claude");
    expect(parsed.datasetVersion).toBeUndefined();
    expect(() => parseVersionManifest(manifest({ promptVersion: "  " }))).toThrow(TradingDomainError);
    expect(() => parseVersionManifest(manifest({ riskVersion: "" }))).toThrow(TradingDomainError);
    expect(() => parseVersionManifest(manifest({ datasetVersion: "" }))).toThrow(TradingDomainError);
    expect(() => assertReplayDataset(parsed)).toThrow(TradingDomainError);
    const replay = parseVersionManifest(manifest({ datasetVersion: "xauusd-2024-01" }));
    expect(assertReplayDataset(replay)).toBeUndefined();
    expect(replay.datasetVersion).toBe("xauusd-2024-01");
  });
});

describe("trading events", () => {
  it("stay outside the harness RuntimeEvent union", () => {
    expect(tradingEventsAreNotRuntimeEvents).toBe(true);
    for (const type of TRADING_EVENT_TYPES) {
      expect(RUNTIME_EVENT_TYPES).not.toContain(type);
    }
    const event = parseTradingEvent({
      schemaVersion: 1,
      eventId: "evt-1",
      type: "agent.tool.completed",
      source: "trading-domain",
      at: AT,
      agentRunId: RUN,
      correlationId: "corr-1",
      environment: "SIMULATOR",
      instrument: "XAUUSD",
      actor: "foundation",
      runtimeEventId: "runtime-evt-1",
      runtimeTurnId: "turn-1",
    });
    expect(isTradingEvent(event)).toBe(true);
    expect(event.runtimeEventId).toBe("runtime-evt-1");
    expect(isTradingEvent({
      type: "turn.started",
      eventId: "e",
      provider: "claudeAgent",
      threadId: "t",
      createdAt: AT,
    })).toBe(false);
    expect(() => parseTradingEvent({ ...event, type: "turn.started" })).toThrow(TradingDomainError);
    expect(() => parseTradingEvent({ ...event, provider: "claudeAgent" })).toThrow(TradingDomainError);
  });
});

describe("safety-critical unknown states", () => {
  it("fails closed for reconciliation, the kill switch, and unimplemented passes", () => {
    expect(parseReconciliationState("RECONCILED")).toBe("RECONCILED");
    expect(parseReconciliationState("DEGRADED")).toBe("DEGRADED");
    expect(() => assertAutonomousOrdersAllowed("RECONCILED")).not.toThrow();
    expect(() => assertAutonomousOrdersAllowed("DEGRADED")).not.toThrow();
    for (const state of ["DESYNCED", "UNKNOWN"] as const) {
      expect(() => assertAutonomousOrdersAllowed(state)).toThrow(TradingDomainError);
    }
    expect(() => parseReconciliationState("healthy")).toThrow(TradingDomainError);
    try {
      parseReconciliationState("banana");
    } catch (error) {
      expect(error).toMatchObject({ code: "reconciliation_unknown", failClosed: true });
    }

    const engaged = parseKillSwitchState({
      schemaVersion: 1,
      environment: "LIVE",
      engaged: true,
      agentRunId: RUN,
      updatedAt: AT,
      source: "operator",
    });
    expect(() => assertSubmitNotBlockedByKnownSwitch(engaged)).toThrow(TradingDomainError);
    expect(() => parseKillSwitchState({ ...engaged, engaged: "unknown" })).toThrow(TradingDomainError);
    expect(() => parseKillSwitchState(undefined)).toThrow(TradingDomainError);
    expect(unknownKillSwitchBlocks()).toBe(true);

    const unavailable = parseRiskCheck({
      schemaVersion: 1,
      id: "risk-1",
      agentRunId: RUN,
      environment: "SIMULATOR",
      instrument: "XAUUSD",
      decisionId: "dec-1",
      snapshotId: "snap-1",
      versionManifestId: "ver-1",
      status: "UNAVAILABLE",
      failClosed: true,
      reasons: ["risk engine is not implemented"],
      createdAt: AT,
    });
    expect(unavailable.failClosed).toBe(true);
    expect(() => parseRiskCheck({ ...unavailable, status: "UNAVAILABLE", failClosed: false })).toThrow(TradingDomainError);
    expect(() => parsePolicyCheck({ ...unavailable, id: "policy-1", status: "PASSED", failClosed: true })).toThrow(TradingDomainError);

    expect(autonomyAllowsDirectSubmit(5)).toBe(false);
    expect(parseAutonomyState({
      schemaVersion: 1,
      environment: "SIMULATOR",
      level: 4,
      name: "EXECUTE_UNDER_POLICY",
      agentRunId: RUN,
      updatedAt: AT,
    }).name).toBe(AUTONOMY_NAMES[4]);
    expect(() => parseAutonomyState({
      schemaVersion: 1,
      environment: "SIMULATOR",
      level: 4,
      name: "OBSERVE",
      agentRunId: RUN,
      updatedAt: AT,
    })).toThrow(TradingDomainError);
  });
});

describe("context", () => {
  it("binds context to XAUUSD, a snapshot, and the active run", () => {
    const context = parseXauUsdContext({
      schemaVersion: 1,
      id: "ctx-1",
      agentRunId: RUN,
      environment: "SIMULATOR",
      instrument: "XAUUSD",
      snapshotId: "snap-1",
      evidenceIds: ["ev-1"],
      versionManifestId: "ver-1",
      asOf: AT,
      provenance: "SIMULATOR",
      createdAt: AT,
    });
    expect(requireAgentRun(RUN, context).instrument).toBe("XAUUSD");
    expect(() => parseXauUsdContext({ ...context, instrument: "XAGUSD" })).toThrow(TradingDomainError);
    expect(() => parseXauUsdContext({ ...context, environment: "LIVE", provenance: "SIMULATOR" })).toThrow(TradingDomainError);
  });
});
