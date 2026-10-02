import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { AUTONOMY_NAMES, parseAutonomyState, type AutonomyLevel } from "../../../shared/trading/autonomy.ts";
import { parseDecision, type Decision, type DecisionDirection } from "../../../shared/trading/decision.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { parseTradingEvent, type TradingEvent } from "../../../shared/trading/events.ts";
import { parseKillSwitchState, type KillSwitchState } from "../../../shared/trading/kill-switch.ts";
import { parseOrderIntent, type OrderIntentDirection } from "../../../shared/trading/order-intent.ts";
import { assessApproval } from "../approval/assess.ts";
import type { ApprovalDecision } from "../approval/result.ts";
import type { ApprovalFact } from "../approval/assess.ts";
import { APPROVAL_ENGINE_VERSION } from "../approval/config.ts";
import { submitAuthorizedExecution, type ExecutionSubmitInput } from "../execution/submit.ts";
import { createMemoryExecutionLedger, type ExecutionAttemptRecord } from "../execution/ledger.ts";
import { EXECUTION_ENGINE_VERSION } from "../execution/result.ts";
import { evaluateFireTimeGate, type FireTimeGateInput } from "../gate/evaluate.ts";
import { GATE_ENGINE_VERSION } from "../gate/config.ts";
import type { GateDecision } from "../gate/result.ts";
import { derivePositionLifecycle } from "../lifecycle/position.ts";
import { runMonitoringCycle, type MonitoringCycleInput } from "../monitoring/cycle.ts";
import type { TradingOccurrence } from "../persistence/occurrences.ts";
import { canonicalJson } from "../replay/hash.ts";
import { evaluateXauUsdProposal, type ProposalInput } from "../proposal/evaluate.ts";
import { buildBrokerSnapshot, type BrokerAccountSnapshot } from "../reconciliation/snapshot.ts";
import { openTradingStore, type TradingStore } from "../persistence/store.ts";
import { ROOM_PRESENCE } from "./room.ts";
import { loadTradingRoom } from "./load.ts";

const AT = "2026-08-15T14:30:00.000Z";
const LATER = "2026-08-15T14:31:00.000Z";
const ROUTINE = "routine-foundation";
const RUN = "routine-run-foundation";
const THREAD = "thread-foundation";
const TURN = "turn-foundation";
const BINDING = "binding-secret-value";
const CLIENT = "client-secret-value";
const dirs: string[] = [];
const stores: TradingStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // The test already closed this store.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(): { path: string; env: Record<string, string>; store: TradingStore } {
  const dir = mkdtempSync(join(tmpdir(), "xauusd-foundation-"));
  dirs.push(dir);
  const path = join(dir, "trading.db");
  const store = openTradingStore({ path, environment: "PAPER" });
  stores.push(store);
  return {
    path,
    store,
    env: { OMB_XAUUSD_STORE_PATH: path, OMB_XAUUSD_ENVIRONMENT: "PAPER" },
  };
}

function roomOf(env: Record<string, string>) {
  return loadTradingRoom(env, { provenance: "LIVE", timeframe: "M15", candles: [] }, AT);
}

function seed(store: TradingStore, runId = RUN): TradingOccurrence {
  const occurrence = store.occurrences.insertRoutineOccurrence({
    routineId: ROUTINE,
    routineRunId: runId,
    threadId: THREAD,
    environment: "PAPER",
    startedAt: AT,
  });
  store.occurrences.attachProviderTurn({
    routineId: ROUTINE,
    routineRunId: runId,
    threadId: THREAD,
    providerTurnId: TURN,
  });
  store.appendEvents([evidence(occurrence.agentRunId, occurrence.occurrenceId, "analysis.completed", AT)]);
  return store.occurrences.readByOccurrenceId(occurrence.occurrenceId) ?? occurrence;
}

function evidence(agentRunId: string, occurrenceId: string, type: TradingEvent["type"], at: string, extra: Record<string, unknown> = {}): TradingEvent {
  return parseTradingEvent({
    schemaVersion: 1,
    eventId: `evt-${type}-${at}-${occurrenceId}`,
    type,
    source: "trading-domain",
    at,
    agentRunId,
    correlationId: occurrenceId,
    environment: "PAPER",
    instrument: "XAUUSD",
    actor: "xauusd-monitoring",
    payload: { occurrenceId, ...extra },
  });
}

function storedSwitch(agentRunId: string, engaged: boolean, environment: "PAPER" | "LIVE" = "PAPER"): KillSwitchState {
  return parseKillSwitchState({
    schemaVersion: 1,
    environment,
    engaged,
    agentRunId,
    updatedAt: AT,
    source: "operator",
  });
}

function book(positions: BrokerAccountSnapshot["positions"]): BrokerAccountSnapshot {
  return buildBrokerSnapshot({
    bindingId: BINDING,
    environment: "PAPER",
    observedAt: AT,
    brokerCallSkipped: false,
    channels: { orders: "read", deals: "read", positions: "read", account: "read" },
    source: "injected-reader",
    orders: [],
    deals: [],
    positions,
    account: { balance: 10000, equity: 10000, margin: 0, currency: "USD" },
  });
}

function gold(volume = 0.12) {
  return { positionId: "pos-9", symbol: "XAUUSD", volume, direction: "LONG" as const };
}

function citeBook(
  store: TradingStore,
  occurrence: TradingOccurrence,
  positions: BrokerAccountSnapshot["positions"],
  entry: "SUBMISSION_ACCEPTED" | "FILL_REPORTED" = "SUBMISSION_ACCEPTED",
): BrokerAccountSnapshot {
  store.occurrences.attachExecutionReceipt({
    occurrenceId: occurrence.occurrenceId,
    agentRunId: occurrence.agentRunId,
    environment: "PAPER",
    executionRequestId: "exr.entry-1",
    executionState: entry,
    failureCode: null,
    domainStatus: null,
  });
  const snapshot = book(positions);
  store.saveSnapshot(snapshot);
  store.occurrences.attachReconciliationReceipt({
    occurrenceId: occurrence.occurrenceId,
    agentRunId: occurrence.agentRunId,
    environment: "PAPER",
    executionRequestId: "exr.entry-1",
    reconciliationRunId: "rec.foundation-1",
    reconciliationState: "RECONCILED",
    reconciledAt: AT,
    snapshotId: snapshot.snapshotId,
  });
  return snapshot;
}

