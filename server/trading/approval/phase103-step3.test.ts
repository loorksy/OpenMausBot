import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AUTONOMY_NAMES, parseAutonomyState } from "../../../shared/trading/autonomy.ts";
import { parseDecision } from "../../../shared/trading/decision.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { parseKillSwitchState } from "../../../shared/trading/kill-switch.ts";
import { parseOrderIntent } from "../../../shared/trading/order-intent.ts";
import { routineAgentRunId, routineOccurrenceId } from "../occurrence/identity.ts";
import { openTradingStore, type TradingStore } from "../persistence/store.ts";
import { evaluateXauUsdProposal } from "../proposal/evaluate.ts";
import { assessApproval } from "./assess.ts";
import { PROPOSAL_BINDING_VERSION } from "./binding.ts";
import {
  openTradingApproval,
  settleNativeTradingApproval,
  settleNativeTradingApprovalFromEnvironment,
  type NativeApprovalResolution,
} from "./native.ts";

const AT = "2026-08-15T14:30:00.000Z";
const PLUS_MINUTE = "2026-08-15T14:31:00.000Z";
const PLUS_TWO_MINUTES = "2026-08-15T14:32:00.000Z";
const ROUTINE_RUN = "22222222-2222-4222-8222-222222222222";
const REQUEST = "req-trading-1";
const REQUESTER = "owner";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "xauusd-approval-"));
  dirs.push(dir);
  return dir;
}

function store(): TradingStore {
  return openTradingStore({ path: join(tempDir(), "trading.db"), environment: "SIMULATOR" });
}

function prepared(entry = 2000) {
  const agentRunId = routineAgentRunId(ROUTINE_RUN);
  const decision = parseDecision({
    schemaVersion: 1,
    id: "dec-1",
    agentRunId,
    environment: "SIMULATOR",
    instrument: "XAUUSD",
    createdAt: AT,
    status: "DRAFT",
    thesis: "A proposal waiting for a person.",
    contextId: "ctx-1",
    snapshotId: "snap-1",
    evidenceIds: [],
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingInformation: ["no independent target review"],
    direction: "LONG",
    stop: 1990,
    targets: [2100],
    expiry: "2026-08-15T18:00:00.000Z",
    evidenceQuality: "insufficient",
    versionManifestId: "ver-1",
  });
  const orderIntent = parseOrderIntent({
    schemaVersion: 1,
    kind: "order-intent",
    id: "intent-1",
    agentRunId,
    environment: "SIMULATOR",
    instrument: "XAUUSD",
    decisionId: "dec-1",
    createdAt: AT,
    direction: "LONG",
    executable: false,
    brokerSubmit: false,
    entry,
    stop: 1990,
    targets: [2100],
  });
  const autonomy = parseAutonomyState({
    schemaVersion: 1,
    environment: "SIMULATOR",
    level: 3,
    name: AUTONOMY_NAMES[3],
    agentRunId,
    updatedAt: AT,
  });
  const killSwitch = parseKillSwitchState({
    schemaVersion: 1,
    environment: "SIMULATOR",
    engaged: false,
    agentRunId,
    updatedAt: AT,
    source: "operator",
  });
  const evaluated = evaluateXauUsdProposal({
    instrument: "XAUUSD",
    decision,
    orderIntent,
    market: {
      snapshotId: "snap-1",
      provenance: "SIMULATOR",
      freshness: "fresh",
      providerTimestamp: AT,
      bid: 1999.5,
      ask: 2000.5,
      spread: 1,
    },
    account: {
      equity: 10_000,
      currency: "USD",
      exposureSide: "none",
      exposureLots: 0,
      openRiskAmount: 0,
      asOf: AT,
      provenance: "SIMULATOR",
      freshness: "fresh",
      sourceId: "acct-fixture",
      sourceVersion: "v1",
    },
    riskConfig: { version: "risk-v1", maxRiskPercent: 0.01, requireStop: true },
    policyConfig: { version: "policy-v1" },
    environment: "SIMULATOR",
    provenance: "SIMULATOR",
    assessedAt: AT,
    agentRunId,
    autonomy,
    permissions: ["decision.propose", "intent.propose"],
    approval: "granted",
    killSwitch,
  });
  if (evaluated.policy === null) throw new Error("policy was not produced");
  return {
    agentRunId,
    assessment: {
      instrument: "XAUUSD" as const,
      decision,
      orderIntent,
      risk: evaluated.risk,
      policy: evaluated.policy,
      environment: "SIMULATOR" as const,
      provenance: "SIMULATOR" as const,
      autonomy,
      permissions: ["decision.propose", "intent.propose"] as const,
      killSwitch,
      config: { version: "approval-v1", maxAgeMs: 60_000 },
      agentRunId,
      approvalRequestId: REQUEST,
      requestedQuantity: null,
      evaluationRunId: "eval-1",
      runtimeThreadId: "thread-1",
      runtimeTurnId: "turn-1",
    },
  };
}

function resolution(patch: Partial<NativeApprovalResolution> = {}): NativeApprovalResolution {
  return {
    requestId: REQUEST,
    behavior: "answer",
    message: "approve",
    source: "user",
    responderId: REQUESTER,
    resolvedAt: PLUS_MINUTE,
    ...patch,
  };
}

