import { describe, expect, it } from "vitest";

import { AUTONOMY_NAMES, parseAutonomyState } from "../../../shared/trading/autonomy.ts";
import { parseDecision } from "../../../shared/trading/decision.ts";
import { parseKillSwitchState } from "../../../shared/trading/kill-switch.ts";
import { parseOrderIntent } from "../../../shared/trading/order-intent.ts";
import { FORBIDDEN_EXECUTION_TOOL_NAMES, XAUUSD_TOOL_CATALOG } from "../agent/catalog.ts";
import { assessApproval } from "../approval/assess.ts";
import { metaApiExitBody } from "../execution/command.ts";
import { createMemoryExecutionLedger } from "../execution/ledger.ts";
import { createMetaApiExecutionAdapter } from "../execution/metaapi.ts";
import { submitAuthorizedExecution } from "../execution/submit.ts";
import { evaluateFireTimeGate } from "../gate/evaluate.ts";
import { evaluateXauUsdProposal } from "../proposal/evaluate.ts";
import { derivePositionLifecycle } from "./position.ts";

const AT = "2026-08-15T14:30:00.000Z";
const RUN = "run-1";
const TOKEN = "metaapi-token-value";

function exitReady() {
  const decision = parseDecision({
    schemaVersion: 1,
    id: "dec-exit",
    agentRunId: RUN,
    environment: "PAPER",
    instrument: "XAUUSD",
    createdAt: AT,
    status: "DRAFT",
    thesis: "Close the broker position.",
    contextId: "ctx-1",
    snapshotId: "snap-1",
    evidenceIds: [],
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingInformation: [],
    direction: "EXIT_EXISTING_POSITION",
    stop: 4624.5,
    targets: [4648],
    expiry: "2026-08-15T18:00:00.000Z",
    evidenceQuality: "insufficient",
    versionManifestId: "ver-1",
  });
  const orderIntent = parseOrderIntent({
    schemaVersion: 1,
    kind: "order-intent",
    id: "intent-exit",
    agentRunId: RUN,
    environment: "PAPER",
    instrument: "XAUUSD",
    decisionId: "dec-exit",
    createdAt: AT,
    direction: "EXIT_EXISTING_POSITION",
    executable: false,
    brokerSubmit: false,
    entry: 4632.5,
    stop: 4624.5,
    targets: [4648],
  });
  const input = {
    instrument: "XAUUSD" as const,
    decision,
    orderIntent,
    market: {
      snapshotId: "snap-1",
      provenance: "LIVE" as const,
      freshness: "fresh",
      providerTimestamp: AT,
      bid: 4630,
      ask: 4633,
      spread: 3,
    },
    account: {
      equity: 10_000,
      currency: "USD",
      exposureSide: "long" as const,
      exposureLots: 0.12,
      openRiskAmount: 0,
      asOf: AT,
      provenance: "LIVE" as const,
      freshness: "fresh",
      sourceId: "acct-fixture",
      sourceVersion: "v1",
    },
    riskConfig: { version: "risk-v1", maxRiskPercent: 0.02, requireStop: true },
    policyConfig: { version: "policy-v1" },
    environment: "PAPER" as const,
    provenance: "LIVE" as const,
    assessedAt: AT,
    agentRunId: RUN,
    autonomy: parseAutonomyState({
      schemaVersion: 1,
      environment: "PAPER",
      level: 4 as const,
      name: AUTONOMY_NAMES[4],
      agentRunId: RUN,
      updatedAt: AT,
    }),
    permissions: ["decision.propose" as const, "intent.propose" as const],
    approval: "absent" as const,
    killSwitch: parseKillSwitchState({
      schemaVersion: 1,
      environment: "PAPER",
      engaged: false,
      agentRunId: RUN,
      updatedAt: AT,
      source: "operator",
    }),
    requestedQuantity: 0.12,
  };
  const evaluated = evaluateXauUsdProposal(input);
  if (evaluated.policy === null) throw new Error("policy missing");
  const approval = assessApproval({
    instrument: input.instrument,
    decision,
    orderIntent,
    risk: evaluated.risk,
    policy: evaluated.policy,
    environment: input.environment,
    provenance: input.provenance,
    autonomy: input.autonomy,
    permissions: input.permissions,
    killSwitch: input.killSwitch,
    approval: null,
    config: { version: "approval-v1", maxAgeMs: 60_000 },
    evaluatedAt: AT,
    agentRunId: RUN,
    approvalRequestId: "req-exit",
    requestedQuantity: 0.12,
    evaluationRunId: "eval-1",
  });
  const gate = evaluateFireTimeGate({
    instrument: "XAUUSD",
    decision,
    orderIntent,
    risk: evaluated.risk,
    policy: evaluated.policy,
    approval,
    market: { snapshotId: "snap-1", provenance: "LIVE", freshness: "fresh", marketTimestamp: AT },
    accountEquity: 10_000,
    exposureLots: 0.12,
    environment: "PAPER",
    provenance: "LIVE",
    autonomy: input.autonomy,
    permissions: input.permissions,
    killSwitch: input.killSwitch,
    approvalFact: null,
    requestedQuantity: 0.12,
    riskConfig: input.riskConfig,
    policyConfig: input.policyConfig,
    approvalConfig: { version: "approval-v1", maxAgeMs: 60_000 },
    gateConfig: { version: "gate-v1", maxMarketAgeMs: 60_000 },
    evaluatedAt: AT,
    agentRunId: RUN,
    evaluationRunId: "eval-1",
  });
  return { input, risk: evaluated.risk, policy: evaluated.policy, approval, gate };
}