function rewrite(path: string, sql: string, ...params: (string | number | null)[]): void {
  const db = new DatabaseSync(path);
  db.prepare(sql).run(...params);
  db.close();
}

function decision(agentRunId: string, direction: DecisionDirection = "LONG", thesis = "FROM-RECORD"): Decision {
  return parseDecision({
    schemaVersion: 1,
    id: "dec-1",
    agentRunId,
    environment: "PAPER",
    instrument: "XAUUSD",
    createdAt: AT,
    status: "DRAFT",
    thesis,
    contextId: "ctx-1",
    snapshotId: "snap-1",
    evidenceIds: [],
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingInformation: [],
    direction,
    stop: 4624.5,
    targets: [4648],
    expiry: "2026-08-15T18:00:00.000Z",
    evidenceQuality: "insufficient",
    versionManifestId: "ver-1",
  });
}

function intent(agentRunId: string, direction: OrderIntentDirection = "LONG") {
  return parseOrderIntent({
    schemaVersion: 1,
    kind: "order-intent",
    id: "intent-1",
    agentRunId,
    environment: "PAPER",
    instrument: "XAUUSD",
    decisionId: "dec-1",
    createdAt: AT,
    direction,
    executable: false,
    brokerSubmit: false,
    entry: 4632.5,
    stop: 4624.5,
    targets: [4648],
  });
}

function historicalGate(agentRunId: string): GateDecision {
  return {
    schemaVersion: GATE_ENGINE_VERSION,
    id: "gate-hist",
    state: "BLOCKED",
    reasons: ["KILL_SWITCH_ENGAGED"],
    binding: null,
    decisionId: "dec-1",
    orderIntentId: "intent-1",
    riskDecisionId: null,
    policyDecisionId: null,
    approvalId: null,
    environment: "PAPER",
    provenance: "LIVE",
    gateConfigVersion: "gate-v1",
    evaluatedAt: AT,
    agentRunId,
    evaluationRunId: null,
    liveExecutionEnabled: false,
    orderIntentExecutable: false,
    orderIntentBrokerSubmit: false,
    events: [],
  };
}

function approvalDecision(agentRunId: string, state: ApprovalDecision["state"]): ApprovalDecision {
  return {
    schemaVersion: APPROVAL_ENGINE_VERSION,
    id: "apd-settled",
    state,
    reasons: [state === "APPROVED" ? "APPROVAL_GRANTED" : state === "REJECTED" ? "APPROVAL_DENIED" : "INVALID_INPUT"],
    binding: "bind-settled",
    humanApprovalId: "human-1",
    approvalRequestId: "req-settled",
    decisionId: "dec-1",
    orderIntentId: "intent-1",
    riskDecisionId: "risk-1",
    policyDecisionId: "policy-1",
    environment: "PAPER",
    provenance: "LIVE",
    autonomyLevel: null,
    configId: null,
    configVersion: "approval-v1",
    agentRunId,
    evaluationRunId: null,
    liveExecutionEnabled: false,
    events: [],
  };
}

function approvalFact(approved: boolean): ApprovalFact {
  return {
    approvalId: "apd-settled",
    approvalRequestId: "req-settled",
    approved,
    approvedBy: "operator-1",
    approvedAt: AT,
    decisionId: "dec-1",
    orderIntentId: "intent-1",
    riskDecisionId: "risk-1",
    policyDecisionId: "policy-1",
    environment: "PAPER",
    instrument: "XAUUSD",
    approvalPolicyVersion: "approval-v1",
    proposalBinding: "bind-settled",
  };
}

function openApproval(store: TradingStore, occurrence: TradingOccurrence, requestId: string) {
  store.approvals.insertOpen({
    requestId,
    occurrenceId: occurrence.occurrenceId,
    agentRunId: occurrence.agentRunId,
    decisionId: "dec-1",
    orderIntentId: "intent-1",
    riskDecisionId: "risk-1",
    policyDecisionId: "policy-1",
    proposalBinding: `bind-${requestId}`,
    environment: "PAPER",
    requesterId: "operator-1",
    openedAt: AT,
    expiresAt: "2026-08-15T15:30:00.000Z",
    maxAgeMs: 60_000,
    assessmentJson: JSON.stringify({
      config: { version: "approval-v1" },
      thesis: "FROM-ASSESSMENT",
      direction: "SHORT",
    }),
  });
}

