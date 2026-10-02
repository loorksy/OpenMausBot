import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AUTONOMY_NAMES, parseAutonomyState, type AutonomyLevel } from "../../../shared/trading/autonomy.ts";
import { parseDecision, type DecisionDirection } from "../../../shared/trading/decision.ts";
import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { parseKillSwitchState } from "../../../shared/trading/kill-switch.ts";
import { parseOrderIntent, type OrderIntent, type OrderIntentDirection } from "../../../shared/trading/order-intent.ts";
import type { ApprovalFact } from "../approval/assess.ts";
import { proposalBinding, PROPOSAL_BINDING_VERSION } from "../approval/binding.ts";
import { routineAgentRunId, routineOccurrenceId } from "../occurrence/identity.ts";
import { openTradingStore, type TradingStore } from "../persistence/store.ts";
import { evaluateXauUsdProposal, type ProposalEvaluation } from "../proposal/evaluate.ts";
import {
  evaluateExecutionEligibility,
  ELIGIBILITY_HANDOFF_VERSION,
  type EligibilityHandoffInput,
} from "./handoff.ts";

const AT = "2026-08-15T14:30:00.000Z";
const PLUS_TWO_MINUTES = "2026-08-15T14:32:00.000Z";
const RUN = "run-1";
const ROUTINE_RUN = "33333333-3333-4333-8333-333333333333";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function decision(
  direction: DecisionDirection,
  stop?: number,
  targets: number[] = direction === "LONG" || direction === "SHORT" ? [direction === "SHORT" ? 1900 : 2100] : [],
  environment: TradingEnvironment = "SIMULATOR",
  agentRunId = RUN,
  id = "dec-1",
) {
  return parseDecision({
    schemaVersion: 1,
    id,
    agentRunId,
    environment,
    instrument: "XAUUSD",
    createdAt: AT,
    status: "DRAFT",
    thesis: "A proposal for the eligibility handoff.",
    contextId: "ctx-1",
    snapshotId: "snap-1",
    evidenceIds: [],
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingInformation: ["no independent target review"],
    direction,
    ...(stop === undefined ? {} : { stop }),
    targets,
    expiry: "2026-08-15T18:00:00.000Z",
    evidenceQuality: "insufficient",
    versionManifestId: "ver-1",
  });
}

function intent(
  direction: OrderIntentDirection,
  entry: number,
  stop?: number,
  targets: number[] = direction === "SHORT" ? [1900] : [2100],
  environment: TradingEnvironment = "SIMULATOR",
  agentRunId = RUN,
  id = "intent-1",
  decisionId = "dec-1",
) {
  return parseOrderIntent({
    schemaVersion: 1,
    kind: "order-intent",
    id,
    agentRunId,
    environment,
    instrument: "XAUUSD",
    decisionId,
    createdAt: AT,
    direction,
    executable: false,
    brokerSubmit: false,
    entry,
    ...(stop === undefined ? {} : { stop }),
    targets,
  });
}

function account(provenance = "SIMULATOR") {
  return {
    equity: 10_000,
    currency: "USD",
    exposureSide: "none",
    exposureLots: 0,
    openRiskAmount: 0,
    asOf: AT,
    provenance,
    freshness: "fresh",
    sourceId: "acct-fixture",
    sourceVersion: "v1",
  };
}

function market(provenance = "SIMULATOR", providerTimestamp = AT) {
  return {
    snapshotId: "snap-1",
    provenance,
    freshness: "fresh",
    providerTimestamp,
    bid: 1999.5,
    ask: 2000.5,
    spread: 1,
  };
}

function autonomy(level: AutonomyLevel, environment: TradingEnvironment = "SIMULATOR", agentRunId = RUN) {
  return parseAutonomyState({
    schemaVersion: 1,
    environment,
    level,
    name: AUTONOMY_NAMES[level],
    agentRunId,
    updatedAt: AT,
  });
}

function kill(engaged: boolean, environment: TradingEnvironment = "SIMULATOR", agentRunId = RUN) {
  return parseKillSwitchState({
    schemaVersion: 1,
    environment,
    engaged,
    agentRunId,
    updatedAt: AT,
    source: "operator",
  });
}