function binding() {
  return {
    schemaVersion: "xauusd-metaapi-account-1" as const,
    bindingId: "paper-binding-1",
    environment: "PAPER" as const,
    credentialSlot: "paper" as const,
    brokerSymbol: "XAUUSD" as const,
    provider: "metaapi-cloud" as const,
    region: "london",
  };
}

describe("phase 12 position lifecycle and exit", () => {
  it("does not treat an accepted order as a fill or a fill as an open position", () => {
    expect(derivePositionLifecycle({
      executionState: "SUBMISSION_ACCEPTED",
      reconciliationState: "RECONCILED",
      brokerPositionId: null,
      brokerQuantity: null,
      authorizedQuantity: 0.12,
      exitState: null,
      ambiguous: false,
    })).toBe("POSITION_PENDING");
    expect(derivePositionLifecycle({
      executionState: "FILL_REPORTED",
      reconciliationState: null,
      brokerPositionId: null,
      brokerQuantity: null,
      authorizedQuantity: 0.12,
      exitState: null,
      ambiguous: false,
    })).toBe("POSITION_UNKNOWN");
    expect(derivePositionLifecycle({
      executionState: "FILL_REPORTED",
      reconciliationState: "RECONCILED",
      brokerPositionId: "pos-9",
      brokerQuantity: 0.12,
      authorizedQuantity: 0.12,
      exitState: null,
      ambiguous: false,
    })).toBe("POSITION_OPEN");
  });

  it("keeps a partial quantity degraded and an ambiguous identity desynced", () => {
    expect(derivePositionLifecycle({
      executionState: "FILL_REPORTED",
      reconciliationState: "DEGRADED",
      brokerPositionId: "pos-9",
      brokerQuantity: 0.05,
      authorizedQuantity: 0.12,
      exitState: null,
      ambiguous: false,
    })).toBe("POSITION_PARTIALLY_OPEN");
    expect(derivePositionLifecycle({
      executionState: "SUBMISSION_ACCEPTED",
      reconciliationState: "DESYNCED",
      brokerPositionId: "pos-9",
      brokerQuantity: 0.12,
      authorizedQuantity: 0.12,
      exitState: null,
      ambiguous: false,
    })).toBe("POSITION_DESYNCED");
    expect(derivePositionLifecycle({
      executionState: "SUBMISSION_UNKNOWN",
      reconciliationState: "UNKNOWN",
      brokerPositionId: null,
      brokerQuantity: null,
      authorizedQuantity: 0.12,
      exitState: null,
      ambiguous: false,
    })).toBe("POSITION_UNKNOWN");
  });

  it("submits an authorized exit by broker position id and does not retry or resize it", async () => {
    const ready = exitReady();
    expect(ready.risk.state).toBe("ACCEPT");
    expect(ready.policy.state).toBe("ALLOW");
    expect(ready.approval.state).toBe("APPROVED");
    expect(ready.gate.state).toBe("ELIGIBLE_FOR_EXECUTION");
    const bodies: unknown[] = [];
    const adapter = createMetaApiExecutionAdapter({
      binding: binding(),
      token: TOKEN,
      accountId: "account-uuid-value",
      transport: async (request) => {
        bodies.push(request.body);
        return { kind: "response", status: 200, body: { stringCode: "TRADE_RETCODE_PLACED", orderId: "close-1" } };
      },
    });
    const ledger = createMemoryExecutionLedger();
    const first = await submitAuthorizedExecution({
      instrument: "XAUUSD",
      decision: ready.input.decision,
      orderIntent: ready.input.orderIntent,
      risk: ready.risk,
      policy: ready.policy,
      approval: ready.approval,
      gate: ready.gate,
      binding: binding(),
      quote: { bid: 4630, ask: 4633, snapshotId: "snap-1" },
      killSwitch: ready.input.killSwitch,
      environment: "PAPER",
      provenance: "LIVE",
      requestedQuantity: 0.12,
      provider: adapter,
      ledger,
      submittedAt: AT,
      agentRunId: RUN,
      exitPosition: { positionId: "pos-9", direction: "LONG", quantity: 0.12 },
    });
    expect(first.state).toBe("SUBMISSION_ACCEPTED");
    expect(first.fill).toBeNull();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ actionType: "POSITION_CLOSE_ID", positionId: "pos-9", symbol: "XAUUSD", volume: 0.12 });
    expect(JSON.stringify(bodies[0])).not.toContain(TOKEN);
    const second = await submitAuthorizedExecution({
      instrument: "XAUUSD",
      decision: ready.input.decision,
      orderIntent: ready.input.orderIntent,
      risk: ready.risk,
      policy: ready.policy,
      approval: ready.approval,
      gate: ready.gate,
      binding: binding(),
      quote: { bid: 4630, ask: 4633, snapshotId: "snap-1" },
      killSwitch: ready.input.killSwitch,
      environment: "PAPER",
      provenance: "LIVE",
      requestedQuantity: 0.12,
      provider: adapter,
      ledger,
      submittedAt: AT,
      agentRunId: RUN,
      exitPosition: { positionId: "pos-9", direction: "LONG", quantity: 0.12 },
    });
    expect(second.state).toBe("NOT_SUBMITTED");
    expect(second.reasons).toContain("DUPLICATE_EXECUTION");
    expect(bodies).toHaveLength(1);
    expect(derivePositionLifecycle({
      executionState: "FILL_REPORTED",
      reconciliationState: "RECONCILED",
      brokerPositionId: "pos-9",
      brokerQuantity: 0.12,
      authorizedQuantity: 0.12,
      exitState: "SUBMISSION_ACCEPTED",
      ambiguous: false,
    })).toBe("POSITION_CLOSING");
  });

  it("refuses an ambiguous position, a resized exit, pause, and an engaged kill switch", async () => {
    const ready = exitReady();
    const adapter = createMetaApiExecutionAdapter({
      binding: binding(),
      token: TOKEN,
      accountId: "account-uuid-value",
      transport: async () => ({ kind: "response", status: 200, body: { stringCode: "TRADE_RETCODE_PLACED", orderId: "1" } }),
    });
    const base = {
      instrument: "XAUUSD" as const,
      decision: ready.input.decision,
      orderIntent: ready.input.orderIntent,
      risk: ready.risk,
      policy: ready.policy,
      approval: ready.approval,
      gate: ready.gate,
      binding: binding(),
      quote: { bid: 4630, ask: 4633, snapshotId: "snap-1" },
      environment: "PAPER" as const,
      provenance: "LIVE" as const,
      requestedQuantity: 0.12,
      provider: adapter,
      ledger: createMemoryExecutionLedger(),
      submittedAt: AT,
      agentRunId: RUN,
    };
    const ambiguous = await submitAuthorizedExecution({
      ...base,
      killSwitch: ready.input.killSwitch,
      exitPosition: { positionId: "", direction: "LONG", quantity: 0.12 },
    });
    expect(ambiguous.brokerCalled).toBe(false);
    expect(ambiguous.reasons[0] === "POSITION_IDENTITY_AMBIGUOUS" || ambiguous.reasons[0] === "ORDER_NOT_REPRESENTABLE").toBe(true);
    const resized = await submitAuthorizedExecution({
      ...base,
      killSwitch: ready.input.killSwitch,
      exitPosition: { positionId: "pos-9", direction: "LONG", quantity: 0.05 },
    });
    expect(resized.state).toBe("NOT_SUBMITTED");
    expect(resized.reasons).toContain("SILENT_REPAIR_REJECTED");
    const paused = await submitAuthorizedExecution({
      ...base,
      killSwitch: ready.input.killSwitch,
      paused: true,
      exitPosition: { positionId: "pos-9", direction: "LONG", quantity: 0.12 },
    });
    expect(paused.reasons).toContain("PAUSED");
    expect(paused.brokerCalled).toBe(false);
    const stopped = await submitAuthorizedExecution({
      ...base,
      killSwitch: parseKillSwitchState({
        schemaVersion: 1,
        environment: "PAPER",
        engaged: true,
        agentRunId: RUN,
        updatedAt: AT,
        source: "operator",
      }),
      exitPosition: { positionId: "pos-9", direction: "LONG", quantity: 0.12 },
    });
    expect(stopped.reasons).toContain("KILL_SWITCH_ENGAGED");
    expect(stopped.brokerCalled).toBe(false);
    expect(metaApiExitBody({
      instrument: "XAUUSD",
      symbol: "XAUUSD",
      direction: "LONG",
      actionType: "POSITION_CLOSE_ID",
      positionId: "pos-9",
      volume: 0.12,
      clientId: "abc",
      executionRequestId: "exr.1",
    })).toBeNull();
    const names = XAUUSD_TOOL_CATALOG.map((tool) => tool.name);
    for (const banned of [...FORBIDDEN_EXECUTION_TOOL_NAMES, "close_position", "execute_order", "modify_position"]) {
      expect(names).not.toContain(banned);
    }
  });
});
