import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { AUTONOMY_NAMES, parseAutonomyState, type AutonomyLevel } from "../../../shared/trading/autonomy.ts";
import { parseDecision, type DecisionDirection } from "../../../shared/trading/decision.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { parseKillSwitchState } from "../../../shared/trading/kill-switch.ts";
import { parseOrderIntent, type OrderIntentDirection } from "../../../shared/trading/order-intent.ts";
import { submitEligibleExecution, type EligibleExecutionInput } from "../eligibility/execute.ts";
import { createMetaApiExecutionAdapter } from "../execution/metaapi.ts";
import type { MetaApiTransport } from "../execution/provider.ts";
import { routineAgentRunId, routineOccurrenceId } from "./identity.ts";
import { reconcileOccurrenceLifecycle } from "./lifecycle.ts";
import type { TradingOccurrence } from "../persistence/occurrences.ts";
import { openTradingStore, type TradingStore } from "../persistence/store.ts";
import { buildBrokerSnapshot, type BrokerAccountSnapshot } from "../reconciliation/snapshot.ts";

const AT = "2026-08-15T14:30:00.000Z";
const LATER = "2026-08-15T15:00:00.000Z";
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

function decision(direction: DecisionDirection, stop?: number) {
  return parseDecision({
    schemaVersion: 1,
    id: "dec-1",
    agentRunId: agentRunId(),
    environment: "PAPER",
    instrument: "XAUUSD",
    createdAt: AT,
    status: "DRAFT",
    thesis: "A proposal for the occurrence lifecycle.",
    contextId: "ctx-1",
    snapshotId: "snap-1",
    evidenceIds: [],
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingInformation: ["no independent target review"],
    direction,
    ...(stop === undefined ? {} : { stop }),
    targets: direction === "SHORT" ? [4600] : [4648],
    expiry: "2026-08-15T18:00:00.000Z",
    evidenceQuality: "insufficient",
    versionManifestId: "ver-1",
  });
}

function intent(direction: OrderIntentDirection, entry: number, stop?: number) {
  return parseOrderIntent({
    schemaVersion: 1,
    kind: "order-intent",
    id: "intent-1",
    agentRunId: agentRunId(),
    environment: "PAPER",
    instrument: "XAUUSD",
    decisionId: "dec-1",
    createdAt: AT,
    direction,
    executable: false,
    brokerSubmit: false,
    entry,
    ...(stop === undefined ? {} : { stop }),
    targets: direction === "SHORT" ? [4600] : [4648],
  });
}

function autonomy(level: AutonomyLevel) {
  return parseAutonomyState({
    schemaVersion: 1,
    environment: "PAPER",
    level,
    name: AUTONOMY_NAMES[level],
    agentRunId: agentRunId(),
    updatedAt: AT,
  });
}