describe("authoritative kill switch", () => {
  it("projects a missing switch as unknown and blocks execution", async () => {
    const { path, env, store } = harness();
    const occurrence = seed(store);
    const room = roomOf(env);
    expect(room.killSwitch.state).toBe("unknown");
    expect(room.nextAction.action).toBe("BLOCKED_KILL_SWITCH_UNKNOWN");
    store.killSwitches.write(storedSwitch(occurrence.agentRunId, false));
    const execution = executionInput(occurrence.agentRunId, store, storedSwitch(occurrence.agentRunId, false));
    expect(execution.gate.state).toBe("ELIGIBLE_FOR_EXECUTION");
    const db = new DatabaseSync(path);
    db.prepare("DELETE FROM kill_switch_state").run();
    db.close();
    const blocked = await submitAuthorizedExecution(execution);
    expect(blocked.reasons).toEqual(["KILL_SWITCH_UNKNOWN"]);
    expect(blocked.brokerCalled).toBe(false);
  });

  it("projects a malformed switch as unknown", () => {
    const { path, env, store } = harness();
    const occurrence = seed(store);
    store.killSwitches.write(storedSwitch(occurrence.agentRunId, false));
    store.close();
    rewrite(path, "UPDATE kill_switch_state SET payload_json = '{' WHERE agent_run_id = ?", occurrence.agentRunId);
    const room = roomOf(env);
    expect(room.killSwitch.state).toBe("unknown");
    expect(room.nextAction.action).toBe("BLOCKED_KILL_SWITCH_UNKNOWN");
  });

  it("rejects a payload for the wrong environment or the wrong agent", async () => {
    const { path, env, store } = harness();
    const occurrence = seed(store);
    store.killSwitches.write(storedSwitch(occurrence.agentRunId, false));
    const liveExecution = executionInput(occurrence.agentRunId, store, storedSwitch(occurrence.agentRunId, false));
    expect(liveExecution.gate.state).toBe("ELIGIBLE_FOR_EXECUTION");
    rewrite(
      path,
      "UPDATE kill_switch_state SET payload_json = ? WHERE agent_run_id = ?",
      canonicalJson(storedSwitch(occurrence.agentRunId, false, "LIVE")),
      occurrence.agentRunId,
    );
    const wrongEnvironment = roomOf(env);
    expect(wrongEnvironment.killSwitch.state).toBe("unknown");
    expect(wrongEnvironment.nextAction.action).toBe("BLOCKED_KILL_SWITCH_UNKNOWN");
    const wrongEnvironmentSubmit = await submitAuthorizedExecution(liveExecution);
    expect(wrongEnvironmentSubmit.reasons).toEqual(["KILL_SWITCH_UNKNOWN"]);
    expect(wrongEnvironmentSubmit.brokerCalled).toBe(false);
    store.killSwitches.write(storedSwitch(occurrence.agentRunId, false));
    const execution = executionInput(occurrence.agentRunId, store, storedSwitch(occurrence.agentRunId, false));
    expect(execution.gate.state).toBe("ELIGIBLE_FOR_EXECUTION");
    rewrite(
      path,
      "UPDATE kill_switch_state SET payload_json = ? WHERE agent_run_id = ?",
      canonicalJson(storedSwitch("run.other-agent", false)),
      occurrence.agentRunId,
    );
    const wrongAgent = roomOf(env);
    expect(wrongAgent.killSwitch.state).toBe("unknown");
    const blocked = await submitAuthorizedExecution(execution);
    expect(blocked.reasons).toEqual(["KILL_SWITCH_UNKNOWN"]);
    expect(blocked.brokerCalled).toBe(false);
  });

  it("blocks an engaged switch and lets the same open row continue", async () => {
    const { env, store } = harness();
    const occurrence = seed(store);
    store.killSwitches.write(storedSwitch(occurrence.agentRunId, false));
    const execution = executionInput(occurrence.agentRunId, store, storedSwitch(occurrence.agentRunId, false));
    expect(execution.gate.state).toBe("ELIGIBLE_FOR_EXECUTION");
    store.killSwitches.write(storedSwitch(occurrence.agentRunId, true));
    const engaged = roomOf(env);
    expect(engaged.killSwitch.state).toBe("engaged");
    expect(engaged.nextAction.action).toBe("BLOCKED_KILL_SWITCH");
    const stopped = await submitAuthorizedExecution(execution);
    expect(stopped.reasons).toEqual(["KILL_SWITCH_ENGAGED"]);
    expect(stopped.brokerCalled).toBe(false);
    store.killSwitches.write(storedSwitch(occurrence.agentRunId, false));
    const open = roomOf(env);
    expect(open.killSwitch.state).toBe("open");
    expect(open.nextAction.action).not.toBe("BLOCKED_KILL_SWITCH");
    expect(open.nextAction.action).not.toBe("BLOCKED_KILL_SWITCH_UNKNOWN");
    const continued = await submitAuthorizedExecution(executionInput(occurrence.agentRunId, store, null));
    expect(continued.reasons).not.toContain("KILL_SWITCH_UNKNOWN");
    expect(continued.reasons).not.toContain("KILL_SWITCH_ENGAGED");
  });

  it("keeps a historical eligible gate visible after the switch engages and still refuses the broker", async () => {
    const { env, store } = harness();
    const occurrence = seed(store);
    store.killSwitches.write(storedSwitch(occurrence.agentRunId, false));
    const execution = executionInput(occurrence.agentRunId, store, storedSwitch(occurrence.agentRunId, true));
    expect(execution.gate.state).toBe("ELIGIBLE_FOR_EXECUTION");
    if (execution.decision === null || execution.orderIntent === null) throw new Error("execution facts missing");
    store.occurrences.attachAuthoritativeRecords({
      occurrenceId: occurrence.occurrenceId,
      agentRunId: occurrence.agentRunId,
      environment: "PAPER",
      decisionId: execution.decision.id,
      orderIntentId: execution.orderIntent.id,
      riskDecisionId: execution.risk.id,
      policyDecisionId: execution.policy.id,
      approvalId: null,
      proposalBindingHash: null,
      failureCode: null,
      gateDecisionId: execution.gate.id,
      decision: execution.decision,
      risk: execution.risk,
      policy: execution.policy,
      gate: execution.gate,
    });
    store.killSwitches.write(storedSwitch(occurrence.agentRunId, true));
    const room = roomOf(env);
    expect(room.gate).toMatchObject({ id: execution.gate.id, state: "ELIGIBLE_FOR_EXECUTION" });
    expect(room.killSwitch.state).toBe("engaged");
    const blocked = await submitAuthorizedExecution(execution);
    expect(blocked.reasons).toEqual(["KILL_SWITCH_ENGAGED"]);
    expect(blocked.brokerCalled).toBe(false);
  });

  it("does not treat emergency.stop as the kill switch", () => {
    const { env, store } = harness();
    const occurrence = seed(store);
    store.killSwitches.write(storedSwitch(occurrence.agentRunId, false));
    store.appendEvents([evidence(occurrence.agentRunId, occurrence.occurrenceId, "emergency.stop", LATER, { nextState: "ENGAGED" })]);
    const room = roomOf(env);
    expect(room.killSwitch.state).toBe("open");
    expect(room.timeline.some((entry) => entry.type === "emergency.stop")).toBe(true);
    expect(room.nextAction.action).not.toBe("BLOCKED_KILL_SWITCH");
  });
});