function orderInput(overrides: Partial<EligibilityHandoffInput> = {}): EligibilityHandoffInput {
  return {
    instrument: "XAUUSD",
    decision: decision("LONG", 1990),
    orderIntent: intent("LONG", 2000, 1990),
    market: market(),
    account: account(),
    riskConfig: { version: "risk-v1", maxRiskPercent: 0.01, requireStop: true },
    policyConfig: { version: "policy-v1" },
    approvalConfig: { version: "approval-v1", maxAgeMs: 60_000 },
    gateConfig: { version: "gate-v1", maxMarketAgeMs: 60_000 },
    environment: "SIMULATOR",
    provenance: "SIMULATOR",
    assessedAt: AT,
    agentRunId: RUN,
    evaluationRunId: "eval-1",
    runtimeThreadId: "thread-1",
    runtimeTurnId: "turn-1",
    autonomy: autonomy(4),
    permissions: ["decision.propose", "intent.propose"],
    policyApproval: "absent",
    approval: null,
    approvalRequestId: "req-1",
    reconciliation: "RECONCILED",
    killSwitch: kill(false),
    ...overrides,
  };
}

function preview(input: EligibilityHandoffInput): ProposalEvaluation {
  return evaluateXauUsdProposal({
    instrument: input.instrument,
    decision: input.decision,
    orderIntent: input.orderIntent,
    market: input.market,
    account: input.account,
    riskConfig: input.riskConfig,
    policyConfig: input.policyConfig,
    environment: input.environment,
    provenance: input.provenance,
    assessedAt: input.assessedAt,
    agentRunId: input.agentRunId,
    evaluationRunId: input.evaluationRunId,
    runtimeThreadId: input.runtimeThreadId,
    runtimeTurnId: input.runtimeTurnId,
    requestedQuantity: input.requestedQuantity ?? null,
    autonomy: input.autonomy,
    permissions: input.permissions,
    approval: input.policyApproval,
    killSwitch: input.killSwitch,
  });
}

function matchingFact(input: EligibilityHandoffInput, patch: Partial<ApprovalFact> = {}): ApprovalFact {
  const evaluated = preview(input);
  const current = input.orderIntent;
  if (input.decision === null || current === null || current.entry === undefined || current.stop === undefined) {
    throw new Error("proposal is missing prices");
  }
  if (evaluated.policy === null || evaluated.risk.configId === null || evaluated.policy.configId === null) {
    throw new Error("proposal did not reach policy");
  }
  const binding = proposalBinding({
    instrument: "XAUUSD",
    agentRunId: input.agentRunId,
    decisionId: input.decision.id,
    orderIntentId: current.id,
    riskDecisionId: evaluated.risk.id,
    policyDecisionId: evaluated.policy.id,
    environment: String(input.environment),
    provenance: String(input.provenance),
    direction: current.direction,
    entry: current.entry,
    stop: current.stop,
    targets: current.targets,
    requestedQuantity: input.requestedQuantity ?? null,
    acceptedQuantity: evaluated.risk.trace.acceptedQuantity,
    riskConfigId: evaluated.risk.configId,
    policyConfigId: evaluated.policy.configId,
  });
  return {
    approvalId: "human-1",
    approvalRequestId: "req-1",
    approved: true,
    approvedBy: "operator",
    approvedAt: AT,
    decisionId: input.decision.id,
    orderIntentId: current.id,
    riskDecisionId: evaluated.risk.id,
    policyDecisionId: evaluated.policy.id,
    environment: input.environment as ApprovalFact["environment"],
    instrument: "XAUUSD",
    approvalPolicyVersion: "approval-v1",
    proposalBinding: binding,
    ...patch,
  };
}

function level3(overrides: Partial<EligibilityHandoffInput> = {}): EligibilityHandoffInput {
  const input = orderInput({ autonomy: autonomy(3), policyApproval: "granted", ...overrides });
  return { ...input, approval: matchingFact(input) };
}

