import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AUTONOMY_NAMES, parseAutonomyState, type AutonomyLevel } from "../../../shared/trading/autonomy.ts";
import { parseDecision, type DecisionDirection } from "../../../shared/trading/decision.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { parseKillSwitchState, type KillSwitchState } from "../../../shared/trading/kill-switch.ts";
import { parseOrderIntent, type OrderIntentDirection } from "../../../shared/trading/order-intent.ts";
import { FORBIDDEN_EXECUTION_TOOL_NAMES, XAUUSD_TOOL_CATALOG } from "../agent/catalog.ts";
import { assessApproval } from "../approval/assess.ts";
import { foundationControl } from "../control/boundaries.ts";
import { evaluateFireTimeGate, type FireTimeGateInput } from "../gate/evaluate.ts";
import type { GateDecision } from "../gate/result.ts";
import { evaluateXauUsdProposal, type ProposalInput } from "../proposal/evaluate.ts";
import { createMemoryExecutionLedger } from "./ledger.ts";
import { createMetaApiExecutionAdapter } from "./metaapi.ts";
import type { MetaApiTransport, XauUsdExecutionProvider } from "./provider.ts";
import { killSwitchAuthorityFromValue } from "../persistence/kill-switch.ts";
import { openTradingStore } from "../persistence/store.ts";
import { submitAuthorizedExecution, type ExecutionSubmitInput } from "./submit.ts";
import { translateMetaApiTradeResponse } from "./translate.ts";

const AT = "2026-08-15T14:30:00.000Z";
const RUN = "run-1";
const TOKEN = "metaapi-token-value";
const ACCOUNT = "account-uuid-value";