describe("sealed decision chain", () => {
  it("persists decision, risk, policy, and the historical gate in one citation", () => {
    const { env, store } = harness();
    const occurrence = seed(store);
    store.killSwitches.write(storedSwitch(occurrence.agentRunId, false));
    const made = decision(occurrence.agentRunId);
    const proposed = evaluateXauUsdProposal(proposalInput(occurrence.agentRunId, made));
    if (proposed.policy === null) throw new Error("policy missing");
    const gate = historicalGate(occurrence.agentRunId);
    store.occurrences.attachAuthoritativeRecords({
      occurrenceId: occurrence.occurrenceId,
      agentRunId: occurrence.agentRunId,
      environment: "PAPER",
      decisionId: made.id,
      orderIntentId: "intent-1",
      riskDecisionId: proposed.risk.id,
      policyDecisionId: proposed.policy.id,
      approvalId: null,
      proposalBindingHash: null,
      failureCode: null,
      gateDecisionId: gate.id,
      decision: made,
      risk: proposed.risk,
      policy: proposed.policy,
      gate,
    });
    const room = roomOf(env);
    expect(room.decision?.id).toBe(made.id);
    expect(room.decision?.thesis).toBe("FROM-RECORD");
    expect(room.decisionAvailability).toBe("RECORD");
    expect(room.risk?.id).toBe(proposed.risk.id);
    expect(room.policy?.id).toBe(proposed.policy.id);
    expect(room.gate).toMatchObject({ id: gate.id, state: "BLOCKED", reasons: ["KILL_SWITCH_ENGAGED"] });
    expect(room.killSwitch.state).toBe("open");
  });

  it("rolls back a citation when the sealed body is rejected", () => {
    const { store } = harness();
    const occurrence = seed(store);
    const made = decision(occurrence.agentRunId);
    const proposed = evaluateXauUsdProposal(proposalInput(occurrence.agentRunId, made));
    expect(() => store.occurrences.attachAuthoritativeRecords({
      occurrenceId: occurrence.occurrenceId,
      agentRunId: occurrence.agentRunId,
      environment: "PAPER",
      decisionId: made.id,
      orderIntentId: "intent-1",
      riskDecisionId: proposed.risk.id,
      policyDecisionId: null,
      approvalId: null,
      proposalBindingHash: null,
      failureCode: null,
      gateDecisionId: null,
      decision: made,
      risk: { ...proposed.risk, token: "must-not-persist" } as typeof proposed.risk,
      policy: null,
      gate: null,
    })).toThrow(TradingDomainError);
    expect(store.artifacts.readDecision(made.id)).toBe("missing");
    expect(store.occurrences.readByOccurrenceId(occurrence.occurrenceId)?.decisionId).toBeNull();
  });

  it("rolls back every sealed body when the citation update changes no row", () => {
    const { path, store } = harness();
    const occurrence = seed(store);
    const made = decision(occurrence.agentRunId);
    const proposed = evaluateXauUsdProposal(proposalInput(occurrence.agentRunId, made));
    const policy = proposed.policy;
    if (policy === null) throw new Error("policy missing");
    const gate = historicalGate(occurrence.agentRunId);
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TRIGGER citation_zero BEFORE UPDATE ON trading_occurrences
      BEGIN
        SELECT RAISE(IGNORE);
      END
    `);
    db.close();
    expect(() => store.occurrences.attachAuthoritativeRecords({
      occurrenceId: occurrence.occurrenceId,
      agentRunId: occurrence.agentRunId,
      environment: "PAPER",
      decisionId: made.id,
      orderIntentId: "intent-1",
      riskDecisionId: proposed.risk.id,
      policyDecisionId: policy.id,
      approvalId: null,
      proposalBindingHash: null,
      failureCode: null,
      gateDecisionId: gate.id,
      decision: made,
      risk: proposed.risk,
      policy,
      gate,
    })).toThrow(TradingDomainError);
    expect(store.artifacts.readDecision(made.id)).toBe("missing");
    expect(store.artifacts.readRisk(proposed.risk.id)).toBe("missing");
    expect(store.artifacts.readPolicy(policy.id)).toBe("missing");
    expect(store.artifacts.readGate(gate.id)).toBe("missing");
    const row = store.occurrences.readByOccurrenceId(occurrence.occurrenceId);
    expect(row?.decisionId).toBeNull();
    expect(row?.riskDecisionId).toBeNull();
    expect(row?.policyDecisionId).toBeNull();
    expect(row?.gateDecisionId).toBeNull();
  });

  it("rolls back a conflicting sealed revision and keeps the original body", () => {
    const { store } = harness();
    const occurrence = seed(store);
    const made = decision(occurrence.agentRunId);
    const proposed = evaluateXauUsdProposal(proposalInput(occurrence.agentRunId, made));
    const policy = proposed.policy;
    if (policy === null) throw new Error("policy missing");
    const gate = historicalGate(occurrence.agentRunId);
    const citation = {
      occurrenceId: occurrence.occurrenceId,
      agentRunId: occurrence.agentRunId,
      environment: "PAPER" as const,
      decisionId: made.id,
      orderIntentId: "intent-1",
      riskDecisionId: proposed.risk.id,
      policyDecisionId: policy.id,
      approvalId: null,
      proposalBindingHash: null,
      failureCode: null,
      gateDecisionId: gate.id,
      decision: made,
      risk: proposed.risk,
      policy,
      gate,
    };
    store.occurrences.attachAuthoritativeRecords(citation);
    expect(() => store.occurrences.attachAuthoritativeRecords({
      ...citation,
      decision: decision(occurrence.agentRunId, "LONG", "REVISED"),
    })).toThrow(TradingDomainError);
    expect(store.artifacts.readDecision(made.id)).toMatchObject({ thesis: "FROM-RECORD" });
    expect(store.occurrences.readByOccurrenceId(occurrence.occurrenceId)?.decisionId).toBe(made.id);
    expect(store.occurrences.readByOccurrenceId(occurrence.occurrenceId)?.gateDecisionId).toBe(gate.id);
  });

  it("fails closed when a cited record is missing", () => {
    const { env, store } = harness();
    const occurrence = seed(store);
    store.killSwitches.write(storedSwitch(occurrence.agentRunId, false));
    store.occurrences.attachEligibilityReferences({
      occurrenceId: occurrence.occurrenceId,
      agentRunId: occurrence.agentRunId,
      environment: "PAPER",
      decisionId: "dec-missing",
      orderIntentId: null,
      riskDecisionId: null,
      policyDecisionId: null,
      approvalId: null,
      proposalBindingHash: null,
      failureCode: null,
    });
    const room = roomOf(env);
    expect(room.decision).toBeNull();
    expect(room.nextAction).toMatchObject({
      action: "WAITING_FOR_RECONCILIATION",
      reason: "CITED_RECORD_MISSING",
      blockingCondition: "RECONCILIATION_UNKNOWN",
    });
    expect(room.nextAction.action).not.toBe("ELIGIBLE_NOT_SUBMITTED");
    expect(room.nextAction.action).not.toBe("NO_RECORDED_NEXT_STEP");
  });
});

describe("approval projection", () => {
  it("reads the open approval for the occurrence and ignores assessment text", () => {
    const { env, store } = harness();
    const occurrence = seed(store);
    store.killSwitches.write(storedSwitch(occurrence.agentRunId, false));
    citeBook(store, occurrence, []);
    openApproval(store, occurrence, "req-open");
    const room = roomOf(env);
    expect(room.approval.open?.requestId).toBe("req-open");
    expect(room.approval.decision).toBeNull();
    expect(room.decision).toBeNull();
    expect(JSON.stringify(room)).not.toContain("FROM-ASSESSMENT");
    expect(room.nextAction.action).toBe("WAITING_FOR_APPROVAL");
  });

  it("loads a settled rejection and an invalid approval without using assessment_json", () => {
    const { path, env, store } = harness();
    const occurrence = seed(store);
    store.killSwitches.write(storedSwitch(occurrence.agentRunId, false));
    citeBook(store, occurrence, []);
    openApproval(store, occurrence, "req-settled");
    store.approvals.commitResolution({
      requestId: "req-settled",
      fingerprint: "fp-settled",
      decision: approvalDecision(occurrence.agentRunId, "REJECTED"),
      fact: approvalFact(false),
      proposalBinding: "bind-req-settled",
    });
    const rejected = roomOf(env);
    expect(rejected.approval.open).toBeNull();
    expect(rejected.approval.decision).toMatchObject({ id: "apd-settled", state: "REJECTED" });
    expect(rejected.approval.fact).toEqual({ approvalId: "apd-settled", approved: false, approvedAt: AT });
    expect(rejected.decision?.thesis).not.toBe("FROM-ASSESSMENT");
    expect(JSON.stringify(rejected)).not.toContain("FROM-ASSESSMENT");
    store.close();
    rewrite(path, "UPDATE trading_approval_transports SET decision_json = '{', fact_json = '{' WHERE request_id = ?", "req-settled");
    const invalid = roomOf(env);
    expect(invalid.approval.decision).toBeNull();
    expect(invalid.approval.fact).toBeNull();
    expect(invalid.nextAction.reason).toBe("CITED_RECORD_MISSING");
  });
});

describe("monitoring cycle", () => {
  it("persists the cycle with its events and projects that record", () => {
    const { env, store } = harness();
    const occurrence = seed(store);
    store.killSwitches.write(storedSwitch(occurrence.agentRunId, false));
    const snapshot = citeBook(store, occurrence, [gold()]);
    const before = store.readEvents().length;
    const cycle = runMonitoringCycle(cycleInput(store, occurrence.occurrenceId, snapshot, "EXIT"));
    expect(store.readEvents().length).toBeGreaterThan(before);
    const stored = store.monitoringCycles.readLatest(occurrence.occurrenceId);
    expect(stored).not.toBe("missing");
    expect(stored).not.toBe("malformed");
    const room = roomOf(env);
    expect(room.monitoring.availability).toBe("RECORD");
    expect(room.monitoring.observedAt).toBe(AT);
    expect(room.monitoring.decision).toBe(cycle.decision);
    expect(room.monitoring.brokerHealth).toBe(cycle.account.brokerHealth);
    expect(room.monitoring.reconciliationState).toBe("RECONCILED");
    expect(room.exit.proposal).toBe("RECORDED");
    expect(room.exit.proposalBody).toMatchObject({
      positionId: "pos-9",
      proposedExitQuantity: 0.12,
    });
    expect(room.agentPresence).toBe("MONITORING");
    expect(JSON.stringify(room)).not.toContain(BINDING);
    const extra = evidence(occurrence.agentRunId, occurrence.occurrenceId, "monitoring.blocked", LATER);
    expect(() => store.monitoringCycles.record({
      ...cycle,
      account: { ...cycle.account, brokerHealth: "DEGRADED" },
    }, [extra])).toThrow(TradingDomainError);
    expect(store.readEvents().some((event) => event.eventId === extra.eventId)).toBe(false);
    const kept = store.monitoringCycles.readLatest(occurrence.occurrenceId);
    expect(kept).not.toBe("malformed");
    if (kept === "missing" || kept === "malformed") throw new Error("cycle missing");
    expect(kept.brokerHealth).not.toBe("DEGRADED");
  });

  it("does not claim MONITORING from a missing or malformed cycle", () => {
    const { path, env, store } = harness();
    const occurrence = seed(store);
    store.killSwitches.write(storedSwitch(occurrence.agentRunId, false));
    citeBook(store, occurrence, [gold()]);
    store.appendEvents([evidence(occurrence.agentRunId, occurrence.occurrenceId, "monitoring.completed", LATER, { decision: "CONTINUE_MONITORING" })]);
    const absent = roomOf(env);
    expect(absent.monitoring.availability).toBe("EVENT_ONLY");
    expect(absent.agentPresence).not.toBe("MONITORING");
    expect(absent.nextAction.action).toBe("POSITION_OPEN_NO_CYCLE");
    runMonitoringCycle(cycleInput(store, occurrence.occurrenceId, book([gold()]), "CONTINUE_MONITORING"));
    store.close();
    rewrite(path, "UPDATE trading_monitoring_cycles SET payload_json = '{'");
    const malformed = roomOf(env);
    expect(malformed.monitoring.availability).toBe("NOT_AVAILABLE");
    expect(malformed.agentPresence).not.toBe("MONITORING");
    expect(malformed.monitoring.decision).toBeNull();
  });
});

describe("exit and position", () => {
  it("distinguishes no exit, a refusal, a pending reserve, and an unknown submission", () => {
    const none = harness();
    const quiet = seed(none.store);
    none.store.killSwitches.write(storedSwitch(quiet.agentRunId, false));
    citeBook(none.store, quiet, [gold()]);
    const noExit = roomOf(none.env);
    expect(noExit.exit.execution).toBeNull();
    expect(noExit.position.state).toBe("POSITION_OPEN");

    const refused = harness();
    const held = seed(refused.store);
    refused.store.killSwitches.write(storedSwitch(held.agentRunId, false));
    citeBook(refused.store, held, [gold()]);
    refused.store.occurrences.attachExitExecution({
      occurrenceId: held.occurrenceId,
      agentRunId: held.agentRunId,
      environment: "PAPER",
      executionRequestId: "exr.exit-refused",
      executionState: "NOT_SUBMITTED",
      brokerCalled: false,
      closePositionId: "pos-9",
      quantity: 0.12,
      failureCode: "PAUSED",
    });
    const authorized = roomOf(refused.env);
    expect(authorized.exit.execution).toMatchObject({
      state: "NOT_SUBMITTED",
      brokerCalled: false,
      closePositionId: "pos-9",
      quantity: 0.12,
      reason: "PAUSED",
    });

    const pending = harness();
    const working = seed(pending.store);
    pending.store.killSwitches.write(storedSwitch(working.agentRunId, false));
    citeBook(pending.store, working, [gold()]);
    expect(pending.store.ledger.reserve(attempt(working.agentRunId, "SUBMISSION_UNKNOWN"))).toBe(true);
    expect(pending.store.ledger.reserve(attempt(working.agentRunId, "SUBMISSION_UNKNOWN"))).toBe(false);
    const reserved = roomOf(pending.env);
    expect(reserved.exit.execution).toMatchObject({
      state: "SUBMISSION_UNKNOWN",
      brokerCalled: false,
      closePositionId: "pos-9",
      quantity: 0.12,
    });
    expect(reserved.position.state).toBe("POSITION_UNKNOWN");

    const unknown = harness();
    const drifted = seed(unknown.store);
    unknown.store.killSwitches.write(storedSwitch(drifted.agentRunId, false));
    citeBook(unknown.store, drifted, [gold()]);
    const first = attempt(drifted.agentRunId, "SUBMISSION_UNKNOWN", "exr.exit-unknown", "exn.exit-unknown");
    expect(unknown.store.ledger.reserve(first)).toBe(true);
    expect(unknown.store.ledger.complete({ ...first, state: "SUBMISSION_UNKNOWN", submittedAt: LATER })).toBe(true);
    const unresolved = roomOf(unknown.env);
    expect(unresolved.exit.execution).toMatchObject({
      state: "SUBMISSION_UNKNOWN",
      brokerCalled: true,
      closePositionId: "pos-9",
      quantity: 0.12,
    });
  });

  it("loads an accepted close, a rejected close, and a reconciled flat book", () => {
    const closing = harness();
    const live = seed(closing.store);
    closing.store.killSwitches.write(storedSwitch(live.agentRunId, false));
    citeBook(closing.store, live, [gold()]);
    const accepted = attempt(live.agentRunId, "SUBMISSION_UNKNOWN", "exr.exit-accepted", "exn.exit-accepted");
    expect(closing.store.ledger.reserve(accepted)).toBe(true);
    expect(closing.store.ledger.complete({ ...accepted, state: "SUBMISSION_ACCEPTED", submittedAt: LATER })).toBe(true);
    closing.store.appendEvents([evidence(live.agentRunId, live.occurrenceId, "position.closed", LATER, { quantity: 9, positionId: "pos-other" })]);
    const working = roomOf(closing.env);
    expect(working.exit.execution).toMatchObject({
      state: "SUBMISSION_ACCEPTED",
      brokerCalled: true,
      closePositionId: "pos-9",
      quantity: 0.12,
    });
    expect(working.position.state).toBe("POSITION_CLOSING");
    expect(working.agentPresence).toBe("EXIT_WORKING");
    expect(JSON.stringify(working)).not.toContain("pos-other");
    expect(JSON.stringify(working)).not.toContain(BINDING);
    expect(JSON.stringify(working)).not.toContain(CLIENT);

    const rejected = harness();
    const still = seed(rejected.store);
    rejected.store.killSwitches.write(storedSwitch(still.agentRunId, false));
    citeBook(rejected.store, still, [gold()]);
    const failed = attempt(still.agentRunId, "SUBMISSION_UNKNOWN", "exr.exit-rejected", "exn.exit-rejected");
    expect(rejected.store.ledger.reserve(failed)).toBe(true);
    expect(rejected.store.ledger.complete({ ...failed, state: "SUBMISSION_REJECTED", submittedAt: LATER })).toBe(true);
    const refusal = roomOf(rejected.env);
    expect(refusal.exit.execution?.state).toBe("SUBMISSION_REJECTED");
    expect(refusal.exit.execution?.brokerCalled).toBe(true);
    expect(refusal.position.state).toBe("POSITION_OPEN");

    const closed = harness();
    const flat = seed(closed.store);
    closed.store.killSwitches.write(storedSwitch(flat.agentRunId, false));
    citeBook(closed.store, flat, [], "FILL_REPORTED");
    closed.store.occurrences.attachExitExecution({
      occurrenceId: flat.occurrenceId,
      agentRunId: flat.agentRunId,
      environment: "PAPER",
      executionRequestId: "exr.exit-closed",
      executionState: "FILL_REPORTED",
      brokerCalled: true,
      closePositionId: "pos-9",
      quantity: 0.12,
      failureCode: null,
    });
    const done = roomOf(closed.env);
    expect(done.exit.execution?.state).toBe("FILL_REPORTED");
    expect(done.position.state).toBe("POSITION_CLOSED");
    expect(done.position.state).toBe(derivePositionLifecycle({
      executionState: "FILL_REPORTED",
      reconciliationState: "RECONCILED",
      brokerPositionId: null,
      brokerQuantity: null,
      authorizedQuantity: null,
      exitState: "FILL_REPORTED",
      ambiguous: false,
    }));
  });

  it("refuses a second close request id on the same occurrence", () => {
    const { store } = harness();
    const occurrence = seed(store);
    store.occurrences.attachExitExecution({
      occurrenceId: occurrence.occurrenceId,
      agentRunId: occurrence.agentRunId,
      environment: "PAPER",
      executionRequestId: "exr.exit-one",
      executionState: "NOT_SUBMITTED",
      brokerCalled: false,
      closePositionId: "pos-9",
      quantity: 0.12,
      failureCode: "PAUSED",
    });
    expect(() => store.occurrences.attachExitExecution({
      occurrenceId: occurrence.occurrenceId,
      agentRunId: occurrence.agentRunId,
      environment: "PAPER",
      executionRequestId: "exr.exit-two",
      executionState: "SUBMISSION_ACCEPTED",
      brokerCalled: true,
      closePositionId: "pos-9",
      quantity: 0.12,
      failureCode: null,
    })).toThrow(TradingDomainError);
  });
});

describe("projection authority", () => {
  it("keeps derivePositionLifecycle as the only position authority and projectDesk non-authoritative", () => {
    const room = readFileSync(new URL("./room.ts", import.meta.url), "utf8");
    const load = readFileSync(new URL("./load.ts", import.meta.url), "utf8");
    const project = readFileSync(new URL("./project.ts", import.meta.url), "utf8");
    const index = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    expect(room).toContain("derivePositionLifecycle");
    expect(load).not.toContain("derivePositionLifecycle");
    expect(load).not.toContain("projectDesk");
    expect(project).toContain("authoritative: false");
    expect(project).not.toContain("emergency.stop");
    expect(index).toContain("loadTradingRoom");
    expect(index).not.toContain("projectDesk");
    expect(index).not.toContain("tradingDeskReport");
    expect(ROOM_PRESENCE).toEqual([
      "PAUSED",
      "ERROR",
      "CONFIRMING",
      "EXIT_WORKING",
      "DEGRADED",
      "MONITORING",
      "AWAITING_APPROVAL",
      "DECISION_READY",
      "ANALYZING",
      "OBSERVING",
      "WAITING_FOR_DATA",
      "IDLE",
    ]);
    const lifecycle = readFileSync(new URL("../occurrence/lifecycle.ts", import.meta.url), "utf8");
    expect(lifecycle).toContain("snapshotId: input.snapshot.snapshotId");
    const submit = readFileSync(new URL("../execution/submit.ts", import.meta.url), "utf8");
    const gate = readFileSync(new URL("../gate/evaluate.ts", import.meta.url), "utf8");
    const execute = readFileSync(new URL("../eligibility/execute.ts", import.meta.url), "utf8");
    expect(submit).toContain("isAuthoritativeKillSwitchRepository");
    expect(gate).toContain("readStoredSwitch");
    expect(execute).toContain("killSwitches: input.killSwitches");
    for (const source of [submit, gate, execute]) {
      expect(source).not.toContain("killSwitchAuthorityFromValue");
      expect(source).not.toContain("missingKillSwitchAuthority");
    }
  });
});

function attempt(
  agentRunId: string,
  state: ExecutionAttemptRecord["state"],
  executionRequestId = "exr.exit-1",
  executionIdentity = "exn.exit-1",
): ExecutionAttemptRecord {
  return {
    schemaVersion: EXECUTION_ENGINE_VERSION,
    executionAttemptId: "eat.pending",
    executionRequestId,
    executionIdentity,
    sequence: 1,
    agentRunId,
    decisionId: "dec-1",
    orderIntentId: "intent-1",
    riskDecisionId: "risk-1",
    policyDecisionId: "policy-1",
    approvalDecisionId: "appr-1",
    gateId: "gate-1",
    gateState: "ELIGIBLE_FOR_EXECUTION",
    bindingId: BINDING,
    proposalBinding: "bind-exit-1",
    environment: "PAPER",
    provenance: "LIVE",
    direction: "LONG",
    entry: 4632.5,
    stop: 4624.5,
    takeProfit: 4648,
    targets: [4648],
    requestedQuantity: 0.12,
    quantity: 0.12,
    clientId: CLIENT,
    closePositionId: "pos-9",
    state,
    brokerRequestId: null,
    brokerCode: null,
    fill: null,
    submittedAt: AT,
    responseAt: null,
  };
}

function executionInput(agentRunId: string, store: TradingStore, caller: KillSwitchState | null): ExecutionSubmitInput {
  const open = storedSwitch(agentRunId, false);
  const made = decision(agentRunId);
  const order = intent(agentRunId);
  const input = proposalInput(agentRunId, made);
  const evaluated = evaluateXauUsdProposal(input);
  if (evaluated.policy === null) throw new Error("policy missing");
  const approval = assessApproval({
    instrument: "XAUUSD",
    decision: made,
    orderIntent: order,
    risk: evaluated.risk,
    policy: evaluated.policy,
    environment: "PAPER",
    provenance: "LIVE",
    autonomy: autonomy(4, agentRunId),
    permissions: ["decision.propose", "intent.propose"],
    killSwitch: open,
    approval: null,
    config: { version: "approval-v1", maxAgeMs: 60_000 },
    evaluatedAt: AT,
    agentRunId,
    approvalRequestId: "req-exec",
    requestedQuantity: 0.12,
  });
  const gateInput: FireTimeGateInput = {
    instrument: "XAUUSD",
    decision: made,
    orderIntent: order,
    risk: evaluated.risk,
    policy: evaluated.policy,
    approval,
    market: { snapshotId: "snap-1", provenance: "LIVE", freshness: "fresh", marketTimestamp: AT },
    accountEquity: 10_000,
    exposureLots: 0,
    environment: "PAPER",
    provenance: "LIVE",
    autonomy: autonomy(4, agentRunId),
    permissions: ["decision.propose", "intent.propose"],
    killSwitch: open,
    killSwitches: store.killSwitches,
    approvalFact: null,
    requestedQuantity: 0.12,
    riskConfig: { version: "risk-v1", maxRiskPercent: 0.02, requireStop: true },
    policyConfig: { version: "policy-v1" },
    approvalConfig: { version: "approval-v1", maxAgeMs: 60_000 },
    gateConfig: { version: "gate-v1", maxMarketAgeMs: 60_000 },
    evaluatedAt: AT,
    agentRunId,
    evaluationRunId: "eval-1",
  };
  return {
    instrument: "XAUUSD",
    decision: made,
    orderIntent: order,
    risk: evaluated.risk,
    policy: evaluated.policy,
    approval,
    gate: evaluateFireTimeGate(gateInput),
    binding: {
      schemaVersion: "xauusd-metaapi-account-1",
      bindingId: "paper-binding-1",
      environment: "PAPER",
      credentialSlot: "paper",
      brokerSymbol: "XAUUSD",
      provider: "metaapi-cloud",
      region: "london",
    },
    quote: { bid: 4630, ask: 4633, snapshotId: "snap-1" },
    killSwitch: caller,
    killSwitches: store.killSwitches,
    environment: "PAPER",
    provenance: "LIVE",
    requestedQuantity: 0.12,
    provider: {
      providerId: "metaapi-cloud",
      bindingId: "paper-binding-1",
      configured: true,
      submit: async () => ({
        kind: "accepted",
        brokerRequestId: "ticket-1",
        brokerCode: "TRADE_RETCODE_DONE",
        fillPrice: null,
        fillVolume: null,
        brokerFillId: null,
      }),
    },
    ledger: createMemoryExecutionLedger(),
    submittedAt: AT,
    agentRunId,
    evaluationRunId: "eval-1",
  };
}

function proposalInput(agentRunId: string, made: Decision): ProposalInput {
  return {
    instrument: "XAUUSD",
    decision: made,
    orderIntent: intent(agentRunId),
    market: {
      snapshotId: "snap-1",
      provenance: "LIVE",
      freshness: "fresh",
      providerTimestamp: AT,
      bid: 4630,
      ask: 4633,
      spread: 3,
    },
    account: {
      equity: 10_000,
      currency: "USD",
      exposureSide: "none",
      exposureLots: 0,
      openRiskAmount: 0,
      asOf: AT,
      provenance: "LIVE",
      freshness: "fresh",
      sourceId: "acct-fixture",
      sourceVersion: "v1",
    },
    riskConfig: { version: "risk-v1", maxRiskPercent: 0.02, requireStop: true },
    policyConfig: { version: "policy-v1" },
    environment: "PAPER",
    provenance: "LIVE",
    assessedAt: AT,
    agentRunId,
    autonomy: autonomy(4, agentRunId),
    permissions: ["decision.propose", "intent.propose"],
    approval: "absent",
    killSwitch: storedSwitch(agentRunId, false),
    requestedQuantity: 0.12,
  };
}

function autonomy(level: AutonomyLevel, agentRunId: string) {
  return parseAutonomyState({
    schemaVersion: 1,
    environment: "PAPER",
    level,
    name: AUTONOMY_NAMES[level],
    agentRunId,
    updatedAt: AT,
  });
}

function cycleInput(
  store: TradingStore,
  occurrenceId: string,
  snapshot: BrokerAccountSnapshot,
  decisionName: MonitoringCycleInput["decision"],
): MonitoringCycleInput {
  return {
    store,
    occurrenceId,
    marker: {
      environment: "PAPER",
      autonomyLevel: 4,
      permissions: ["market.read", "account.read", "position.read", "decision.propose", "intent.propose"],
    },
    observedAt: AT,
    market: {
      snapshotId: "snap-1",
      provenance: "LIVE",
      freshness: "fresh",
      providerTimestamp: AT,
      bid: 4630,
      ask: 4633,
      spread: 3,
    },
    account: {
      equity: 10_000,
      currency: "USD",
      exposureSide: "long",
      exposureLots: 0.12,
      openRiskAmount: 0,
      asOf: AT,
      provenance: "LIVE",
      freshness: "fresh",
      sourceId: BINDING,
      sourceVersion: "v1",
    },
    snapshot,
    killSwitch: null,
    paused: false,
    decision: decisionName,
    exitReason: "stop reached",
    proposedExitQuantity: 0.12,
    riskConfig: { version: "risk-v1", maxRiskPercent: 0.02, requireStop: true },
    policyConfig: { version: "policy-v1" },
  };
}
