import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AUTONOMY_NAMES, parseAutonomyState, type AutonomyLevel } from "../../../shared/trading/autonomy.ts";
import { parseDecision, type DecisionDirection } from "../../../shared/trading/decision.ts";
import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { parseKillSwitchState } from "../../../shared/trading/kill-switch.ts";
import { parseOrderIntent, type OrderIntentDirection } from "../../../shared/trading/order-intent.ts";
import type { ExecutionAttemptRecord, ExecutionLedger } from "../execution/ledger.ts";
import { createMetaApiExecutionAdapter } from "../execution/metaapi.ts";
import type { MetaApiTransport, XauUsdExecutionProvider } from "../execution/provider.ts";
import { routineAgentRunId, routineOccurrenceId } from "../occurrence/identity.ts";
import { openTradingStore, type TradingStore } from "../persistence/store.ts";
import { submitEligibleExecution, type EligibleExecutionInput } from "./execute.ts";

const AT = "2026-08-15T14:30:00.000Z";
const ROUTINE_RUN = "44444444-4444-4444-8444-444444444444";
const TURN = "turn-provider-1";
const TOKEN = "metaapi-token-value";
const ACCOUNT = "account-uuid-value";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function agentRunId(): string {
  return routineAgentRunId(ROUTINE_RUN);
}