function eligibleLevel4(overrides: Partial<EligibilityHandoffInput> = {}) {
  return evaluateExecutionEligibility(orderInput(overrides));
}

function store(): TradingStore {
  const dir = mkdtempSync(join(tmpdir(), "xauusd-eligibility-"));
  dirs.push(dir);
  return openTradingStore({ path: join(dir, "trading.db"), environment: "SIMULATOR" });
}

describe("phase 10.3 step 4 execution eligibility", () => {
  it("reaches ELIGIBLE_FOR_EXECUTION for a valid proposal and records references only", () => {
    const saved = store();
    const agentRunId = routineAgentRunId(ROUTINE_RUN);
    saved.occurrences.insertRoutineOccurrence({
      routineId: "routine-1",
      routineRunId: ROUTINE_RUN,
      threadId: "thread-1",
      environment: "SIMULATOR",
      startedAt: AT,
    });
    const occurrenceId = routineOccurrenceId(ROUTINE_RUN);
    const input = level3({
      agentRunId,
      decision: decision("LONG", 1990, [2100], "SIMULATOR", agentRunId),
      orderIntent: intent("LONG", 2000, 1990, [2100], "SIMULATOR", agentRunId),
      autonomy: autonomy(3, "SIMULATOR", agentRunId),
      killSwitch: kill(false, "SIMULATOR", agentRunId),
      occurrence: { repository: saved.occurrences, occurrenceId },
    });
    const result = evaluateExecutionEligibility(input);
    expect(result.schemaVersion).toBe(ELIGIBILITY_HANDOFF_VERSION);
    expect(result.gate?.state).toBe("ELIGIBLE_FOR_EXECUTION");
    expect(result.state).toBe("ELIGIBLE_FOR_EXECUTION");
    expect(result.gate?.reasons).toEqual(["ELIGIBLE"]);
    expect(result.gate?.liveExecutionEnabled).toBe(false);
    expect(result.gate?.orderIntentExecutable).toBe(false);
    expect(result.gate?.orderIntentBrokerSubmit).toBe(false);
    expect(result.liveExecutionEnabled).toBe(false);
    expect(result.orderSubmitted).toBe(false);
    expect(result.executionAttemptCreated).toBe(false);
    expect(result.brokerCalled).toBe(false);
    expect(result.metaApiCalled).toBe(false);
    expect(result.binding).toBe(result.gate?.binding);
    expect(PROPOSAL_BINDING_VERSION).toBe("xauusd-proposal-binding-1");
    const row = saved.occurrences.readByOccurrenceId(occurrenceId);
    expect(row).toMatchObject({
      occurrenceId,
      routineId: "routine-1",
      routineRunId: ROUTINE_RUN,
      threadId: "thread-1",
      providerTurnId: null,
      agentRunId,
      decisionId: "dec-1",
      orderIntentId: "intent-1",
      riskDecisionId: result.proposal?.risk.id,
      policyDecisionId: result.proposal?.policy?.id,
      approvalId: "human-1",
      proposalBindingHash: result.binding,
      failureCode: null,
      domainStatus: "turn_not_started",
      executionRequestId: null,
      reconciliationRunId: null,
    });
    expect(evaluateExecutionEligibility(input).binding).toBe(result.binding);
    expect(saved.occurrences.readByOccurrenceId(occurrenceId)?.domainStatus).toBe("turn_not_started");
  });

  it("does not create an executable intent for NO_TRADE", () => {
    const input = orderInput({ decision: decision("NO_TRADE"), orderIntent: null });
    const result = evaluateExecutionEligibility(input);
    expect(input.orderIntent).toBeNull();
    expect(result.stoppedAt).toBe("non_execution");
    expect(result.proposal?.outcome).toBe("RECOMMENDATION_ONLY");
    expect(result.proposal?.risk.orderIntentId).toBeNull();
    expect(result.proposal?.orderIntentExecutable).toBe(false);
    expect(result.approval).toBeNull();
    expect(result.gate).toBeNull();
    expect(result.state).not.toBe("ELIGIBLE_FOR_EXECUTION");
  });

  it("does not create an executable intent for WAIT", () => {
    const input = orderInput({ decision: decision("WAIT"), orderIntent: null });
    const result = evaluateExecutionEligibility(input);
    expect(input.orderIntent).toBeNull();
    expect(result.stoppedAt).toBe("non_execution");
    expect(result.proposal?.outcome).toBe("RECOMMENDATION_ONLY");
    expect(result.proposal?.risk.state).toBe("ACCEPT");
    expect(result.proposal?.risk.orderIntentId).toBeNull();
    expect(result.gate).toBeNull();
    expect(result.state).not.toBe("ELIGIBLE_FOR_EXECUTION");
  });

  it("rejects an unknown instrument before policy", () => {
    const result = evaluateExecutionEligibility(orderInput({ instrument: "EURUSD" }));
    expect(result.stoppedAt).toBe("risk");
    expect(result.proposal?.risk.reasons).toEqual(["INVALID_INSTRUMENT"]);
    expect(result.proposal?.policy).toBeNull();
    expect(result.approval).toBeNull();
    expect(result.gate).toBeNull();
  });

  it("rejects a decision and intent direction mismatch before policy", () => {
    const result = evaluateExecutionEligibility(orderInput({
      orderIntent: intent("SHORT", 2000, 2010, [1900]),
    }));
    expect(result.stoppedAt).toBe("risk");
    expect(result.proposal?.risk.reasons).toEqual(["DIRECTION_MISMATCH"]);
    expect(result.proposal?.policy).toBeNull();
    expect(result.gate).toBeNull();
  });

  it("rejects an invalid quantity and does not repair a malformed intent", () => {
    const zero = evaluateExecutionEligibility(orderInput({ requestedQuantity: 0 }));
    const negative = evaluateExecutionEligibility(orderInput({ requestedQuantity: -1 }));
    expect(zero.stoppedAt).toBe("risk");
    expect(zero.proposal?.risk.reasons).toEqual(["QUANTITY_INVALID"]);
    expect(zero.proposal?.risk.trace.acceptedQuantity).toBeNull();
    expect(zero.proposal?.policy).toBeNull();
    expect(negative.proposal?.risk.reasons).toEqual(["QUANTITY_INVALID"]);
    expect(negative.gate).toBeNull();
    const missingEntry = parseOrderIntent({
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
      targets: [2100],
    });
    const bare = evaluateExecutionEligibility(orderInput({ orderIntent: missingEntry }));
    expect(bare.proposal?.risk.reasons[0]).toBe("MISSING_ENTRY");
    expect(bare.proposal?.policy).toBeNull();
    const executable = { ...intent("LONG", 2000, 1990), executable: true } as unknown as OrderIntent;
    const submitting = { ...intent("LONG", 2000, 1990), brokerSubmit: true } as unknown as OrderIntent;
    expect(evaluateExecutionEligibility(orderInput({ orderIntent: executable })).proposal?.risk.reasons).toEqual(["INTENT_FLAGS_INVALID"]);
    expect(evaluateExecutionEligibility(orderInput({ orderIntent: submitting })).proposal?.policy).toBeNull();
    expect(executable.executable).toBe(true);
    expect(submitting.brokerSubmit).toBe(true);
  });

  it("stops on risk rejection before policy, approval, and the gate", () => {
    const result = evaluateExecutionEligibility(orderInput({ requestedQuantity: 1 }));
    expect(result.stoppedAt).toBe("risk");
    expect(result.proposal?.risk.state).toBe("REJECT");
    expect(result.proposal?.risk.reasons).toEqual(["RISK_BUDGET_EXCEEDED"]);
    expect(result.proposal?.risk.trace.acceptedQuantity).toBeNull();
    expect(result.proposal?.risk.trace.requestedQuantity).toBe(1);
    expect(result.proposal?.policy).toBeNull();
    expect(result.approval).toBeNull();
    expect(result.gate).toBeNull();
  });

  it("stops on policy rejection before approval and the gate", () => {
    const result = evaluateExecutionEligibility(orderInput({ permissions: ["market.read"] }));
    expect(result.stoppedAt).toBe("policy");
    expect(result.proposal?.risk.state).toBe("ACCEPT");
    expect(result.proposal?.policy?.state).toBe("REJECT");
    expect(result.proposal?.policy?.reasons).toEqual(["PERMISSION_MISSING"]);
    expect(result.approval).toBeNull();
    expect(result.gate).toBeNull();
  });

  it("stops when a required approval is missing", () => {
    const result = evaluateExecutionEligibility(orderInput({
      autonomy: autonomy(3),
      policyApproval: "granted",
      approval: null,
    }));
    expect(result.stoppedAt).toBe("approval");
    expect(result.approval?.state).toBe("REJECTED");
    expect(result.approval?.reasons).toEqual(["APPROVAL_REQUIRED"]);
    expect(result.gate).toBeNull();
  });

  it("stops when approval is rejected", () => {
    const input = level3();
    const fact = input.approval as ApprovalFact;
    const result = evaluateExecutionEligibility({ ...input, approval: { ...fact, approved: false } });
    expect(result.stoppedAt).toBe("approval");
    expect(result.approval?.reasons).toEqual(["APPROVAL_DENIED"]);
    expect(result.gate).toBeNull();
    expect(fact.approved).toBe(true);
  });

  it("stops when approval is stale", () => {
    const input = level3({ assessedAt: PLUS_TWO_MINUTES });
    const result = evaluateExecutionEligibility(input);
    expect(result.stoppedAt).toBe("approval");
    expect(result.approval?.reasons).toEqual(["APPROVAL_STALE"]);
    expect(result.gate).toBeNull();
  });

  it("stops when the proposal binding does not match the approval", () => {
    const input = level3();
    const fact = input.approval as ApprovalFact;
    const result = evaluateExecutionEligibility({
      ...input,
      approval: { ...fact, proposalBinding: "bind.other-proposal" },
    });
    expect(result.stoppedAt).toBe("approval");
    expect(result.approval?.reasons).toEqual(["APPROVAL_MISMATCH"]);
    expect(result.gate).toBeNull();
    expect(fact.proposalBinding).not.toBe("bind.other-proposal");
  });

  it("invalidates an approval when the entry changes", () => {
    const input = level3();
    const fact = input.approval as ApprovalFact;
    const moved = evaluateExecutionEligibility({
      ...input,
      orderIntent: intent("LONG", 2001, 1990),
    });
    expect(moved.stoppedAt).toBe("approval");
    expect(moved.approval?.reasons).toEqual(["APPROVAL_MISMATCH"]);
    expect(moved.gate).toBeNull();
    expect(moved.approval?.binding).not.toBe(fact.proposalBinding);
    expect(fact.proposalBinding.startsWith("bind.")).toBe(true);
    expect(input.orderIntent?.entry).toBe(2000);
  });

  it("invalidates an approval when the stop changes", () => {
    const input = level3();
    const fact = input.approval as ApprovalFact;
    const moved = evaluateExecutionEligibility({
      ...input,
      decision: decision("LONG", 1980),
      orderIntent: intent("LONG", 2000, 1980),
    });
    expect(moved.approval?.reasons).toEqual(["APPROVAL_MISMATCH"]);
    expect(moved.gate).toBeNull();
    expect(moved.approval?.binding).not.toBe(fact.proposalBinding);
    expect(input.orderIntent?.stop).toBe(1990);
  });

  it("invalidates an approval when the quantity changes", () => {
    const input = level3();
    const fact = input.approval as ApprovalFact;
    const moved = evaluateExecutionEligibility({ ...input, requestedQuantity: 0.05 });
    expect(moved.approval?.reasons).toEqual(["APPROVAL_MISMATCH"]);
    expect(moved.gate).toBeNull();
    expect(moved.proposal?.risk.trace.requestedQuantity).toBe(0.05);
    expect(moved.proposal?.risk.trace.acceptedQuantity).toBe(0.05);
    expect(moved.approval?.binding).not.toBe(fact.proposalBinding);
  });

  it("blocks an environment mismatch", () => {
    const input = level3();
    const fact = input.approval as ApprovalFact;
    const result = evaluateExecutionEligibility({
      ...input,
      approval: { ...fact, environment: "PAPER" },
    });
    expect(result.stoppedAt).toBe("approval");
    expect(result.approval?.reasons).toEqual(["APPROVAL_MISMATCH"]);
    expect(result.gate).toBeNull();
    expect(fact.environment).toBe("SIMULATOR");
  });

  it("blocks a provenance mismatch", () => {
    const input = level3();
    const fact = input.approval as ApprovalFact;
    const current = input.orderIntent;
    if (current?.entry === undefined || current.stop === undefined) throw new Error("missing prices");
    const rebound = proposalBinding({
      instrument: "XAUUSD",
      agentRunId: input.agentRunId,
      decisionId: fact.decisionId,
      orderIntentId: fact.orderIntentId,
      riskDecisionId: fact.riskDecisionId,
      policyDecisionId: fact.policyDecisionId,
      environment: "SIMULATOR",
      provenance: "LIVE",
      direction: current.direction,
      entry: current.entry,
      stop: current.stop,
      targets: current.targets,
      requestedQuantity: null,
      acceptedQuantity: preview(input).risk.trace.acceptedQuantity,
      riskConfigId: preview(input).risk.configId ?? "",
      policyConfigId: preview(input).policy?.configId ?? "",
    });
    const result = evaluateExecutionEligibility({
      ...input,
      approval: { ...fact, proposalBinding: rebound },
    });
    expect(result.approval?.reasons).toEqual(["APPROVAL_MISMATCH"]);
    expect(result.gate).toBeNull();
    expect(rebound).not.toBe(fact.proposalBinding);
  });

  it("blocks when fire-time freshness is exceeded", () => {
    const result = eligibleLevel4({ market: market("SIMULATOR", "2026-08-15T14:00:00.000Z") });
    expect(result.stoppedAt).toBe("gate");
    expect(result.gate?.state).toBe("BLOCKED");
    expect(result.gate?.reasons).toEqual(["MARKET_DATA_STALE"]);
    expect(result.state).not.toBe("ELIGIBLE_FOR_EXECUTION");
  });

  it("blocks unavailable market data", () => {
    const result = evaluateExecutionEligibility(orderInput({ market: null }));
    expect(result.stoppedAt).toBe("risk");
    expect(result.proposal?.risk.state).toBe("BLOCKED");
    expect(result.proposal?.risk.reasons).toEqual(["MARKET_DATA_UNAVAILABLE"]);
    expect(result.proposal?.policy).toBeNull();
    expect(result.gate).toBeNull();
  });

  it("does not let REPLAY authorize execution", () => {
    const result = evaluateExecutionEligibility(orderInput({
      provenance: "REPLAY",
      market: market("REPLAY"),
      account: account("REPLAY"),
    }));
    expect(result.stoppedAt).toBe("policy");
    expect(result.proposal?.policy?.reasons).toEqual(["REPLAY_RESEARCH_ONLY"]);
    expect(result.gate).toBeNull();
    expect(result.state).not.toBe("ELIGIBLE_FOR_EXECUTION");
  });

  it("does not let SIMULATOR provenance authorize LIVE", () => {
    const result = evaluateExecutionEligibility(orderInput({
      environment: "LIVE",
      provenance: "SIMULATOR",
      decision: decision("LONG", 1990, [2100], "LIVE"),
      orderIntent: intent("LONG", 2000, 1990, [2100], "LIVE"),
      market: market("SIMULATOR"),
      account: account("SIMULATOR"),
      autonomy: autonomy(4, "LIVE"),
      killSwitch: kill(false, "LIVE"),
    }));
    expect(result.stoppedAt).toBe("policy");
    expect(result.proposal?.policy?.reasons).toEqual(["PROVENANCE_REJECTED"]);
    expect(result.gate).toBeNull();
    expect(result.state).not.toBe("ELIGIBLE_FOR_EXECUTION");
  });

  it("blocks an engaged, missing, or malformed kill switch", () => {
    const engaged = kill(true);
    const blocked = evaluateExecutionEligibility(orderInput({ killSwitch: engaged }));
    expect(blocked.proposal?.policy?.reasons).toEqual(["KILL_SWITCH_ENGAGED"]);
    expect(blocked.approval).toBeNull();
    expect(blocked.gate).toBeNull();
    expect(engaged.engaged).toBe(true);
    expect(evaluateExecutionEligibility(orderInput({ killSwitch: null })).proposal?.policy?.reasons).toEqual(["KILL_SWITCH_UNKNOWN"]);
    expect(evaluateExecutionEligibility(orderInput({
      killSwitch: { ...kill(false), paused: true },
    })).proposal?.policy?.reasons).toEqual(["KILL_SWITCH_UNKNOWN"]);
  });

  it("blocks DESYNCED reconciliation before the fire-time gate", () => {
    const result = eligibleLevel4({ reconciliation: "DESYNCED" });
    expect(result.stoppedAt).toBe("reconciliation");
    expect(result.reconciliation).toBe("DESYNCED");
    expect(result.reasons).toEqual(["reconciliation_blocks_autonomous"]);
    expect(result.gate).toBeNull();
    expect(result.state).toBe("BLOCKED");
  });

  it("blocks UNKNOWN reconciliation before the fire-time gate", () => {
    const result = eligibleLevel4({ reconciliation: "UNKNOWN" });
    expect(result.stoppedAt).toBe("reconciliation");
    expect(result.reconciliation).toBe("UNKNOWN");
    expect(result.reasons).toEqual(["reconciliation_blocks_autonomous"]);
    expect(result.gate).toBeNull();
  });

  it("fails closed when safety configuration is missing", () => {
    const missingAge = eligibleLevel4({ gateConfig: { version: "gate-v1" } });
    expect(missingAge.stoppedAt).toBe("gate");
    expect(missingAge.gate?.reasons).toEqual(["GATE_FRESHNESS_UNCONFIGURED"]);
    expect(missingAge.state).not.toBe("ELIGIBLE_FOR_EXECUTION");
    const missingRisk = evaluateExecutionEligibility(orderInput({ riskConfig: {} }));
    expect(missingRisk.proposal?.risk.reasons).toEqual(["RISK_CONFIG_INVALID"]);
    expect(missingRisk.gate).toBeNull();
    const missingBook = eligibleLevel4({ reconciliation: undefined });
    expect(missingBook.stoppedAt).toBe("reconciliation");
    expect(missingBook.reasons).toEqual(["reconciliation_unknown"]);
    expect(missingBook.gate).toBeNull();
  });

  it("lets a valid level-3 approved proposal reach eligibility", () => {
    const input = level3();
    const result = evaluateExecutionEligibility(input);
    expect(result.approval?.reasons).toEqual(["APPROVAL_GRANTED"]);
    expect(result.gate?.state).toBe("ELIGIBLE_FOR_EXECUTION");
    expect(result.gate?.approvalId).toBe("human-1");
    expect(result.orderSubmitted).toBe(false);
  });

  it("follows approval-not-required semantics for autonomy levels 4 and 5", () => {
    const fourth = eligibleLevel4();
    const fifth = evaluateExecutionEligibility(orderInput({ autonomy: autonomy(5) }));
    expect(fourth.approval?.reasons).toEqual(["APPROVAL_NOT_REQUIRED"]);
    expect(fourth.approval?.humanApprovalId).toBeNull();
    expect(fourth.gate?.state).toBe("ELIGIBLE_FOR_EXECUTION");
    expect(fifth.approval?.reasons).toEqual(["APPROVAL_NOT_REQUIRED"]);
    expect(fifth.gate?.state).toBe("ELIGIBLE_FOR_EXECUTION");
    const supplied = orderInput({ autonomy: autonomy(4) });
    const fact = matchingFact({ ...supplied, autonomy: autonomy(3), policyApproval: "granted" });
    const withFact = evaluateExecutionEligibility({ ...supplied, approval: fact });
    expect(withFact.approval?.state).not.toBe("APPROVED");
    expect(withFact.gate).toBeNull();
  });

  it("does not call MetaApi when eligibility succeeds", () => {
    const result = eligibleLevel4();
    expect(result.gate?.state).toBe("ELIGIBLE_FOR_EXECUTION");
    expect(result.metaApiCalled).toBe(false);
    const source = readFileSync(new URL("./handoff.ts", import.meta.url), "utf8");
    expect(source).not.toContain("metaapi");
    expect(source).not.toContain("MetaApi");
    expect(source).not.toContain("fetch(");
  });

  it("does not create an execution attempt when eligibility succeeds", () => {
    const result = eligibleLevel4();
    expect(result.executionAttemptCreated).toBe(false);
    expect(result.gate?.state).toBe("ELIGIBLE_FOR_EXECUTION");
    const source = readFileSync(new URL("./handoff.ts", import.meta.url), "utf8");
    expect(source).not.toContain("submitAuthorizedExecution");
    expect(source).not.toContain("createMemoryExecutionLedger");
    expect(source).not.toContain("execution_attempts");
  });

  it("does not submit a broker order when eligibility succeeds", () => {
    const result = eligibleLevel4();
    expect(result.brokerCalled).toBe(false);
    expect(result.orderSubmitted).toBe(false);
    const source = readFileSync(new URL("./handoff.ts", import.meta.url), "utf8");
    for (const token of ["submitToBroker", "place_order", "submit_order", "execute_order", "close_position", "modify_position"]) {
      expect(source).not.toContain(token);
    }
  });

  it("repeats the same eligibility result for identical inputs", () => {
    const input = level3();
    const left = evaluateExecutionEligibility(input);
    const right = evaluateExecutionEligibility(input);
    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
    expect(left.gate?.state).toBe("ELIGIBLE_FOR_EXECUTION");
    const replay = orderInput({ provenance: "REPLAY", market: market("REPLAY"), account: account("REPLAY") });
    expect(JSON.stringify(evaluateExecutionEligibility(replay))).toBe(JSON.stringify(evaluateExecutionEligibility(replay)));
  });

  it("produces a new binding when the proposal is revised", () => {
    const original = eligibleLevel4();
    const revised = evaluateExecutionEligibility(orderInput({
      orderIntent: intent("LONG", 2001, 1990),
    }));
    expect(original.gate?.state).toBe("ELIGIBLE_FOR_EXECUTION");
    expect(revised.gate?.state).toBe("ELIGIBLE_FOR_EXECUTION");
    expect(revised.binding).not.toBe(original.binding);
    expect(revised.binding?.startsWith("bind.")).toBe(true);
    const saved = store();
    const agentRunId = routineAgentRunId(ROUTINE_RUN);
    saved.occurrences.insertRoutineOccurrence({
      routineId: "routine-1",
      routineRunId: ROUTINE_RUN,
      threadId: "thread-1",
      environment: "SIMULATOR",
      startedAt: AT,
    });
    const occurrenceId = routineOccurrenceId(ROUTINE_RUN);
    const recorded = level3({
      agentRunId,
      decision: decision("LONG", 1990, [2100], "SIMULATOR", agentRunId),
      orderIntent: intent("LONG", 2000, 1990, [2100], "SIMULATOR", agentRunId),
      autonomy: autonomy(3, "SIMULATOR", agentRunId),
      killSwitch: kill(false, "SIMULATOR", agentRunId),
      occurrence: { repository: saved.occurrences, occurrenceId },
    });
    evaluateExecutionEligibility(recorded);
    const replacement = {
      ...recorded,
      decision: decision("LONG", 1990, [2100], "SIMULATOR", agentRunId, "dec-2"),
      orderIntent: intent("LONG", 2000, 1990, [2100], "SIMULATOR", agentRunId, "intent-1", "dec-2"),
    };
    expect(() => evaluateExecutionEligibility(replacement)).toThrow(TradingDomainError);
    try {
      evaluateExecutionEligibility(replacement);
    } catch (error) {
      expect(error).toBeInstanceOf(TradingDomainError);
      expect((error as TradingDomainError).code).toBe("immutable_revision");
    }
    expect(saved.occurrences.readByOccurrenceId(occurrenceId)?.decisionId).toBe("dec-1");
  });
});