describe("native trading approval", () => {
  it("turns an explicit user answer into an assessApproval result and leaves ordinary requests alone", () => {
    const db = store();
    db.occurrences.insertRoutineOccurrence({
      routineId: "routine-1",
      routineRunId: ROUTINE_RUN,
      threadId: "thread-1",
      environment: "SIMULATOR",
      startedAt: AT,
    });
    const { assessment } = prepared();
    const opened = openTradingApproval(db, {
      requestId: REQUEST,
      occurrenceId: routineOccurrenceId(ROUTINE_RUN),
      requesterId: REQUESTER,
      openedAt: AT,
      assessment,
    });
    expect(opened.proposalBinding.startsWith("bind.")).toBe(true);
    expect(opened.expiresAt).toBe(PLUS_MINUTE);
    expect(settleNativeTradingApproval(db, resolution({ requestId: "req-ordinary" }))).toEqual({ kind: "ordinary" });
    const settled = settleNativeTradingApproval(db, resolution());
    expect(settled.kind).toBe("trading");
    if (settled.kind !== "trading") return;
    expect(settled.idempotent).toBe(false);
    expect(settled.decision.state).toBe("APPROVED");
    expect(settled.decision.reasons).toEqual(["APPROVAL_GRANTED"]);
    expect(settled.fact?.approved).toBe(true);
    expect(settled.fact?.approvalRequestId).toBe(REQUEST);
    expect(settled.fact?.proposalBinding).toBe(opened.proposalBinding);
    expect(db.occurrences.readByOccurrenceId(routineOccurrenceId(ROUTINE_RUN))?.approvalId).toBe(settled.decision.id);
    const again = settleNativeTradingApproval(db, resolution());
    expect(again).toMatchObject({ kind: "trading", idempotent: true, decision: { id: settled.decision.id, state: "APPROVED" } });
    db.close();
  });

  it("fails closed for permission allow, the wrong person, a malformed answer, and an expired request", () => {
    const cases: Array<{ patch: Partial<NativeApprovalResolution>; state: string }> = [
      { patch: { behavior: "allow", message: undefined }, state: "INVALID" },
      { patch: { responderId: "someone-else" }, state: "INVALID" },
      { patch: { message: "yes please" }, state: "INVALID" },
      { patch: { source: "auto" }, state: "INVALID" },
      { patch: { resolvedAt: PLUS_TWO_MINUTES }, state: "INVALID" },
      { patch: { message: "reject" }, state: "REJECTED" },
    ];
    for (const candidate of cases) {
      const db = store();
      db.occurrences.insertRoutineOccurrence({
        routineId: "routine-1",
        routineRunId: ROUTINE_RUN,
        threadId: "thread-1",
        environment: "SIMULATOR",
        startedAt: AT,
      });
      const { assessment } = prepared();
      openTradingApproval(db, {
        requestId: REQUEST,
        occurrenceId: routineOccurrenceId(ROUTINE_RUN),
        requesterId: REQUESTER,
        openedAt: AT,
        assessment,
      });
      const settled = settleNativeTradingApproval(db, resolution(candidate.patch));
      expect(settled.kind).toBe("trading");
      if (settled.kind !== "trading") continue;
      expect(settled.decision.state).toBe(candidate.state);
      expect(settled.fact?.approved === true).toBe(false);
      expect(() => settleNativeTradingApproval(db, resolution())).toThrow(TradingDomainError);
      db.close();
    }
  });

  it("requires a new approval when the proposal changes and does not open the fire-time gate", () => {
    const db = store();
    db.occurrences.insertRoutineOccurrence({
      routineId: "routine-1",
      routineRunId: ROUTINE_RUN,
      threadId: "thread-1",
      environment: "SIMULATOR",
      startedAt: AT,
    });
    const first = prepared();
    const opened = openTradingApproval(db, {
      requestId: REQUEST,
      occurrenceId: routineOccurrenceId(ROUTINE_RUN),
      requesterId: REQUESTER,
      openedAt: AT,
      assessment: first.assessment,
    });
    const moved = prepared(2001);
    expect(() => openTradingApproval(db, {
      requestId: "req-trading-2",
      occurrenceId: routineOccurrenceId(ROUTINE_RUN),
      requesterId: REQUESTER,
      openedAt: AT,
      assessment: { ...moved.assessment, approvalRequestId: "req-trading-2" },
    })).not.toThrow();
    const second = db.approvals.read("req-trading-2");
    expect(second?.proposalBinding).not.toBe(opened.proposalBinding);
    const mismatched = assessApproval({
      ...moved.assessment,
      approvalRequestId: "req-trading-2",
      evaluatedAt: PLUS_MINUTE,
      approval: {
        approvalId: "apr-old",
        approvalRequestId: "req-trading-2",
        approved: true,
        approvedBy: REQUESTER,
        approvedAt: PLUS_MINUTE,
        decisionId: "dec-1",
        orderIntentId: "intent-1",
        riskDecisionId: first.assessment.risk.id,
        policyDecisionId: first.assessment.policy.id,
        environment: "SIMULATOR",
        instrument: "XAUUSD",
        approvalPolicyVersion: "approval-v1",
        proposalBinding: opened.proposalBinding,
      },
    });
    expect(mismatched.reasons).toContain("APPROVAL_MISMATCH");
    expect(settleNativeTradingApprovalFromEnvironment({}, resolution())).toEqual({ kind: "ordinary" });
    expect(PROPOSAL_BINDING_VERSION).toBe("xauusd-proposal-binding-1");
    db.close();
  });
});