function decision(
  direction: DecisionDirection,
  stop?: number,
  targets: number[] = direction === "SHORT" ? [4600] : [4648],
  environment: TradingEnvironment = "PAPER",
  id = "dec-1",
) {
  const run = agentRunId();
  return parseDecision({
    schemaVersion: 1,
    id,
    agentRunId: run,
    environment,
    instrument: "XAUUSD",
    createdAt: AT,
    status: "DRAFT",
    thesis: "A proposal for the authorized execution handoff.",
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
  targets: number[] = direction === "SHORT" ? [4600] : [4648],
  environment: TradingEnvironment = "PAPER",
  id = "intent-1",
  decisionId = "dec-1",
) {
  return parseOrderIntent({
    schemaVersion: 1,
    kind: "order-intent",
    id,
    agentRunId: agentRunId(),
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

function autonomy(level: AutonomyLevel, environment: TradingEnvironment = "PAPER") {
  return parseAutonomyState({
    schemaVersion: 1,
    environment,
    level,
    name: AUTONOMY_NAMES[level],
    agentRunId: agentRunId(),
    updatedAt: AT,
  });
}

function kill(engaged: boolean, environment: TradingEnvironment = "PAPER") {
  return parseKillSwitchState({
    schemaVersion: 1,
    environment,
    engaged,
    agentRunId: agentRunId(),
    updatedAt: AT,
    source: "operator",
  });
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

function market(provenance = "LIVE", providerTimestamp = AT) {
  return {
    snapshotId: "snap-1",
    provenance,
    freshness: "fresh",
    providerTimestamp,
    bid: 4630,
    ask: 4633,
    spread: 3,
  };
}

function account(provenance = "LIVE") {
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

function store(environment: TradingEnvironment = "PAPER"): TradingStore {
  const dir = mkdtempSync(join(tmpdir(), "xauusd-execution-"));
  dirs.push(dir);
  return openTradingStore({ path: join(dir, "trading.db"), environment });
}

function bindOccurrence(saved: TradingStore, environment: TradingEnvironment = "PAPER", withTurn = true) {
  saved.occurrences.insertRoutineOccurrence({
    routineId: "routine-1",
    routineRunId: ROUTINE_RUN,
    threadId: "thread-1",
    environment,
    startedAt: AT,
  });
  if (withTurn) {
    saved.occurrences.attachProviderTurn({
      routineId: "routine-1",
      routineRunId: ROUTINE_RUN,
      threadId: "thread-1",
      providerTurnId: TURN,
    });
  }
  return routineOccurrenceId(ROUTINE_RUN);
}

function countingProvider() {
  const commands: unknown[] = [];
  let calls = 0;
  const provider: XauUsdExecutionProvider = {
    providerId: "metaapi-cloud",
    bindingId: "paper-binding-1",
    configured: true,
    submit: async (command) => {
      calls += 1;
      commands.push(command);
      return {
        kind: "accepted",
        brokerRequestId: "ticket-1",
        brokerCode: "TRADE_RETCODE_DONE",
        fillPrice: null,
        fillVolume: null,
        brokerFillId: null,
      };
    },
  };
  return { provider, commands, calls: () => calls };
}

function adapter(transport: MetaApiTransport, environment: "PAPER" | "LIVE" = "PAPER") {
  return createMetaApiExecutionAdapter({
    binding: binding(environment),
    token: TOKEN,
    accountId: ACCOUNT,
    transport,
  });
}

function input(
  overrides: Partial<EligibleExecutionInput> = {},
  saved = store(),
  bind = true,
): EligibleExecutionInput {
  const occurrenceId = bind ? bindOccurrence(saved) : routineOccurrenceId(ROUTINE_RUN);
  const broker = countingProvider();
  return {
    instrument: "XAUUSD",
    decision: decision("LONG", 4624.5),
    orderIntent: intent("LONG", 4632.5, 4624.5),
    market: market(),
    account: account(),
    riskConfig: { version: "risk-v1", maxRiskPercent: 0.02, requireStop: true },
    policyConfig: { version: "policy-v1" },
    approvalConfig: { version: "approval-v1", maxAgeMs: 60_000 },
    gateConfig: { version: "gate-v1", maxMarketAgeMs: 60_000 },
    environment: "PAPER",
    provenance: "LIVE",
    assessedAt: AT,
    agentRunId: agentRunId(),
    evaluationRunId: "eval-1",
    runtimeThreadId: "thread-1",
    runtimeTurnId: TURN,
    requestedQuantity: 0.12,
    autonomy: autonomy(4),
    permissions: ["decision.propose", "intent.propose"],
    policyApproval: "absent",
    approval: null,
    approvalRequestId: "req-1",
    reconciliation: "RECONCILED",
    killSwitch: kill(false),
    provider: broker.provider,
    ledger: saved.ledger,
    accountBinding: binding(),
    occurrence: { repository: saved.occurrences, occurrenceId },
    ...overrides,
  };
}

function quiet(direction: "NO_TRADE" | "WAIT") {
  const saved = store();
  const broker = countingProvider();
  const request = input({
    decision: decision(direction),
    orderIntent: null,
    provider: broker.provider,
  }, saved);
  return { request, broker };
}

describe("phase 10.3 step 5 authorized execution", () => {
  it("reaches the existing execution boundary only from ELIGIBLE_FOR_EXECUTION", async () => {
    const bodies: Array<Record<string, string | number>> = [];
    let reservedFirst = false;
    const saved = store();
    const ledger = wrappingLedger(saved.ledger, () => {
      reservedFirst = true;
    });
    const request = input({
      provider: adapter(async (request) => {
        expect(reservedFirst).toBe(true);
        bodies.push(request.body);
        return { kind: "response", status: 200, body: { stringCode: "TRADE_RETCODE_DONE", orderId: "ticket-1" } };
      }),
      ledger,
    }, saved);
    const result = await submitEligibleExecution(request);
    expect(result.eligibility?.gate?.state).toBe("ELIGIBLE_FOR_EXECUTION");
    expect(result.execution?.state).toBe("SUBMISSION_ACCEPTED");
    expect(result.execution?.reasons).toEqual(["ACKNOWLEDGED"]);
    expect(result.brokerCalled).toBe(true);
    expect(result.retried).toBe(false);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      symbol: "XAUUSD",
      actionType: "ORDER_TYPE_BUY_LIMIT",
      volume: 0.12,
      openPrice: 4632.5,
      stopLoss: 4624.5,
      takeProfit: 4648,
    });
    expect(result.execution?.environment).toBe("PAPER");
    expect(result.execution?.provenance).toBe("LIVE");
    expect(result.execution?.quantity).toBe(0.12);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(ACCOUNT);
    expect(JSON.stringify(result.execution?.events)).not.toContain(TOKEN);
    const row = saved.occurrences.readByOccurrenceId(routineOccurrenceId(ROUTINE_RUN));
    expect(row?.executionRequestId).toBe(result.execution?.id);
    expect(row?.providerTurnId).toBe(TURN);
    expect(row?.agentRunId).toBe(agentRunId());
    expect(saved.readAttempts(result.execution?.executionIdentity ?? "")[0]?.state).toBe("SUBMISSION_UNKNOWN");
  });

  it("does not execute NO_TRADE", async () => {
    const { request, broker } = quiet("NO_TRADE");
    const result = await submitEligibleExecution(request);
    expect(result.eligibility?.stoppedAt).toBe("non_execution");
    expect(result.execution).toBeNull();
    expect(broker.calls()).toBe(0);
  });

  it("does not execute WAIT", async () => {
    const { request, broker } = quiet("WAIT");
    const result = await submitEligibleExecution(request);
    expect(result.eligibility?.proposal?.outcome).toBe("RECOMMENDATION_ONLY");
    expect(result.execution).toBeNull();
    expect(broker.calls()).toBe(0);
  });

  it("does not execute a risk rejection", async () => {
    const broker = countingProvider();
    const result = await submitEligibleExecution(input({ requestedQuantity: 5, provider: broker.provider }));
    expect(result.eligibility?.proposal?.risk.reasons).toEqual(["RISK_BUDGET_EXCEEDED"]);
    expect(result.eligibility?.proposal?.risk.trace.acceptedQuantity).toBeNull();
    expect(result.execution).toBeNull();
    expect(broker.calls()).toBe(0);
  });

  it("does not execute a policy rejection", async () => {
    const broker = countingProvider();
    const result = await submitEligibleExecution(input({ permissions: ["market.read"], provider: broker.provider }));
    expect(result.eligibility?.proposal?.policy?.reasons).toEqual(["PERMISSION_MISSING"]);
    expect(result.execution).toBeNull();
    expect(broker.calls()).toBe(0);
  });

  it("does not execute an approval failure", async () => {
    const broker = countingProvider();
    const result = await submitEligibleExecution(input({
      autonomy: autonomy(3),
      policyApproval: "granted",
      approval: null,
      provider: broker.provider,
    }));
    expect(result.eligibility?.approval?.reasons).toEqual(["APPROVAL_REQUIRED"]);
    expect(result.execution).toBeNull();
    expect(broker.calls()).toBe(0);
  });

  it("does not execute a proposal binding mismatch", async () => {
    const broker = countingProvider();
    const prepared = input({ autonomy: autonomy(3), policyApproval: "granted", provider: broker.provider });
    const preview = await submitEligibleExecution({ ...prepared, approval: null });
    expect(preview.execution).toBeNull();
    const fact = {
      approvalId: "human-1",
      approvalRequestId: "req-1",
      approved: true,
      approvedBy: "operator",
      approvedAt: AT,
      decisionId: "dec-1",
      orderIntentId: "intent-1",
      riskDecisionId: "risk-other",
      policyDecisionId: "policy-other",
      environment: "PAPER" as const,
      instrument: "XAUUSD" as const,
      approvalPolicyVersion: "approval-v1",
      proposalBinding: "bind.other-proposal",
    };
    const saved = store();
    const again = countingProvider();
    const result = await submitEligibleExecution(input({
      autonomy: autonomy(3),
      policyApproval: "granted",
      approval: fact,
      provider: again.provider,
    }, saved));
    expect(result.eligibility?.approval?.reasons).toEqual(["APPROVAL_MISMATCH"]);
    expect(result.execution).toBeNull();
    expect(again.calls()).toBe(0);
    expect(prepared.orderIntent?.entry).toBe(4632.5);
  });

  it("does not execute a fire-time gate rejection", async () => {
    const broker = countingProvider();
    const result = await submitEligibleExecution(input({
      market: market("LIVE", "2026-08-15T14:00:00.000Z"),
      provider: broker.provider,
    }));
    expect(result.eligibility?.gate?.reasons).toEqual(["MARKET_DATA_STALE"]);
    expect(result.execution).toBeNull();
    expect(broker.calls()).toBe(0);
  });

  it("does not execute when reconciliation is DESYNCED", async () => {
    const broker = countingProvider();
    const result = await submitEligibleExecution(input({ reconciliation: "DESYNCED", provider: broker.provider }));
    expect(result.eligibility?.stoppedAt).toBe("reconciliation");
    expect(result.execution).toBeNull();
    expect(broker.calls()).toBe(0);
  });

  it("does not execute when reconciliation is UNKNOWN", async () => {
    const broker = countingProvider();
    const result = await submitEligibleExecution(input({ reconciliation: "UNKNOWN", provider: broker.provider }));
    expect(result.eligibility?.reconciliation).toBe("UNKNOWN");
    expect(result.execution).toBeNull();
    expect(broker.calls()).toBe(0);
  });

  it("reserves the execution identity before MetaApi", async () => {
    const saved = store();
    let reserved = false;
    const bodies: unknown[] = [];
    const result = await submitEligibleExecution(input({
      ledger: wrappingLedger(saved.ledger, () => {
        reserved = true;
      }),
      provider: adapter(async (request) => {
        expect(reserved).toBe(true);
        bodies.push(request.body);
        return { kind: "response", status: 200, body: { stringCode: "TRADE_RETCODE_DONE", orderId: "ticket-1" } };
      }),
    }, saved));
    expect(result.execution?.state).toBe("SUBMISSION_ACCEPTED");
    expect(bodies).toHaveLength(1);
  });

  it("makes zero MetaApi calls when reservation fails", async () => {
    const broker = countingProvider();
    const result = await submitEligibleExecution(input({
      provider: broker.provider,
      ledger: {
        find: () => null,
        reserve: () => false,
        complete: () => false,
      },
    }));
    expect(result.execution?.state).toBe("NOT_SUBMITTED");
    expect(result.execution?.reasons).toEqual(["RECONCILIATION_REQUIRED"]);
    expect(result.brokerCalled).toBe(false);
    expect(broker.calls()).toBe(0);
  });

  it("does not submit the same canonical identity twice", async () => {
    const saved = store();
    const bodies: unknown[] = [];
    const request = input({
      provider: adapter(async (request) => {
        bodies.push(request.body);
        return { kind: "response", status: 200, body: { stringCode: "TRADE_RETCODE_DONE", orderId: "ticket-1" } };
      }),
      ledger: saved.ledger,
    }, saved);
    const first = await submitEligibleExecution(request);
    const second = await submitEligibleExecution(request);
    expect(first.execution?.state).toBe("SUBMISSION_ACCEPTED");
    expect(second.execution?.state).toBe("NOT_SUBMITTED");
    expect(second.execution?.reasons).toEqual(["DUPLICATE_EXECUTION"]);
    expect(second.brokerCalled).toBe(false);
    expect(bodies).toHaveLength(1);
    expect(saved.readAttempts(first.execution?.executionIdentity ?? "")).toHaveLength(2);
  });

  it("reuses the existing reservation", async () => {
    const saved = store();
    const request = input({
      provider: adapter(async () => ({ kind: "response", status: 200, body: { stringCode: "TRADE_RETCODE_DONE", orderId: "ticket-1" } })),
      ledger: saved.ledger,
    }, saved);
    const first = await submitEligibleExecution(request);
    const identity = first.execution?.executionIdentity ?? "";
    const before = saved.readAttempts(identity).map((row) => row.state);
    const second = await submitEligibleExecution(request);
    expect(before).toEqual(["SUBMISSION_UNKNOWN", "SUBMISSION_ACCEPTED"]);
    expect(saved.readAttempts(identity).map((row) => row.state)).toEqual(before);
    expect(second.execution?.executionIdentity).toBe(identity);
    expect(second.brokerCalled).toBe(false);
  });

  it("passes the canonical XAUUSD order through the existing adapter", async () => {
    const saved = store();
    const bodies: Array<Record<string, string | number>> = [];
    const result = await submitEligibleExecution(input({
      provider: adapter(async (request) => {
        bodies.push(request.body);
        return { kind: "response", status: 200, body: { stringCode: "TRADE_RETCODE_DONE", orderId: "ticket-1" } };
      }),
    }, saved));
    expect(result.execution?.brokerCalled).toBe(true);
    expect(bodies[0]?.symbol).toBe("XAUUSD");
    expect(bodies[0]?.actionType).toBe("ORDER_TYPE_BUY_LIMIT");
    expect(result.execution?.direction).toBe("LONG");
  });

  it("preserves the authorized environment", async () => {
    const saved = store();
    const result = await submitEligibleExecution(input({
      provider: adapter(async () => ({ kind: "response", status: 200, body: { stringCode: "TRADE_RETCODE_DONE", orderId: "ticket-1" } })),
    }, saved));
    expect(result.execution?.environment).toBe("PAPER");
    expect(result.execution?.simulatorFallback).toBe(false);
  });

  it("keeps broker credentials out of the result and events", async () => {
    const saved = store();
    const result = await submitEligibleExecution(input({
      provider: adapter(async () => ({ kind: "response", status: 200, body: { stringCode: "TRADE_RETCODE_DONE", orderId: "ticket-1" } })),
    }, saved));
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain(TOKEN);
    expect(encoded).not.toContain(ACCOUNT);
    expect(encoded).not.toContain("password");
  });

  it("persists broker acceptance with the existing accepted state", async () => {
    const saved = store();
    const result = await submitEligibleExecution(input({
      provider: adapter(async () => ({ kind: "response", status: 200, body: { stringCode: "TRADE_RETCODE_DONE", orderId: "ticket-1" } })),
    }, saved));
    expect(result.execution?.state).toBe("SUBMISSION_ACCEPTED");
    expect(saved.readAttempts(result.execution?.executionIdentity ?? "").at(-1)?.state).toBe("SUBMISSION_ACCEPTED");
  });

  it("persists broker rejection with the existing rejected state", async () => {
    const saved = store();
    const result = await submitEligibleExecution(input({
      provider: adapter(async () => ({
        kind: "response",
        status: 200,
        body: { stringCode: "TRADE_RETCODE_INVALID_VOLUME", orderId: "ticket-9" },
      })),
    }, saved));
    expect(result.execution?.state).toBe("SUBMISSION_REJECTED");
    expect(result.execution?.reasons).toEqual(["BROKER_REJECTED"]);
    expect(saved.readAttempts(result.execution?.executionIdentity ?? "").at(-1)?.state).toBe("SUBMISSION_REJECTED");
  });

  it("records a timeout as SUBMISSION_UNKNOWN and does not retry", async () => {
    const saved = store();
    let calls = 0;
    const request = input({
      provider: adapter(async () => {
        calls += 1;
        return { kind: "timeout" };
      }),
    }, saved);
    const first = await submitEligibleExecution(request);
    const second = await submitEligibleExecution(request);
    expect(first.execution?.state).toBe("SUBMISSION_UNKNOWN");
    expect(first.execution?.reasons).toEqual(["BROKER_UNKNOWN"]);
    expect(second.execution?.reasons).toEqual(["RECONCILIATION_REQUIRED"]);
    expect(second.brokerCalled).toBe(false);
    expect(calls).toBe(1);
    expect(saved.occurrences.readByOccurrenceId(routineOccurrenceId(ROUTINE_RUN))?.domainStatus).toBe("submitted_unknown");
  });

  it("records a transport exception as SUBMISSION_UNKNOWN", async () => {
    const saved = store();
    let calls = 0;
    const request = input({
      provider: adapter(async () => {
        calls += 1;
        throw new Error("socket reset");
      }),
    }, saved);
    const result = await submitEligibleExecution(request);
    expect(result.execution?.state).toBe("SUBMISSION_UNKNOWN");
    expect(calls).toBe(1);
    const again = await submitEligibleExecution(request);
    expect(again.execution?.reasons).toEqual(["RECONCILIATION_REQUIRED"]);
    expect(calls).toBe(1);
  });

  it("records a malformed broker response as SUBMISSION_UNKNOWN", async () => {
    const saved = store();
    let calls = 0;
    const request = input({
      provider: adapter(async () => {
        calls += 1;
        return { kind: "response", status: 200, body: { message: "maybe" } };
      }),
    }, saved);
    const result = await submitEligibleExecution(request);
    expect(result.execution?.state).toBe("SUBMISSION_UNKNOWN");
    const again = await submitEligibleExecution(request);
    expect(again.brokerCalled).toBe(false);
    expect(calls).toBe(1);
  });

  it("does not automatically retry an unknown submission", async () => {
    const saved = store();
    let calls = 0;
    const request = input({
      provider: adapter(async () => {
        calls += 1;
        return { kind: "timeout" };
      }),
    }, saved);
    await submitEligibleExecution(request);
    await submitEligibleExecution(request);
    await submitEligibleExecution(request);
    expect(calls).toBe(1);
  });

  it("does not resubmit the same identity after the store is reopened", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xauusd-execution-restart-"));
    dirs.push(dir);
    const path = join(dir, "trading.db");
    const first = openTradingStore({ path, environment: "PAPER" });
    let calls = 0;
    const request = input({
      provider: adapter(async () => {
        calls += 1;
        return { kind: "timeout" };
      }),
      ledger: first.ledger,
    }, first);
    const unknown = await submitEligibleExecution(request);
    expect(unknown.execution?.state).toBe("SUBMISSION_UNKNOWN");
    const identity = unknown.execution?.executionIdentity ?? "";
    first.close();
    const second = openTradingStore({ path, environment: "PAPER" });
    const again = await submitEligibleExecution(input({
      provider: adapter(async () => {
        calls += 1;
        return { kind: "response", status: 200, body: { stringCode: "TRADE_RETCODE_DONE", orderId: "ticket-2" } };
      }),
      ledger: second.ledger,
    }, second, false));
    expect(again.execution?.reasons).toEqual(["RECONCILIATION_REQUIRED"]);
    expect(again.brokerCalled).toBe(false);
    expect(calls).toBe(1);
    expect(second.readAttempts(identity).map((row) => row.state)).toEqual(["SUBMISSION_UNKNOWN", "SUBMISSION_UNKNOWN"]);
    second.close();
  });

  it("rejects a non-XAUUSD instrument before MetaApi", async () => {
    const broker = countingProvider();
    for (const symbol of ["EURUSD", "XAU/USD", "GOLD"]) {
      const result = await submitEligibleExecution(input({ instrument: symbol, provider: broker.provider }));
      expect(result.execution).toBeNull();
    }
    expect(broker.calls()).toBe(0);
  });

  it("does not silently change the accepted quantity", async () => {
    const saved = store();
    const bodies: Array<Record<string, string | number>> = [];
    const request = input({
      provider: adapter(async (request) => {
        bodies.push(request.body);
        return { kind: "response", status: 200, body: { stringCode: "TRADE_RETCODE_DONE", orderId: "ticket-1" } };
      }),
    }, saved);
    const result = await submitEligibleExecution(request);
    expect(bodies[0]?.volume).toBe(0.12);
    expect(result.execution?.quantity).toBe(0.12);
    expect(result.eligibility?.proposal?.risk.trace.acceptedQuantity).toBe(0.12);
    const broker = countingProvider();
    const rejected = await submitEligibleExecution(input({ requestedQuantity: 5, provider: broker.provider }));
    expect(rejected.execution).toBeNull();
    expect(broker.calls()).toBe(0);
  });

  it("does not silently change the entry", async () => {
    const saved = store();
    const bodies: Array<Record<string, string | number>> = [];
    const order = intent("LONG", 4632.5, 4624.5);
    const result = await submitEligibleExecution(input({
      orderIntent: order,
      provider: adapter(async (request) => {
        bodies.push(request.body);
        return { kind: "response", status: 200, body: { stringCode: "TRADE_RETCODE_DONE", orderId: "ticket-1" } };
      }),
    }, saved));
    expect(order.entry).toBe(4632.5);
    expect(bodies[0]?.openPrice).toBe(4632.5);
    expect(result.execution?.entry).toBe(4632.5);
  });

  it("does not silently change the stop", async () => {
    const saved = store();
    const bodies: Array<Record<string, string | number>> = [];
    const order = intent("LONG", 4632.5, 4624.5);
    const result = await submitEligibleExecution(input({
      orderIntent: order,
      provider: adapter(async (request) => {
        bodies.push(request.body);
        return { kind: "response", status: 200, body: { stringCode: "TRADE_RETCODE_DONE", orderId: "ticket-1" } };
      }),
    }, saved));
    expect(order.stop).toBe(4624.5);
    expect(bodies[0]?.stopLoss).toBe(4624.5);
    expect(result.execution?.stop).toBe(4624.5);
  });

  it("does not silently change the environment", async () => {
    const broker = countingProvider();
    const saved = store();
    const result = await submitEligibleExecution(input({
      accountBinding: binding("LIVE"),
      provider: broker.provider,
    }, saved));
    expect(result.execution?.state).toBe("NOT_SUBMITTED");
    expect(result.execution?.reasons).toEqual(["ACCOUNT_BINDING_MISMATCH"]);
    expect(result.execution?.environment).toBe("PAPER");
    expect(broker.calls()).toBe(0);
  });

  it("does not silently change the provenance", async () => {
    const broker = countingProvider();
    const result = await submitEligibleExecution(input({
      provenance: "SIMULATOR",
      market: market("SIMULATOR"),
      account: account("SIMULATOR"),
      provider: broker.provider,
    }));
    expect(result.execution).toBeNull();
    expect(result.eligibility?.state).not.toBe("ELIGIBLE_FOR_EXECUTION");
    expect(broker.calls()).toBe(0);
  });

  it("does not execute a normal chat that lacks an authorized occurrence", async () => {
    const broker = countingProvider();
    const saved = store();
    const bare = input({ provider: broker.provider, occurrence: null }, saved);
    const missing = await submitEligibleExecution(bare);
    expect(missing.eligibility?.gate?.state).toBe("ELIGIBLE_FOR_EXECUTION");
    expect(missing.execution).toBeNull();
    const unbound = store();
    const occurrenceId = bindOccurrence(unbound, "PAPER", false);
    const withoutTurn = await submitEligibleExecution(input({
      provider: broker.provider,
      ledger: unbound.ledger,
      occurrence: { repository: unbound.occurrences, occurrenceId },
    }, unbound, false));
    expect(withoutTurn.eligibility?.gate?.state).toBe("ELIGIBLE_FOR_EXECUTION");
    expect(withoutTurn.execution).toBeNull();
    expect(broker.calls()).toBe(0);
    const source = readFileSync(new URL("./execute.ts", import.meta.url), "utf8");
    for (const token of ["Date.now", "Math.random", "setInterval", "while(true)", "while (true)", "fetch(", "place_order", "submit_order", "execute_order", "close_position", "modify_position", "createMetaApiExecutionAdapter"]) {
      expect(source).not.toContain(token);
    }
    expect(source).toContain("submitAuthorizedExecution");
  });
});

function wrappingLedger(inner: ExecutionLedger, onReserve: () => void): ExecutionLedger {
  return {
    find: (identity) => inner.find(identity),
    reserve: (record: ExecutionAttemptRecord) => {
      const ok = inner.reserve(record);
      if (ok) onReserve();
      return ok;
    },
    complete: (record) => inner.complete(record),
    appendEvents: inner.appendEvents === undefined ? undefined : (events) => inner.appendEvents?.(events),
  };
}