function decision(
  direction: DecisionDirection,
  stop?: number,
  targets: number[] = [4648],
  environment = "PAPER",
) {
  return parseDecision({
    schemaVersion: 1,
    id: "dec-1",
    agentRunId: RUN,
    environment,
    instrument: "XAUUSD",
    createdAt: AT,
    status: "DRAFT",
    thesis: "A proposal for the execution boundary.",
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
  targets: number[] = [4648],
  environment = "PAPER",
) {
  return parseOrderIntent({
    schemaVersion: 1,
    kind: "order-intent",
    id: "intent-1",
    agentRunId: RUN,
    environment,
    instrument: "XAUUSD",
    decisionId: "dec-1",
    createdAt: AT,
    direction,
    executable: false,
    brokerSubmit: false,
    entry,
    ...(stop === undefined ? {} : { stop }),
    targets,
  });
}

function autonomy(level: AutonomyLevel, environment = "PAPER") {
  return parseAutonomyState({
    schemaVersion: 1,
    environment,
    level,
    name: AUTONOMY_NAMES[level],
    agentRunId: RUN,
    updatedAt: AT,
  });
}

function kill(engaged: boolean, environment = "PAPER"): KillSwitchState {
  return parseKillSwitchState({
    schemaVersion: 1,
    environment,
    engaged,
    agentRunId: RUN,
    updatedAt: AT,
    source: "operator",
  });
}

function proposal(overrides: Partial<ProposalInput> = {}): ProposalInput {
  return {
    instrument: "XAUUSD",
    decision: decision("LONG", 4624.5, [4648]),
    orderIntent: intent("LONG", 4632.5, 4624.5, [4648]),
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
    agentRunId: RUN,
    autonomy: autonomy(4),
    permissions: ["decision.propose", "intent.propose"],
    approval: "absent",
    killSwitch: kill(false),
    requestedQuantity: 0.12,
    ...overrides,
  };
}

function binding(environment: "PAPER" | "LIVE" = "PAPER") {
  return {
    schemaVersion: "xauusd-metaapi-account-1" as const,
    bindingId: environment === "PAPER" ? "paper-binding-1" : "live-binding-1",
    environment,
    credentialSlot: environment === "PAPER" ? "paper" as const : "live" as const,
    brokerSymbol: "XAUUSD" as const,
    provider: "metaapi-cloud" as const,
    region: "london",
  };
}

function prepared(overrides: Partial<ProposalInput> = {}) {
  const input = proposal(overrides);
  const evaluated = evaluateXauUsdProposal(input);
  if (evaluated.policy === null) throw new Error("policy missing");
  const approval = assessApproval({
    instrument: input.instrument,
    decision: input.decision,
    orderIntent: input.orderIntent,
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
    approvalRequestId: "req-1",
    requestedQuantity: input.requestedQuantity ?? null,
    evaluationRunId: "eval-1",
  });
  const gateInput: FireTimeGateInput = {
    instrument: "XAUUSD",
    decision: input.decision,
    orderIntent: input.orderIntent,
    risk: evaluated.risk,
    policy: evaluated.policy,
    approval,
    market: { snapshotId: "snap-1", provenance: input.provenance, freshness: "fresh", marketTimestamp: AT },
    accountEquity: 10_000,
    exposureLots: 0,
    environment: input.environment,
    provenance: input.provenance,
    autonomy: input.autonomy,
    permissions: input.permissions,
    killSwitch: input.killSwitch,
    approvalFact: null,
    requestedQuantity: input.requestedQuantity ?? null,
    riskConfig: input.riskConfig,
    policyConfig: input.policyConfig,
    approvalConfig: { version: "approval-v1", maxAgeMs: 60_000 },
    gateConfig: { version: "gate-v1", maxMarketAgeMs: 60_000 },
    evaluatedAt: AT,
    agentRunId: RUN,
    evaluationRunId: "eval-1",
  };
  const gate = evaluateFireTimeGate(gateInput);
  return { input, risk: evaluated.risk, policy: evaluated.policy, approval, gate };
}

function provider(responses: Array<"accepted" | "rejected" | "unknown" | "filled">) {
  const commands: unknown[] = [];
  let calls = 0;
  return {
    commands,
    calls: () => calls,
    provider: {
      providerId: "metaapi-cloud" as const,
      bindingId: "paper-binding-1",
      configured: true,
      submit: async (command: unknown) => {
        calls += 1;
        commands.push(command);
        const next = responses[calls - 1] ?? "accepted";
        if (next === "unknown") {
          return { kind: "unknown" as const, brokerRequestId: null, brokerCode: null, fillPrice: null, fillVolume: null, brokerFillId: null };
        }
        if (next === "rejected") {
          return { kind: "rejected" as const, brokerRequestId: "ticket-9", brokerCode: "TRADE_RETCODE_INVALID_VOLUME", fillPrice: null, fillVolume: null, brokerFillId: null };
        }
        if (next === "filled") {
          const volume = (command as { volume: number }).volume;
          return { kind: "filled" as const, brokerRequestId: "ticket-1", brokerCode: "TRADE_RETCODE_DONE", fillPrice: 4632.5, fillVolume: volume, brokerFillId: "deal-1" };
        }
        return { kind: "accepted" as const, brokerRequestId: "ticket-1", brokerCode: "TRADE_RETCODE_DONE", fillPrice: null, fillVolume: null, brokerFillId: null };
      },
    },
  };
}

function executionInput(
  ready: ReturnType<typeof prepared>,
  broker: XauUsdExecutionProvider,
  ledger = createMemoryExecutionLedger(),
  extra: Record<string, unknown> = {},
): ExecutionSubmitInput {
  return {
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
    environment: ready.input.environment,
    provenance: ready.input.provenance,
    requestedQuantity: ready.input.requestedQuantity ?? null,
    provider: broker,
    ledger,
    submittedAt: AT,
    agentRunId: RUN,
    evaluationRunId: "eval-1",
    ...extra,
    killSwitchAuthority: (extra.killSwitchAuthority as ExecutionSubmitInput["killSwitchAuthority"]) ?? killSwitchAuthorityFromValue(
      Object.prototype.hasOwnProperty.call(extra, "killSwitch") ? extra.killSwitch : ready.input.killSwitch,
    ),
  } as ExecutionSubmitInput;
}

describe("execution boundary", () => {
  it("submits an eligible XAUUSD proposal without changing it or treating acknowledgement as a fill", async () => {
    const ready = prepared();
    expect(ready.gate.state).toBe("ELIGIBLE_FOR_EXECUTION");
    expect(ready.risk.trace.acceptedQuantity).toBe(ready.risk.trace.requestedQuantity);
    const broker = provider(["accepted"]);
    const before = {
      entry: ready.input.orderIntent?.entry,
      stop: ready.input.orderIntent?.stop,
      targets: [...(ready.input.orderIntent?.targets ?? [])],
      direction: ready.input.orderIntent?.direction,
      quantity: ready.risk.trace.acceptedQuantity,
    };
    const result = await submitAuthorizedExecution(executionInput(ready, broker.provider));
    expect(result.state).toBe("SUBMISSION_ACCEPTED");
    expect(result.reasons).toEqual(["ACKNOWLEDGED"]);
    expect(result.fill).toBeNull();
    expect(result.brokerCalled).toBe(true);
    expect(result.simulatorFallback).toBe(false);
    expect(result.retried).toBe(false);
    expect(result.agentRunId).toBe(RUN);
    expect(result.quantity).toBe(before.quantity);
    expect(result.entry).toBe(4632.5);
    expect(result.stop).toBe(4624.5);
    expect(result.takeProfit).toBe(4648);
    expect(result.direction).toBe("LONG");
    expect(broker.calls()).toBe(1);
    expect(broker.commands[0]).toMatchObject({
      instrument: "XAUUSD",
      symbol: "XAUUSD",
      direction: "LONG",
      actionType: "ORDER_TYPE_BUY_LIMIT",
      volume: before.quantity,
      openPrice: 4632.5,
      stopLoss: 4624.5,
      takeProfit: 4648,
    });
    expect(ready.input.orderIntent?.entry).toBe(before.entry);
    expect(ready.input.orderIntent?.stop).toBe(before.stop);
    expect(ready.input.orderIntent?.direction).toBe(before.direction);
    expect(ready.input.orderIntent?.executable).toBe(false);
    expect(ready.risk.trace.acceptedQuantity).toBe(before.quantity);
    expect(result.events.map((event) => event.type)).toEqual(["execution.requested", "execution.accepted"]);
    expect(result.events[1]?.payload).toMatchObject({
      decisionId: "dec-1",
      orderIntentId: "intent-1",
      riskDecisionId: ready.risk.id,
      policyDecisionId: ready.policy.id,
      approvalDecisionId: ready.approval.id,
      gateId: ready.gate.id,
      provenance: "LIVE",
    });
    expect(result.events[1]).toMatchObject({ agentRunId: RUN, correlationId: "eval-1", environment: "PAPER" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(ACCOUNT);
  });

  it("rejects every gate state other than ELIGIBLE_FOR_EXECUTION before calling MetaApi", async () => {
    const ready = prepared();
    for (const state of ["ANALYSIS_ONLY", "RECOMMENDATION_ONLY", "REQUIRES_APPROVAL", "REJECTED", "BLOCKED", "INVALID"]) {
      const broker = provider(["accepted"]);
      const gate = { ...ready.gate, state } as GateDecision;
      const result = await submitAuthorizedExecution(executionInput(ready, broker.provider, createMemoryExecutionLedger(), { gate }));
      expect(result.state).toBe("NOT_SUBMITTED");
      expect(result.reasons).toEqual(["GATE_NOT_ELIGIBLE"]);
      expect(broker.calls()).toBe(0);
    }
  });

  it("keeps replay, simulator, stale, and unavailable provenance away from a live account", async () => {
    const ready = prepared();
    for (const [provenance, reason] of [
      ["REPLAY", "REPLAY_RESEARCH_ONLY"],
      ["SIMULATOR", "PROVENANCE_REJECTED"],
      ["STALE", "PROVENANCE_REJECTED"],
      ["UNAVAILABLE", "PROVENANCE_REJECTED"],
    ] as const) {
      const broker = provider(["accepted"]);
      const gate = { ...ready.gate, provenance } as GateDecision;
      const result = await submitAuthorizedExecution(executionInput(ready, broker.provider, createMemoryExecutionLedger(), {
        gate,
        provenance,
        binding: binding("LIVE"),
        provider: { ...broker.provider, bindingId: "live-binding-1" },
        environment: "LIVE",
      }));
      expect(result.reasons).toEqual([reason]);
      expect(result.brokerCalled).toBe(false);
      expect(broker.calls()).toBe(0);
      expect(result.provenance).not.toBe("LIVE");
    }
  });

  it("rejects a missing, wrong, or non-XAUUSD account binding and a simulator environment", async () => {
    const ready = prepared();
    const missing = provider(["accepted"]);
    expect((await submitAuthorizedExecution(executionInput(ready, missing.provider, createMemoryExecutionLedger(), { binding: null }))).reasons).toEqual(["ACCOUNT_BINDING_MISSING"]);
    expect(missing.calls()).toBe(0);
    const wrong = provider(["accepted"]);
    const wrongResult = await submitAuthorizedExecution(executionInput(ready, wrong.provider, createMemoryExecutionLedger(), {
      binding: binding("LIVE"),
      provider: { ...wrong.provider, bindingId: "live-binding-1" },
    }));
    expect(wrongResult.reasons).toEqual(["ACCOUNT_BINDING_MISMATCH"]);
    expect(wrong.calls()).toBe(0);
    const foreign = provider(["accepted"]);
    expect((await submitAuthorizedExecution(executionInput(ready, foreign.provider, createMemoryExecutionLedger(), { instrument: "EURUSD" }))).reasons).toEqual(["INVALID_INSTRUMENT"]);
    expect(foreign.calls()).toBe(0);
    const simulator = prepared({
      environment: "SIMULATOR",
      provenance: "SIMULATOR",
      market: { snapshotId: "snap-1", provenance: "SIMULATOR", freshness: "fresh", providerTimestamp: AT, bid: 4630, ask: 4633, spread: 3 },
      account: { equity: 10_000, currency: "USD", exposureSide: "none", exposureLots: 0, openRiskAmount: 0, asOf: AT, provenance: "SIMULATOR", freshness: "fresh", sourceId: "acct-fixture", sourceVersion: "v1" },
      autonomy: autonomy(4, "SIMULATOR"),
      killSwitch: kill(false, "SIMULATOR"),
      decision: decision("LONG", 4624.5, [4648], "SIMULATOR"),
      orderIntent: intent("LONG", 4632.5, 4624.5, [4648], "SIMULATOR"),
    });
    expect(simulator.gate.state).toBe("ELIGIBLE_FOR_EXECUTION");
    const simBroker = provider(["accepted"]);
    const blocked = await submitAuthorizedExecution(executionInput(simulator, simBroker.provider, createMemoryExecutionLedger(), {
      environment: "SIMULATOR",
      provenance: "SIMULATOR",
    }));
    expect(blocked.reasons).toEqual(["PROVENANCE_REJECTED"]);
    expect(simBroker.calls()).toBe(0);
  });

  it("detects a duplicate identity, keeps it stable, and blocks an unknown attempt", async () => {
    const ready = prepared();
    const other = prepared({
      decision: decision("LONG", 4620, [4648]),
      orderIntent: intent("LONG", 4632.5, 4620, [4648]),
    });
    const firstBroker = provider(["accepted"]);
    const ledger = createMemoryExecutionLedger();
    const first = await submitAuthorizedExecution(executionInput(ready, firstBroker.provider, ledger));
    const second = await submitAuthorizedExecution(executionInput(ready, firstBroker.provider, ledger));
    expect(firstBroker.calls()).toBe(1);
    expect(second.reasons).toEqual(["DUPLICATE_EXECUTION"]);
    expect(second.brokerCalled).toBe(false);
    expect(second.id).not.toBe(first.id);
    const repeat = await submitAuthorizedExecution(executionInput(ready, provider(["accepted"]).provider));
    expect(repeat.executionIdentity).toBe(first.executionIdentity);
    expect(other.gate.state).toBe("ELIGIBLE_FOR_EXECUTION");
    const otherResult = await submitAuthorizedExecution(executionInput(other, provider(["accepted"]).provider));
    expect(otherResult.executionIdentity).not.toBe(first.executionIdentity);
    const unknownBroker = provider(["unknown"]);
    const unknownLedger = createMemoryExecutionLedger();
    const unknown = await submitAuthorizedExecution(executionInput(ready, unknownBroker.provider, unknownLedger));
    const blocked = await submitAuthorizedExecution(executionInput(ready, unknownBroker.provider, unknownLedger));
    expect(unknown.state).toBe("SUBMISSION_UNKNOWN");
    expect(unknownBroker.calls()).toBe(1);
    expect(blocked.reasons).toEqual(["RECONCILIATION_REQUIRED"]);
    expect(blocked.brokerCalled).toBe(false);
  });

  it("records an explicit broker rejection, an explicit fill, and a kill switch without clearing it", async () => {
    const ready = prepared();
    const rejectedBroker = provider(["rejected"]);
    const rejected = await submitAuthorizedExecution(executionInput(ready, rejectedBroker.provider));
    expect(rejected.state).toBe("SUBMISSION_REJECTED");
    expect(rejected.fill).toBeNull();
    expect(rejected.events.map((event) => event.type)).toEqual(["execution.requested", "execution.failed"]);
    const filledBroker = provider(["filled"]);
    const filled = await submitAuthorizedExecution(executionInput(ready, filledBroker.provider));
    expect(filled.state).toBe("FILL_REPORTED");
    expect(filled.fill).toMatchObject({ brokerFillId: "deal-1", price: 4632.5, volume: ready.risk.trace.acceptedQuantity });
    expect(filled.quantity).toBe(ready.risk.trace.acceptedQuantity);
    expect(filled.events.map((event) => event.type)).toContain("execution.filled");
    const engaged = kill(true);
    const blockedBroker = provider(["accepted"]);
    const blocked = await submitAuthorizedExecution(executionInput(ready, blockedBroker.provider, createMemoryExecutionLedger(), { killSwitch: engaged }));
    expect(blocked.reasons).toEqual(["KILL_SWITCH_ENGAGED"]);
    expect(engaged.engaged).toBe(true);
    expect(blockedBroker.calls()).toBe(0);
    const malformed = provider(["accepted"]);
    expect((await submitAuthorizedExecution(executionInput(ready, malformed.provider, createMemoryExecutionLedger(), {
      killSwitch: { ...kill(false), paused: true },
    }))).reasons).toEqual(["KILL_SWITCH_UNKNOWN"]);
    expect(malformed.calls()).toBe(0);
    expect((await submitAuthorizedExecution(executionInput(ready, provider(["accepted"]).provider, createMemoryExecutionLedger(), { killSwitch: null }))).reasons).toEqual(["KILL_SWITCH_UNKNOWN"]);
  });

  it("fails closed without credentials, does not fall back, and leaves no secret in the result", async () => {
    const ready = prepared();
    const calls: unknown[] = [];
    const transport: MetaApiTransport = async (request) => {
      calls.push(request.body);
      if (request.token !== TOKEN) throw new Error("wrong token");
      return { kind: "response", status: 200, body: { stringCode: "TRADE_RETCODE_DONE", orderId: "47067192", message: `token ${TOKEN} account ${ACCOUNT}` } };
    };
    const missing = createMetaApiExecutionAdapter({ binding: binding(), token: "", accountId: ACCOUNT, transport });
    expect(missing.configured).toBe(false);
    const missingResult = await submitAuthorizedExecution(executionInput(ready, missing));
    expect(missingResult.reasons).toEqual(["CREDENTIALS_MISSING"]);
    expect(missingResult.brokerCalled).toBe(false);
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(missing)).not.toContain(TOKEN);
    const leaking: MetaApiTransport = async () => {
      throw new Error(`connect failed ${TOKEN} ${ACCOUNT}`);
    };
    const adapter = createMetaApiExecutionAdapter({ binding: binding(), token: TOKEN, accountId: ACCOUNT, transport: leaking });
    const failed = await submitAuthorizedExecution(executionInput(ready, adapter));
    expect(failed.state).toBe("SUBMISSION_UNKNOWN");
    expect(failed.provenance).toBe("LIVE");
    expect(JSON.stringify(failed)).not.toContain(TOKEN);
    expect(JSON.stringify(failed)).not.toContain(ACCOUNT);
    expect(JSON.stringify(adapter)).not.toContain(TOKEN);
    const seen: unknown[] = [];
    const once = createMetaApiExecutionAdapter({
      binding: binding(),
      token: TOKEN,
      accountId: ACCOUNT,
      transport: async (request) => {
        seen.push(request);
        return { kind: "timeout" };
      },
    });
    const timed = await submitAuthorizedExecution(executionInput(ready, once));
    expect(timed.state).toBe("SUBMISSION_UNKNOWN");
    expect(seen).toHaveLength(1);
    expect(timed.retried).toBe(false);
    const acknowledged = createMetaApiExecutionAdapter({
      binding: binding(),
      token: TOKEN,
      accountId: ACCOUNT,
      transport: async () => ({ kind: "response", status: 200, body: { stringCode: "TRADE_RETCODE_DONE", orderId: "47067192", message: TOKEN } }),
    });
    const ack = await submitAuthorizedExecution(executionInput(ready, acknowledged));
    expect(ack.state).toBe("SUBMISSION_ACCEPTED");
    expect(ack.fill).toBeNull();
    expect(JSON.stringify(ack)).not.toContain(TOKEN);
    expect(ack.events.every((event) => !JSON.stringify(event).includes(TOKEN))).toBe(true);
  });
});

describe("MetaApi response translation", () => {
  it("treats done as acknowledgement, explicit fill as fill, and everything ambiguous as unknown", () => {
    expect(translateMetaApiTradeResponse({ stringCode: "TRADE_RETCODE_DONE", orderId: "47067192" }, 0.12).kind).toBe("accepted");
    expect(translateMetaApiTradeResponse({ stringCode: "TRADE_RETCODE_DONE", orderId: "47067192" }, 0.12).fillPrice).toBeNull();
    expect(translateMetaApiTradeResponse({
      stringCode: "TRADE_RETCODE_DONE",
      orderId: "47067192",
      orderState: "ORDER_STATE_FILLED",
      dealId: "deal-1",
      fillPrice: 4632.5,
      fillVolume: 0.12,
    }, 0.12).kind).toBe("filled");
    expect(translateMetaApiTradeResponse({
      stringCode: "TRADE_RETCODE_DONE",
      orderId: "47067192",
      orderState: "ORDER_STATE_FILLED",
      dealId: "deal-1",
      fillPrice: 4632.5,
      fillVolume: 0.1,
    }, 0.12).kind).toBe("unknown");
    expect(translateMetaApiTradeResponse({ stringCode: "TRADE_RETCODE_INVALID_VOLUME", orderId: "9" }, 0.12).kind).toBe("rejected");
    expect(translateMetaApiTradeResponse({ stringCode: "TRADE_RETCODE_TIMEOUT" }, 0.12).kind).toBe("unknown");
    expect(translateMetaApiTradeResponse({ message: "maybe" }, 0.12).kind).toBe("unknown");
    expect(translateMetaApiTradeResponse({ stringCode: "TRADE_RETCODE_DONE", orderId: "1", volume: 0.1 }, 0.12).kind).toBe("unknown");
  });

  it("does not send a market order or expose an execution tool to the catalog", async () => {
    const calls: unknown[] = [];
    const adapter = createMetaApiExecutionAdapter({
      binding: binding(),
      token: TOKEN,
      accountId: ACCOUNT,
      transport: async (request) => {
        calls.push(request.body);
        return { kind: "response", status: 200, body: { stringCode: "TRADE_RETCODE_DONE", orderId: "1" } };
      },
    });
    const refused = await adapter.submit({
      instrument: "XAUUSD",
      symbol: "XAUUSD",
      direction: "LONG",
      actionType: "ORDER_TYPE_BUY" as "ORDER_TYPE_BUY_LIMIT",
      volume: 0.12,
      openPrice: 4632.5,
      stopLoss: 4624.5,
      takeProfit: 4648,
      clientId: "abc",
      executionRequestId: "exr.1",
    });
    expect(refused.kind).toBe("rejected");
    expect(calls).toHaveLength(0);
    const names = XAUUSD_TOOL_CATALOG.map((tool) => tool.name);
    for (const banned of [...FORBIDDEN_EXECUTION_TOOL_NAMES, "execute_trade", "metaapi_execute", "mt5_order"]) {
      expect(names).not.toContain(banned);
    }
    expect(() => foundationControl.submitToBroker()).toThrow(TradingDomainError);
    const text = implementationSource();
    for (const token of ["Date.now", "Math.random", "fetch(", "place_order", "submit_order", "execute_trade", "MetaTrader5", "console.log", "console.error"]) {
      expect(text).not.toContain(token);
    }
    const secretInput = executionInput(prepared(), provider(["accepted"]).provider);
    const leaked = await submitAuthorizedExecution({ ...secretInput, token: TOKEN } as ExecutionSubmitInput);
    expect(leaked.reasons).toEqual(["CREDENTIALS_FORBIDDEN"]);
    expect(JSON.stringify(leaked)).not.toContain(TOKEN);
  });
});

describe("authoritative kill switch", () => {
  it("does not let a caller-supplied open switch bypass a stored engaged or missing switch", async () => {
    const ready = prepared();
    const dir = mkdtempSync(join(tmpdir(), "xauusd-kill-"));
    const saved = openTradingStore({ path: join(dir, "trading.db"), environment: "PAPER" });
    const open = ready.input.killSwitch;
    const missing = await submitAuthorizedExecution(executionInput(ready, provider(["accepted"]).provider, createMemoryExecutionLedger(), {
      killSwitch: open,
      killSwitchAuthority: saved.killSwitches.authority(),
    }));
    expect(missing.reasons).toEqual(["KILL_SWITCH_UNKNOWN"]);
    expect(missing.brokerCalled).toBe(false);
    saved.killSwitches.write(parseKillSwitchState({
      schemaVersion: 1,
      environment: "PAPER",
      engaged: true,
      agentRunId: RUN,
      updatedAt: AT,
      source: "operator",
    }));
    const stopped = await submitAuthorizedExecution(executionInput(ready, provider(["accepted"]).provider, createMemoryExecutionLedger(), {
      killSwitch: open,
      killSwitchAuthority: saved.killSwitches.authority(),
    }));
    expect(stopped.reasons).toEqual(["KILL_SWITCH_ENGAGED"]);
    expect(stopped.brokerCalled).toBe(false);
    saved.killSwitches.write(parseKillSwitchState({
      schemaVersion: 1,
      environment: "PAPER",
      engaged: false,
      agentRunId: RUN,
      updatedAt: AT,
      source: "operator",
    }));
    const allowed = await submitAuthorizedExecution(executionInput(ready, provider(["accepted"]).provider, createMemoryExecutionLedger(), {
      killSwitch: null,
      killSwitchAuthority: saved.killSwitches.authority(),
    }));
    expect(allowed.state).toBe("SUBMISSION_ACCEPTED");
    expect(allowed.brokerCalled).toBe(true);
    saved.close();
  });
});

function implementationSource(): string {
  const root = import.meta.dirname;
  return readdirSync(root)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => readFileSync(join(root, name), "utf8"))
    .join("\n");
}