function kill(engaged: boolean) {
  return parseKillSwitchState({
    schemaVersion: 1,
    environment: "PAPER",
    engaged,
    agentRunId: agentRunId(),
    updatedAt: AT,
    source: "operator",
  });
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

function store(): TradingStore {
  const dir = mkdtempSync(join(tmpdir(), "xauusd-lifecycle-"));
  dirs.push(dir);
  return openTradingStore({ path: join(dir, "trading.db"), environment: "PAPER" });
}

function bind(saved: TradingStore): string {
  saved.occurrences.insertRoutineOccurrence({
    routineId: "routine-1",
    routineRunId: ROUTINE_RUN,
    threadId: "thread-1",
    environment: "PAPER",
    startedAt: AT,
  });
  saved.occurrences.attachProviderTurn({
    routineId: "routine-1",
    routineRunId: ROUTINE_RUN,
    threadId: "thread-1",
    providerTurnId: TURN,
  });
  return routineOccurrenceId(ROUTINE_RUN);
}

function adapter(transport: MetaApiTransport) {
  return createMetaApiExecutionAdapter({
    binding: binding(),
    token: TOKEN,
    accountId: ACCOUNT,
    transport,
  });
}

function request(saved: TradingStore, transport: MetaApiTransport): EligibleExecutionInput {
  const occurrenceId = bind(saved);
  return {
    instrument: "XAUUSD",
    decision: decision("LONG", 4624.5),
    orderIntent: intent("LONG", 4632.5, 4624.5),
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
    provider: adapter(transport),
    ledger: saved.ledger,
    accountBinding: binding(),
    occurrence: { repository: saved.occurrences, occurrenceId },
  };
}

function done(body: Record<string, unknown>): MetaApiTransport {
  return async () => ({ kind: "response", status: 200, body });
}

async function submit(saved: TradingStore, transport: MetaApiTransport) {
  const result = await submitEligibleExecution(request(saved, transport));
  const execution = result.execution;
  if (execution?.executionIdentity == null) throw new Error("execution missing");
  const persisted = saved.readRequest(execution.executionIdentity);
  if (persisted === null) throw new Error("request missing");
  const occurrence = saved.occurrences.readByOccurrenceId(routineOccurrenceId(ROUTINE_RUN));
  if (occurrence === null) throw new Error("occurrence missing");
  return { result, execution, persisted, occurrence };
}

function book(input: {
  clientId: string;
  volume: number;
  symbol?: string;
  orders?: BrokerAccountSnapshot["orders"];
  deals?: BrokerAccountSnapshot["deals"];
  positions?: BrokerAccountSnapshot["positions"];
  observedAt?: string;
}): BrokerAccountSnapshot {
  const orders = input.orders ?? [{
    orderId: "order-1",
    clientId: input.clientId,
    symbol: input.symbol ?? "XAUUSD",
    volume: input.volume,
    direction: "LONG" as const,
    state: "ORDER_STATE_PLACED",
    stopLoss: 4624.5,
    takeProfit: 4648,
  }];
  return buildBrokerSnapshot({
    bindingId: "paper-binding-1",
    environment: "PAPER",
    observedAt: input.observedAt ?? LATER,
    brokerCallSkipped: false,
    channels: { orders: "read", deals: "read", positions: "read", account: "read" },
    source: "injected-reader",
    orders,
    deals: input.deals ?? [],
    positions: input.positions ?? [],
    account: { balance: 10000, equity: 10000, margin: 100, currency: "USD" },
  });
}

function sameIdentity(before: TradingOccurrence, after: TradingOccurrence): void {
  expect(after.occurrenceId).toBe(before.occurrenceId);
  expect(after.routineId).toBe(before.routineId);
  expect(after.routineRunId).toBe(before.routineRunId);
  expect(after.threadId).toBe(before.threadId);
  expect(after.providerTurnId).toBe(before.providerTurnId);
  expect(after.agentRunId).toBe(before.agentRunId);
  expect(after.decisionId).toBe(before.decisionId);
  expect(after.orderIntentId).toBe(before.orderIntentId);
  expect(after.riskDecisionId).toBe(before.riskDecisionId);
  expect(after.policyDecisionId).toBe(before.policyDecisionId);
  expect(after.approvalId).toBe(before.approvalId);
  expect(after.proposalBindingHash).toBe(before.proposalBindingHash);
  expect(after.executionRequestId).toBe(before.executionRequestId);
  expect(after.executionState).toBe(before.executionState);
}

describe("phase 10.3 step 6 occurrence lifecycle", () => {
  it("records acceptance without treating it as a fill", async () => {
    const saved = store();
    const { execution, occurrence, persisted } = await submit(saved, done({
      stringCode: "TRADE_RETCODE_DONE",
      orderId: "ticket-1",
    }));
    expect(execution.state).toBe("SUBMISSION_ACCEPTED");
    expect(execution.fill).toBeNull();
    expect(occurrence.executionState).toBe("SUBMISSION_ACCEPTED");
    expect(occurrence.domainStatus).toBe("turn_not_started");
    expect(occurrence.reconciliationState).toBeNull();
    expect(occurrence.failureCode).toBeNull();
    expect(occurrence.executionRequestId).toBe(execution.id);
    expect(JSON.stringify(occurrence)).not.toContain(TOKEN);
    expect(JSON.stringify(occurrence)).not.toContain(ACCOUNT);
    const lifecycle = reconcileOccurrenceLifecycle({
      store: saved,
      occurrenceId: occurrence.occurrenceId,
      snapshot: book({ clientId: persisted.clientId, volume: persisted.acceptedQuantity }),
      reconciledAt: LATER,
    });
    expect(lifecycle.retried).toBe(false);
    expect(lifecycle.repairAttempted).toBe(false);
    expect(lifecycle.reconciliation.state).toBe("RECONCILED");
    expect(lifecycle.reconciliation.findings.some((item) => item.code === "FILL_MATCHED")).toBe(false);
    expect(lifecycle.occurrence.executionState).toBe("SUBMISSION_ACCEPTED");
    expect(lifecycle.occurrence.reconciliationState).toBe("RECONCILED");
    expect(lifecycle.occurrence.domainStatus).toBe("reconciled");
    expect(lifecycle.occurrence.completedAt).toBe(LATER);
    sameIdentity(occurrence, lifecycle.occurrence);
    expect(saved.readAttempts(persisted.executionIdentity).map((row) => row.state)).toEqual([
      "SUBMISSION_UNKNOWN",
      "SUBMISSION_ACCEPTED",
    ]);
  });

  it("keeps a broker rejection distinct from an unknown submission", async () => {
    const saved = store();
    const { occurrence } = await submit(saved, done({
      stringCode: "TRADE_RETCODE_REJECT",
      orderId: "ticket-1",
    }));
    expect(occurrence.executionState).toBe("SUBMISSION_REJECTED");
    expect(occurrence.failureCode).toBe("BROKER_REJECTED");
    expect(occurrence.domainStatus).not.toBe("submitted_unknown");
    expect(occurrence.reconciliationState).toBeNull();
    const persisted = saved.readRequestById(occurrence.executionRequestId ?? "");
    if (persisted === null) throw new Error("request missing");
    const lifecycle = reconcileOccurrenceLifecycle({
      store: saved,
      occurrenceId: occurrence.occurrenceId,
      snapshot: book({ clientId: persisted.clientId, volume: persisted.acceptedQuantity, orders: [] }),
      reconciledAt: LATER,
    });
    expect(lifecycle.reconciliation.state).toBe("RECONCILED");
    expect(lifecycle.reconciliation.findings.some((item) => item.code === "REJECTION_CONSISTENT")).toBe(true);
    expect(lifecycle.occurrence.executionState).toBe("SUBMISSION_REJECTED");
    expect(lifecycle.occurrence.domainStatus).toBe("reconciled");
    expect(lifecycle.occurrence.failureCode).toBe("BROKER_REJECTED");
  });

  it("keeps an unknown submission unknown until a later broker fact", async () => {
    const saved = store();
    const { occurrence, persisted } = await submit(saved, async () => {
      throw new Error("timeout");
    });
    expect(occurrence.executionState).toBe("SUBMISSION_UNKNOWN");
    expect(occurrence.domainStatus).toBe("submitted_unknown");
    expect(occurrence.failureCode).not.toBe("BROKER_REJECTED");
    const attempts = saved.readAttempts(persisted.executionIdentity).map((row) => row.state);
    const unresolved = reconcileOccurrenceLifecycle({
      store: saved,
      occurrenceId: occurrence.occurrenceId,
      snapshot: book({ clientId: persisted.clientId, volume: persisted.acceptedQuantity, orders: [] }),
      reconciledAt: LATER,
    });
    expect(unresolved.reconciliation.state).toBe("UNKNOWN");
    expect(unresolved.occurrence.executionState).toBe("SUBMISSION_UNKNOWN");
    expect(unresolved.occurrence.reconciliationState).toBe("UNKNOWN");
    expect(unresolved.occurrence.domainStatus).toBe("submitted_unknown");
    expect(unresolved.occurrence.completedAt).toBeNull();
    expect(unresolved.occurrence.failureCode).not.toBe("BROKER_REJECTED");
    const resolved = reconcileOccurrenceLifecycle({
      store: saved,
      occurrenceId: occurrence.occurrenceId,
      snapshot: book({
        clientId: persisted.clientId,
        volume: persisted.acceptedQuantity,
        observedAt: "2026-08-15T15:30:00.000Z",
      }),
      reconciledAt: "2026-08-15T15:30:00.000Z",
    });
    expect(resolved.reconciliation.state).toBe("RECONCILED");
    expect(resolved.reconciliation.resolution).toBe("UNKNOWN_TO_BROKER_ORDER_FOUND");
    expect(resolved.occurrence.executionState).toBe("SUBMISSION_UNKNOWN");
    expect(resolved.occurrence.reconciliationState).toBe("RECONCILED");
    expect(resolved.occurrence.domainStatus).toBe("reconciled");
    expect(saved.readReconciliations(persisted.executionIdentity).map((row) => row.state)).toEqual(["UNKNOWN", "RECONCILED"]);
    expect(saved.readAttempts(persisted.executionIdentity).map((row) => row.state)).toEqual(attempts);
    expect(attempts.every((state) => state === "SUBMISSION_UNKNOWN")).toBe(true);
  });

  it("records an explicit fill report without inventing one from acceptance", async () => {
    const saved = store();
    const { occurrence, persisted } = await submit(saved, async (request) => ({
      kind: "response",
      status: 200,
      body: {
        stringCode: "TRADE_RETCODE_DONE",
        orderId: "ticket-1",
        orderState: "ORDER_STATE_FILLED",
        fillPrice: 4632.5,
        fillVolume: request.body.volume,
        volume: request.body.volume,
        dealId: "deal-1",
      },
    }));
    expect(occurrence.executionState).toBe("FILL_REPORTED");
    expect(occurrence.reconciliationState).toBeNull();
    expect(occurrence.domainStatus).not.toBe("reconciled");
    const lifecycle = reconcileOccurrenceLifecycle({
      store: saved,
      occurrenceId: occurrence.occurrenceId,
      snapshot: book({
        clientId: persisted.clientId,
        volume: persisted.acceptedQuantity,
        deals: [{
          dealId: "deal-1",
          orderId: "order-1",
          clientId: persisted.clientId,
          positionId: null,
          symbol: "XAUUSD",
          volume: persisted.acceptedQuantity,
          price: 4632.5,
        }],
      }),
      reconciledAt: LATER,
    });
    expect(lifecycle.reconciliation.findings.some((item) => item.code === "FILL_MATCHED")).toBe(true);
    expect(lifecycle.occurrence.executionState).toBe("FILL_REPORTED");
    expect(lifecycle.occurrence.reconciliationState).toBe("RECONCILED");
    expect(JSON.stringify(lifecycle.occurrence)).not.toContain("positionId");
  });

  it("preserves a partial fill as degraded and does not submit the remainder", async () => {
    const saved = store();
    const { occurrence, persisted } = await submit(saved, done({
      stringCode: "TRADE_RETCODE_DONE",
      orderId: "ticket-1",
    }));
    const before = saved.readAttempts(persisted.executionIdentity).length;
    const lifecycle = reconcileOccurrenceLifecycle({
      store: saved,
      occurrenceId: occurrence.occurrenceId,
      snapshot: book({
        clientId: persisted.clientId,
        volume: persisted.acceptedQuantity,
        deals: [{
          dealId: "deal-part",
          orderId: "order-1",
          clientId: persisted.clientId,
          positionId: null,
          symbol: "XAUUSD",
          volume: persisted.acceptedQuantity / 2,
          price: 4632.5,
        }],
      }),
      reconciledAt: LATER,
    });
    expect(lifecycle.reconciliation.state).toBe("DEGRADED");
    expect(lifecycle.reconciliation.findings.some((item) => item.code === "PARTIAL_FILL")).toBe(true);
    expect(lifecycle.occurrence.executionState).toBe("SUBMISSION_ACCEPTED");
    expect(lifecycle.occurrence.reconciliationState).toBe("DEGRADED");
    expect(lifecycle.occurrence.domainStatus).toBe("degraded");
    expect(saved.readAttempts(persisted.executionIdentity)).toHaveLength(before);
  });

  it("preserves ambiguous correlation and a foreign symbol as desynced", async () => {
    const saved = store();
    const { occurrence, persisted } = await submit(saved, done({
      stringCode: "TRADE_RETCODE_DONE",
      orderId: "ticket-1",
    }));
    const ambiguous = reconcileOccurrenceLifecycle({
      store: saved,
      occurrenceId: occurrence.occurrenceId,
      snapshot: book({
        clientId: persisted.clientId,
        volume: persisted.acceptedQuantity,
        orders: [
          {
            orderId: "order-a",
            clientId: persisted.clientId,
            symbol: "XAUUSD",
            volume: persisted.acceptedQuantity,
            direction: "LONG",
            state: "ORDER_STATE_PLACED",
            stopLoss: 4624.5,
            takeProfit: 4648,
          },
          {
            orderId: "order-b",
            clientId: persisted.clientId,
            symbol: "XAUUSD",
            volume: persisted.acceptedQuantity,
            direction: "LONG",
            state: "ORDER_STATE_PLACED",
            stopLoss: 4624.5,
            takeProfit: 4648,
          },
        ],
      }),
      reconciledAt: LATER,
    });
    expect(ambiguous.reconciliation.state).toBe("DESYNCED");
    expect(ambiguous.reconciliation.findings.some((item) => item.code === "AMBIGUOUS_CORRELATION")).toBe(true);
    expect(ambiguous.occurrence.domainStatus).toBe("desynced");
    expect(ambiguous.occurrence.executionState).toBe("SUBMISSION_ACCEPTED");

    const foreignSaved = store();
    const foreign = await submit(foreignSaved, done({
      stringCode: "TRADE_RETCODE_DONE",
      orderId: "ticket-1",
    }));
    const mismatched = reconcileOccurrenceLifecycle({
      store: foreignSaved,
      occurrenceId: foreign.occurrence.occurrenceId,
      snapshot: book({
        clientId: foreign.persisted.clientId,
        volume: foreign.persisted.acceptedQuantity,
        symbol: "EURUSD",
      }),
      reconciledAt: LATER,
    });
    expect(mismatched.reconciliation.state).toBe("DESYNCED");
    expect(mismatched.reconciliation.findings.some((item) => item.code === "SYMBOL_MISMATCH")).toBe(true);
    expect(mismatched.occurrence.reconciliationState).toBe("DESYNCED");
    expect(mismatched.occurrence.executionState).toBe("SUBMISSION_ACCEPTED");
    expect(JSON.stringify(mismatched.occurrence)).not.toContain("EURUSD");

    const beside = store();
    const neighbor = await submit(beside, done({
      stringCode: "TRADE_RETCODE_DONE",
      orderId: "ticket-1",
    }));
    const observed = reconcileOccurrenceLifecycle({
      store: beside,
      occurrenceId: neighbor.occurrence.occurrenceId,
      snapshot: book({
        clientId: neighbor.persisted.clientId,
        volume: neighbor.persisted.acceptedQuantity,
        orders: [
          {
            orderId: "order-1",
            clientId: neighbor.persisted.clientId,
            symbol: "XAUUSD",
            volume: neighbor.persisted.acceptedQuantity,
            direction: "LONG",
            state: "ORDER_STATE_PLACED",
            stopLoss: 4624.5,
            takeProfit: 4648,
          },
          {
            orderId: "order-fx",
            clientId: "ffffffffffffffffffffffffff",
            symbol: "EURUSD",
            volume: 1,
            direction: "LONG",
            state: "ORDER_STATE_PLACED",
            stopLoss: null,
            takeProfit: null,
          },
        ],
      }),
      reconciledAt: LATER,
    });
    expect(observed.reconciliation.state).toBe("RECONCILED");
    expect(observed.reconciliation.findings.some((item) => item.code === "FOREIGN_SYMBOL_OBSERVED")).toBe(true);
    expect(observed.occurrence.executionState).toBe("SUBMISSION_ACCEPTED");
    expect(beside.countFindings(observed.reconciliation.reconciliationRunId)).toBeGreaterThan(0);
  });

  it("resumes reconciliation after a restart without another broker call", async () => {
    const saved = store();
    const path = saved.path;
    const { occurrence, persisted } = await submit(saved, done({
      stringCode: "TRADE_RETCODE_DONE",
      orderId: "ticket-1",
    }));
    const snapshot = book({ clientId: persisted.clientId, volume: persisted.acceptedQuantity });
    saved.close();
    const reopened = openTradingStore({ path, environment: "PAPER" });
    const restored = reopened.occurrences.readByOccurrenceId(occurrence.occurrenceId);
    expect(restored?.executionState).toBe("SUBMISSION_ACCEPTED");
    expect(restored?.reconciliationRunId).toBeNull();
    const lifecycle = reconcileOccurrenceLifecycle({
      store: reopened,
      occurrenceId: occurrence.occurrenceId,
      snapshot,
      reconciledAt: LATER,
    });
    const again = reconcileOccurrenceLifecycle({
      store: reopened,
      occurrenceId: occurrence.occurrenceId,
      snapshot,
      reconciledAt: LATER,
    });
    expect(again.occurrence.reconciliationRunId).toBe(lifecycle.occurrence.reconciliationRunId);
    expect(again.reconciliation.reconciliationRunId).toBe(lifecycle.reconciliation.reconciliationRunId);
    expect(reopened.readAttempts(persisted.executionIdentity)).toHaveLength(2);
    expect(reopened.readReconciliations(persisted.executionIdentity)).toHaveLength(1);
    sameIdentity(occurrence, again.occurrence);
    reopened.close();
  });

  it("does not move a concluded reconciliation onto a later run", async () => {
    const saved = store();
    const { occurrence, persisted } = await submit(saved, done({
      stringCode: "TRADE_RETCODE_DONE",
      orderId: "ticket-1",
    }));
    const first = reconcileOccurrenceLifecycle({
      store: saved,
      occurrenceId: occurrence.occurrenceId,
      snapshot: book({ clientId: persisted.clientId, volume: persisted.acceptedQuantity }),
      reconciledAt: LATER,
    });
    expect(() => reconcileOccurrenceLifecycle({
      store: saved,
      occurrenceId: occurrence.occurrenceId,
      snapshot: book({
        clientId: persisted.clientId,
        volume: persisted.acceptedQuantity,
        observedAt: "2026-08-15T16:00:00.000Z",
      }),
      reconciledAt: "2026-08-15T16:00:00.000Z",
    })).toThrow(TradingDomainError);
    const kept = saved.occurrences.readByOccurrenceId(occurrence.occurrenceId);
    expect(kept?.reconciliationRunId).toBe(first.occurrence.reconciliationRunId);
    expect(kept?.executionState).toBe("SUBMISSION_ACCEPTED");
    expect(kept?.reconciliationState).toBe("RECONCILED");
    expect(saved.readReconciliations(persisted.executionIdentity)).toHaveLength(1);
  });

  it("upgrades an older occurrence row without rewriting its identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "xauusd-lifecycle-migrate-"));
    dirs.push(dir);
    const path = join(dir, "trading.db");
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE schema_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        environment TEXT NOT NULL,
        partition_key TEXT NOT NULL
      );
      INSERT INTO schema_meta (id, version, environment, partition_key)
      VALUES (1, 4, 'PAPER', 'xauusd/PAPER');
      CREATE TABLE trading_occurrences (
        occurrence_id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL,
        routine_run_id TEXT UNIQUE,
        thread_id TEXT NOT NULL,
        provider_turn_id TEXT,
        agent_run_id TEXT NOT NULL,
        instrument TEXT NOT NULL,
        environment TEXT NOT NULL,
        provenance TEXT,
        snapshot_id TEXT,
        decision_id TEXT,
        order_intent_id TEXT,
        risk_decision_id TEXT,
        policy_decision_id TEXT,
        approval_id TEXT,
        execution_request_id TEXT,
        reconciliation_run_id TEXT,
        proposal_binding_hash TEXT,
        domain_status TEXT NOT NULL,
        failure_code TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      INSERT INTO trading_occurrences (
        occurrence_id, routine_id, routine_run_id, thread_id, provider_turn_id, agent_run_id,
        instrument, environment, domain_status, started_at
      ) VALUES (
        'occ.keep', 'routine-1', '${ROUTINE_RUN}', 'thread-1', 'turn-1', '${agentRunId()}',
        'XAUUSD', 'PAPER', 'turn_not_started', '${AT}'
      );
    `);
    db.close();
    const upgraded = openTradingStore({ path, environment: "PAPER" });
    expect(upgraded.schemaVersion).toBe(6);
    const row = upgraded.occurrences.readByOccurrenceId("occ.keep");
    expect(row?.routineRunId).toBe(ROUTINE_RUN);
    expect(row?.executionState).toBeNull();
    expect(row?.reconciliationState).toBeNull();
    expect(row?.agentRunId).toBe(agentRunId());
    upgraded.close();
  });

  it("does not submit, retry, or read the clock while recording reconciliation", () => {
    const source = readFileSync(new URL("./lifecycle.ts", import.meta.url), "utf8");
    expect(source).not.toContain("submitAuthorizedExecution");
    expect(source).not.toContain("provider.submit");
    expect(source).not.toMatch(/Date\.now|Math\.random|randomUUID/);
    expect(source).toContain("reconcileExecution");
  });
});
