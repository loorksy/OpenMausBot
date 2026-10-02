import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { AUTONOMY_NAMES, parseAutonomyState, type AutonomyLevel } from "../../../shared/trading/autonomy.ts";
import { parseDecision, type DecisionDirection } from "../../../shared/trading/decision.ts";
import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { parseKillSwitchState, type KillSwitchState } from "../../../shared/trading/kill-switch.ts";
import { parseOrderIntent, type OrderIntentDirection } from "../../../shared/trading/order-intent.ts";
import { foundationControl } from "../control/boundaries.ts";
import { executionAttemptKey } from "../execution/identity.ts";
import type { ExecutionAttemptRecord } from "../execution/ledger.ts";
import type { XauUsdExecutionProvider } from "../execution/provider.ts";
import { submitAuthorizedExecution, type ExecutionSubmitInput } from "../execution/submit.ts";
import { evaluateFireTimeGate, type FireTimeGateInput } from "../gate/evaluate.ts";
import type { PersistedExecutionRequest } from "../persistence/record.ts";
import { TRADING_STORE_SCHEMA_SQL } from "../persistence/schema.ts";
import { applyTradingMigrations, openTradingStore, type TradingStore } from "../persistence/store.ts";
import { evaluateXauUsdProposal, type ProposalInput } from "../proposal/evaluate.ts";
import { assessApproval } from "../approval/assess.ts";
import { captureBrokerSnapshot, createMetaApiReconciliationAdapter, type MetaApiReconciliationReader } from "./capture.ts";
import { reconcileExecution, type ReconciliationFindingCode } from "./engine.ts";
import { buildBrokerSnapshot, type BrokerAccountSnapshot, type BrokerChannels } from "./snapshot.ts";

const AT = "2026-08-15T14:30:00.000Z";
const LATER = "2026-08-15T15:00:00.000Z";
const RUN = "run-1";
const TOKEN = "metaapi-token-value";
const ACCOUNT = "account-uuid-value";
const CLIENT = "0123456789abcdef0123456789";
const OTHER = "abcdef0123456789abcdef0123";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempStore(environment: "PAPER" | "LIVE" | "SIMULATOR" = "PAPER"): TradingStore {
  const dir = mkdtempSync(join(tmpdir(), "xauusd-ledger-"));
  dirs.push(dir);
  return openTradingStore({ path: join(dir, "trading.db"), environment });
}

function decision(direction: DecisionDirection, stop?: number, targets: number[] = [4648], environment = "PAPER") {
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

function intent(direction: OrderIntentDirection, entry: number, stop?: number, targets: number[] = [4648], environment = "PAPER") {
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

function accountBinding(environment: "PAPER" | "LIVE" = "PAPER") {
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
  const environment: TradingEnvironment = input.environment === "LIVE" || input.environment === "PAPER" || input.environment === "SIMULATOR"
    ? input.environment
    : "PAPER";
  const dir = mkdtempSync(join(tmpdir(), "xauusd-recon-switch-"));
  dirs.push(dir);
  const store = openTradingStore({ path: join(dir, "trading.db"), environment });
  try {
    store.killSwitches.write(parseKillSwitchState(input.killSwitch));
  } catch {
    // Missing and malformed switches stay unread.
  }
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
    killSwitches: store.killSwitches,
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
  return { input, risk: evaluated.risk, policy: evaluated.policy, approval, gate: evaluateFireTimeGate(gateInput), store };
}

function provider(kind: "accepted" | "unknown" | "filled" = "accepted", onSubmit?: () => void) {
  let calls = 0;
  const broker: XauUsdExecutionProvider = {
    providerId: "metaapi-cloud",
    bindingId: "paper-binding-1",
    configured: true,
    submit: async (command) => {
      calls += 1;
      onSubmit?.();
      if (kind === "unknown") {
        return { kind: "unknown", brokerRequestId: null, brokerCode: null, fillPrice: null, fillVolume: null, brokerFillId: null };
      }
      if (kind === "filled") {
        return {
          kind: "filled",
          brokerRequestId: "ticket-1",
          brokerCode: "TRADE_RETCODE_DONE",
          fillPrice: 4632.5,
          fillVolume: command.volume,
          brokerFillId: "deal-1",
        };
      }
      return { kind: "accepted", brokerRequestId: "ticket-1", brokerCode: "TRADE_RETCODE_DONE", fillPrice: null, fillVolume: null, brokerFillId: null };
    },
  };
  return { broker, calls: () => calls };
}

function executionInput(ready: ReturnType<typeof prepared>, broker: XauUsdExecutionProvider, ledger: TradingStore["ledger"]): ExecutionSubmitInput {
  return {
    instrument: "XAUUSD",
    decision: ready.input.decision,
    orderIntent: ready.input.orderIntent,
    risk: ready.risk,
    policy: ready.policy,
    approval: ready.approval,
    gate: ready.gate,
    binding: accountBinding(),
    quote: { bid: 4630, ask: 4633, snapshotId: "snap-1" },
    killSwitch: ready.input.killSwitch,
    killSwitches: ready.store.killSwitches,
    environment: ready.input.environment,
    provenance: ready.input.provenance,
    requestedQuantity: ready.input.requestedQuantity ?? null,
    provider: broker,
    ledger,
    submittedAt: AT,
    agentRunId: RUN,
    evaluationRunId: "eval-1",
  };
}

function request(overrides: Partial<PersistedExecutionRequest> = {}): PersistedExecutionRequest {
  return {
    schemaVersion: "xauusd-execution-1",
    executionRequestId: "exr.test-1",
    executionIdentity: "exn.test-1",
    agentRunId: RUN,
    decisionId: "dec-1",
    orderIntentId: "intent-1",
    riskDecisionId: "risk-1",
    policyDecisionId: "policy-1",
    approvalDecisionId: "approval-1",
    gateId: "gate-1",
    bindingId: "paper-binding-1",
    environment: "PAPER",
    provenance: "LIVE",
    instrument: "XAUUSD",
    direction: "LONG",
    entry: 4632.5,
    stop: 4624.5,
    takeProfit: 4648,
    requestedQuantity: 0.2,
    acceptedQuantity: 0.2,
    targets: [4648],
    proposalBinding: "bind.test-1",
    gateState: "ELIGIBLE_FOR_EXECUTION",
    clientId: CLIENT,
    submittedAt: AT,
    ...overrides,
  };
}

function attempt(base: PersistedExecutionRequest, state: ExecutionAttemptRecord["state"], sequence = 1): ExecutionAttemptRecord {
  return {
    schemaVersion: "xauusd-execution-1",
    executionAttemptId: executionAttemptKey({
      executionIdentity: base.executionIdentity,
      executionRequestId: base.executionRequestId,
      sequence,
      state,
    }),
    executionRequestId: base.executionRequestId,
    executionIdentity: base.executionIdentity,
    sequence,
    agentRunId: base.agentRunId,
    decisionId: base.decisionId,
    orderIntentId: base.orderIntentId,
    riskDecisionId: base.riskDecisionId,
    policyDecisionId: base.policyDecisionId,
    approvalDecisionId: base.approvalDecisionId,
    gateId: base.gateId,
    gateState: base.gateState,
    bindingId: base.bindingId,
    proposalBinding: base.proposalBinding,
    environment: base.environment,
    provenance: base.provenance,
    direction: base.direction,
    entry: base.entry,
    stop: base.stop,
    takeProfit: base.takeProfit,
    targets: base.targets,
    requestedQuantity: base.requestedQuantity,
    quantity: base.acceptedQuantity,
    clientId: base.clientId,
    state,
    brokerRequestId: state === "SUBMISSION_UNKNOWN" ? null : "ticket-1",
    brokerCode: null,
    fill: null,
    submittedAt: base.submittedAt,
    responseAt: sequence === 1 ? null : base.submittedAt,
  };
}

function channels(overrides: Partial<BrokerChannels> = {}): BrokerChannels {
  return { orders: "read", deals: "read", positions: "read", account: "read", ...overrides };
}

function snapshot(input: {
  clientId?: string | null;
  symbol?: string;
  volume?: number;
  orders?: BrokerAccountSnapshot["orders"];
  deals?: BrokerAccountSnapshot["deals"];
  positions?: BrokerAccountSnapshot["positions"];
  bindingId?: string;
  environment?: BrokerAccountSnapshot["environment"];
  channelOverrides?: Partial<BrokerChannels>;
  unavailable?: boolean;
  observedAt?: string;
  direction?: "LONG" | "SHORT" | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
} = {}): BrokerAccountSnapshot {
  const orders = input.orders ?? (input.unavailable === true ? [] : [{
    orderId: "order-1",
    clientId: input.clientId === undefined ? CLIENT : input.clientId,
    symbol: input.symbol ?? "XAUUSD",
    volume: input.volume ?? 0.2,
    direction: input.direction === undefined ? "LONG" : input.direction,
    state: "ORDER_STATE_PLACED",
    stopLoss: input.stopLoss === undefined ? 4624.5 : input.stopLoss,
    takeProfit: input.takeProfit === undefined ? 4648 : input.takeProfit,
  }]);
  const skipped = input.unavailable === true;
  return buildBrokerSnapshot({
    bindingId: input.bindingId ?? "paper-binding-1",
    environment: input.environment ?? "PAPER",
    observedAt: input.observedAt ?? AT,
    brokerCallSkipped: skipped,
    channels: skipped ? channels({ orders: "unavailable", deals: "unavailable", positions: "unavailable", account: "unavailable" }) : channels(input.channelOverrides),
    source: skipped ? "not-called" : "injected-reader",
    orders: skipped ? [] : orders,
    deals: input.deals ?? [],
    positions: input.positions ?? [],
    account: { balance: 10000, equity: 10000, margin: 100, currency: "USD" },
  });
}

function reconcile(base: PersistedExecutionRequest, book: BrokerAccountSnapshot, state: ExecutionAttemptRecord["state"] = "SUBMISSION_ACCEPTED", reconciledAt = AT) {
  return reconcileExecution({
    request: base,
    attempts: [attempt(base, state)],
    snapshot: book,
    reconciledAt,
    agentRunId: RUN,
  });
}

function codes(result: { findings: readonly { code: ReconciliationFindingCode }[] }): ReconciliationFindingCode[] {
  return result.findings.map((item) => item.code);
}

describe("persistent trading ledger", () => {
  it("keeps execution identity, attempts, and UNKNOWN across a restart", async () => {
    const ready = prepared();
    expect(ready.gate.state).toBe("ELIGIBLE_FOR_EXECUTION");
    const first = tempStore();
    const path = first.path;
    let reserved = false;
    const broker = provider("unknown", () => {
      const all = readIdentities(first);
      expect(all).toHaveLength(1);
      expect(all[0]?.state).toBe("SUBMISSION_UNKNOWN");
      expect(all[0]?.responseAt).toBeNull();
      reserved = true;
    });
    const submitted = await submitAuthorizedExecution(executionInput(ready, broker.broker, first.ledger));
    expect(reserved).toBe(true);
    expect(submitted.state).toBe("SUBMISSION_UNKNOWN");
    expect(submitted.reasons).toEqual(["BROKER_UNKNOWN"]);
    expect(broker.calls()).toBe(1);
    const identity = submitted.executionIdentity;
    expect(identity).toBeTruthy();
    const storedRequest = first.readRequest(identity ?? "");
    expect(storedRequest?.clientId).toHaveLength(26);
    expect(storedRequest?.instrument).toBe("XAUUSD");
    expect(storedRequest?.acceptedQuantity).toBe(ready.risk.trace.acceptedQuantity);
    expect(JSON.stringify(storedRequest)).not.toContain(TOKEN);
    first.close();

    const reopened = openTradingStore({ path, environment: "PAPER" });
    const again = reopened.ledger.find(identity ?? "");
    expect(again?.state).toBe("SUBMISSION_UNKNOWN");
    expect(again?.executionIdentity).toBe(identity);
    expect(reopened.readRequest(identity ?? "")).toEqual(storedRequest);
    const second = provider("accepted");
    const blocked = await submitAuthorizedExecution(executionInput(ready, second.broker, reopened.ledger));
    expect(second.calls()).toBe(0);
    expect(blocked.state).toBe("NOT_SUBMITTED");
    expect(blocked.reasons).toEqual(["RECONCILIATION_REQUIRED"]);
    expect(blocked.retried).toBe(false);
    reopened.close();
  });

  it("appends an outcome without rewriting the reserved UNKNOWN attempt", async () => {
    const store = tempStore();
    const ready = prepared();
    const broker = provider("accepted");
    const submitted = await submitAuthorizedExecution(executionInput(ready, broker.broker, store.ledger));
    expect(submitted.state).toBe("SUBMISSION_ACCEPTED");
    const identity = submitted.executionIdentity ?? "";
    expect(store.readAttempts(identity).map((row) => row.state)).toEqual(["SUBMISSION_UNKNOWN", "SUBMISSION_ACCEPTED"]);
    const duplicate = provider("accepted");
    const blocked = await submitAuthorizedExecution(executionInput(ready, duplicate.broker, store.ledger));
    expect(duplicate.calls()).toBe(0);
    expect(blocked.reasons).toEqual(["DUPLICATE_EXECUTION"]);
    store.close();
  });

  it("blocks a second submit after an accepted or filled attempt", async () => {
    for (const kind of ["accepted", "filled"] as const) {
      const store = tempStore();
      const ready = prepared();
      const broker = provider(kind);
      const submitted = await submitAuthorizedExecution(executionInput(ready, broker.broker, store.ledger));
      expect(submitted.state).toBe(kind === "filled" ? "FILL_REPORTED" : "SUBMISSION_ACCEPTED");
      const again = provider("accepted");
      const blocked = await submitAuthorizedExecution(executionInput(ready, again.broker, store.ledger));
      expect(again.calls()).toBe(0);
      expect(blocked.reasons).toEqual(["DUPLICATE_EXECUTION"]);
      store.close();
    }
  });

  it("does not call MetaApi when the reservation cannot be written", async () => {
    const ready = prepared();
    const broker = provider("accepted");
    const result = await submitAuthorizedExecution(executionInput(ready, broker.broker, {
      find: () => null,
      reserve: () => {
        throw new Error(TOKEN);
      },
      complete: () => true,
    }));
    expect(broker.calls()).toBe(0);
    expect(result.state).toBe("NOT_SUBMITTED");
    expect(result.reasons).toEqual(["SYSTEM_ERROR"]);
    expect(result.brokerCalled).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("keeps UNKNOWN when the outcome cannot be written after MetaApi returns", async () => {
    const ready = prepared();
    const rows: ExecutionAttemptRecord[] = [];
    const broker = provider("accepted");
    const ledger = {
      find: (identity: string) => rows.filter((row) => row.executionIdentity === identity).at(-1) ?? null,
      reserve: (record: ExecutionAttemptRecord) => {
        rows.push(record);
        return true;
      },
      complete: () => {
        throw new Error(TOKEN);
      },
    };
    const result = await submitAuthorizedExecution(executionInput(ready, broker.broker, ledger));
    expect(broker.calls()).toBe(1);
    expect(result.state).toBe("SUBMISSION_UNKNOWN");
    expect(result.reasons).toEqual(["SYSTEM_ERROR"]);
    expect(result.brokerCalled).toBe(true);
    expect(rows.map((row) => row.state)).toEqual(["SUBMISSION_UNKNOWN"]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    const again = await submitAuthorizedExecution(executionInput(ready, broker.broker, ledger));
    expect(broker.calls()).toBe(1);
    expect(again.reasons).toEqual(["RECONCILIATION_REQUIRED"]);
  });

  it("migrates version 0 without deleting existing rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "xauusd-migrate-"));
    dirs.push(dir);
    const path = join(dir, "trading.db");
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE schema_meta (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO schema_meta (id, version) VALUES (1, 0);
      CREATE TABLE legacy_marker (id TEXT PRIMARY KEY);
      INSERT INTO legacy_marker (id) VALUES ('keep-me');
      CREATE TABLE execution_requests (
        execution_request_id TEXT PRIMARY KEY,
        execution_identity TEXT NOT NULL UNIQUE,
        agent_run_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);
    const payload = JSON.stringify(request({ executionIdentity: "exn.keep", executionRequestId: "exr.keep" }));
    db.prepare(`
      INSERT INTO execution_requests (
        execution_request_id, execution_identity, agent_run_id, environment, binding_id, client_id, submitted_at, payload_json
      ) VALUES ('exr.keep', 'exn.keep', 'run-1', 'PAPER', 'paper-binding-1', ?, ?, ?)
    `).run(CLIENT, AT, payload);
    db.close();
    const upgraded = applyTradingMigrations({ path, environment: "PAPER" });
    expect(upgraded.schemaVersion).toBe(7);
    expect(upgraded.readRequest("exn.keep")?.executionRequestId).toBe("exr.keep");
    upgraded.close();
    const check = new DatabaseSync(path);
    expect((check.prepare("SELECT id FROM legacy_marker").get() as { id: string }).id).toBe("keep-me");
    expect(check.prepare("SELECT version, environment FROM schema_meta WHERE id = 1").get()).toMatchObject({
      version: 7,
      environment: "PAPER",
    });
    check.exec("UPDATE schema_meta SET version = 0 WHERE id = 1");
    check.close();
    const rerun = openTradingStore({ path, environment: "PAPER" });
    expect(rerun.readRequest("exn.keep")?.acceptedQuantity).toBe(0.2);
    expect(() => openTradingStore({ path, environment: "LIVE" })).toThrow(TradingDomainError);
    rerun.close();
    expect(TRADING_STORE_SCHEMA_SQL).not.toContain("DROP");
    expect(TRADING_STORE_SCHEMA_SQL).not.toContain("DELETE");
  });
});

describe("reconciliation", () => {
  it("reconciles a matching accepted order and resolves UNKNOWN only as a new fact", () => {
    const base = request();
    const book = snapshot();
    const accepted = reconcile(base, book, "SUBMISSION_ACCEPTED");
    expect(accepted.state).toBe("RECONCILED");
    expect(codes(accepted)).toContain("ORDER_MATCHED");
    expect(accepted.resolution).toBeNull();
    expect(accepted.internalState).toBe("SUBMISSION_ACCEPTED");
    const unknown = reconcile(base, book, "SUBMISSION_UNKNOWN");
    expect(unknown.state).toBe("RECONCILED");
    expect(unknown.resolution).toBe("UNKNOWN_TO_BROKER_ORDER_FOUND");
    expect(codes(unknown)).toContain("UNKNOWN_RESOLVED_ORDER_FOUND");
    expect(unknown.internalState).toBe("SUBMISSION_UNKNOWN");
    expect(unknown.events.map((event) => event.type)).toEqual([
      "reconciliation.started",
      "reconciliation.completed",
      "execution.resolved",
    ]);
    expect(unknown.repairAttempted).toBe(false);
    expect(unknown.retried).toBe(false);
  });

  it("stays UNKNOWN when the snapshot is incomplete or the broker is unavailable", () => {
    const base = request();
    const incomplete = reconcile(base, snapshot({
      orders: [],
      channelOverrides: { orders: "unavailable" },
    }), "SUBMISSION_UNKNOWN");
    expect(incomplete.state).toBe("UNKNOWN");
    expect(codes(incomplete)).toContain("SNAPSHOT_INCOMPLETE");
    expect(incomplete.resolution).toBeNull();
    const missing = reconcile(base, snapshot({ orders: [] }), "SUBMISSION_UNKNOWN");
    expect(missing.state).toBe("UNKNOWN");
    expect(codes(missing)).toContain("BROKER_ORDER_NOT_FOUND");
    const down = reconcile(base, snapshot({ unavailable: true }), "SUBMISSION_UNKNOWN");
    expect(down.state).toBe("UNKNOWN");
    expect(codes(down)).toContain("BROKER_UNAVAILABLE");
    const acceptedDown = reconcile(base, snapshot({ unavailable: true }), "SUBMISSION_ACCEPTED");
    expect(acceptedDown.state).toBe("DEGRADED");
    expect(acceptedDown.events.map((event) => event.type)).toContain("reconciliation.degraded");
  });

  it("reports quantity, symbol, direction, stop, and account contradictions without changing the request", () => {
    const base = Object.freeze(request());
    expect(reconcile(base, snapshot({ volume: 0.1 })).state).toBe("DESYNCED");
    expect(codes(reconcile(base, snapshot({ volume: 0.1 })))).toContain("QUANTITY_MISMATCH");
    expect(base.acceptedQuantity).toBe(0.2);
    expect(reconcile(base, snapshot({ symbol: "EURUSD" })).state).toBe("DESYNCED");
    expect(codes(reconcile(base, snapshot({ symbol: "EURUSD" })))).toContain("SYMBOL_MISMATCH");
    expect(base.instrument).toBe("XAUUSD");
    expect(codes(reconcile(base, snapshot({ direction: "SHORT" })))).toContain("DIRECTION_MISMATCH");
    expect(base.direction).toBe("LONG");
    expect(codes(reconcile(base, snapshot({ stopLoss: 4600 })))).toContain("STOP_MISMATCH");
    expect(base.stop).toBe(4624.5);
    expect(codes(reconcile(base, snapshot({ takeProfit: 4700 })))).toContain("TARGET_MISMATCH");
    expect(base.takeProfit).toBe(4648);
    const wrongAccount = reconcile(base, snapshot({ bindingId: "live-binding-1" }));
    expect(wrongAccount.state).toBe("DESYNCED");
    expect(codes(wrongAccount)).toEqual(["ACCOUNT_MISMATCH"]);
    const wrongEnvironment = reconcile(base, snapshot({ environment: "LIVE" }));
    expect(wrongEnvironment.state).toBe("DESYNCED");
    expect(codes(wrongEnvironment)).toEqual(["ENVIRONMENT_MISMATCH"]);
  });

  it("records a partial fill, and keeps orders, deals, and positions distinct", () => {
    const base = request();
    const partial = reconcile(base, snapshot({
      deals: [{ dealId: "deal-1", orderId: "order-1", clientId: CLIENT, positionId: "pos-1", symbol: "XAUUSD", volume: 0.1, price: 4632.5 }],
    }), "SUBMISSION_UNKNOWN");
    expect(partial.state).toBe("DEGRADED");
    expect(codes(partial)).toContain("PARTIAL_FILL");
    expect(partial.findings.find((item) => item.code === "PARTIAL_FILL")?.brokerVolume).toBe(0.1);
    expect(partial.resolution).toBeNull();
    const filled = reconcile(base, snapshot({
      deals: [{ dealId: "deal-1", orderId: "order-1", clientId: CLIENT, positionId: null, symbol: "XAUUSD", volume: 0.2, price: 4632.5 }],
      positions: [{ positionId: "pos-9", symbol: "XAUUSD", volume: 9, direction: "LONG" }],
    }));
    expect(filled.state).toBe("RECONCILED");
    expect(codes(filled)).toContain("FILL_MATCHED");
    expect(codes(filled)).toContain("POSITION_UNCORRELATED");
    expect(filled.findings.find((item) => item.code === "FILL_MATCHED")?.brokerVolume).toBe(0.2);
    expect(filled.findings.find((item) => item.code === "POSITION_UNCORRELATED")?.brokerVolume).toBe(9);
    const positionOnly = reconcile(base, snapshot({
      orders: [],
      positions: [{ positionId: "pos-9", symbol: "XAUUSD", volume: 0.2, direction: "LONG" }],
    }), "SUBMISSION_UNKNOWN");
    expect(positionOnly.state).toBe("UNKNOWN");
    expect(codes(positionOnly)).toContain("POSITION_UNCORRELATED");
    expect(codes(positionOnly)).not.toContain("ORDER_MATCHED");
  });

  it("does not cross-match another XAUUSD order or an older client id", () => {
    const base = request();
    const book = snapshot({
      orders: [
        order("order-old", OTHER, 0.2),
        order("order-new", CLIENT, 0.2),
        order("order-fx", "ffffffffffffffffffffffffff", 1, "EURUSD"),
      ],
    });
    const result = reconcile(base, book);
    expect(result.state).toBe("RECONCILED");
    expect(result.findings.find((item) => item.code === "ORDER_MATCHED")?.orderId).toBe("order-new");
    expect(codes(result)).toContain("FOREIGN_SYMBOL_OBSERVED");
    const missed = reconcile(base, snapshot({ orders: [order("order-old", OTHER, 0.2)] }), "SUBMISSION_ACCEPTED");
    expect(missed.state).toBe("DESYNCED");
    expect(codes(missed)).toContain("ORDER_MISSING");
    const ambiguous = reconcile(base, snapshot({
      orders: [order("order-a", CLIENT, 0.2), order("order-b", CLIENT, 0.2)],
    }));
    expect(ambiguous.state).toBe("DESYNCED");
    expect(codes(ambiguous)).toContain("AMBIGUOUS_CORRELATION");
  });

  it("is deterministic and appends a later run without changing the first", () => {
    const base = request();
    const book = snapshot();
    const first = reconcile(base, book, "SUBMISSION_UNKNOWN");
    const second = reconcile(base, book, "SUBMISSION_UNKNOWN");
    expect(second.reconciliationRunId).toBe(first.reconciliationRunId);
    expect(second.state).toBe(first.state);
    expect(second.findings).toEqual(first.findings);
    const later = reconcile(base, book, "SUBMISSION_UNKNOWN", LATER);
    expect(later.reconciliationRunId).not.toBe(first.reconciliationRunId);
    expect(later.state).toBe(first.state);
    expect(later.findings).toEqual(first.findings);
    const sameBook = snapshot();
    expect(sameBook.snapshotId).toBe(book.snapshotId);
    expect(sameBook.fingerprint).toBe(book.fingerprint);
    expect(Object.isFrozen(book)).toBe(true);
    const store = tempStore();
    expect(store.saveSnapshot(book).inserted).toBe(true);
    expect(store.saveSnapshot(book).inserted).toBe(false);
    expect(store.countBrokerOrders(book.snapshotId)).toBe(1);
    expect(store.saveReconciliation(first).inserted).toBe(true);
    expect(store.saveReconciliation(first).inserted).toBe(false);
    expect(store.saveReconciliation(later).inserted).toBe(true);
    const stored = store.readReconciliations(base.executionIdentity);
    expect(stored).toHaveLength(2);
    expect(stored[0]).toEqual(first);
    expect(store.countFindings(first.reconciliationRunId)).toBe(first.findings.length);
    expect(store.readEvents().some((event) => event.type === "reconciliation.completed")).toBe(true);
    expect(JSON.stringify(store.readEvents())).not.toContain(TOKEN);
    store.close();
  });

  it("reads the kill switch and does not clear it or submit a repair", () => {
    const engaged = kill(true);
    const before = JSON.stringify(engaged);
    const result = reconcileExecution({
      request: request(),
      attempts: [attempt(request(), "SUBMISSION_UNKNOWN")],
      snapshot: snapshot({ volume: 0.1 }),
      killSwitch: engaged,
      reconciledAt: AT,
      agentRunId: RUN,
    });
    expect(result.state).toBe("DESYNCED");
    expect(result.killSwitchEngaged).toBe(true);
    expect(result.repairAttempted).toBe(false);
    expect(result.retried).toBe(false);
    expect(JSON.stringify(engaged)).toBe(before);
    expect(JSON.stringify(result)).not.toContain("submit");
    expect(() => foundationControl.reconcile()).toThrow(TradingDomainError);
  });
});

describe("read-only broker capture", () => {
  it("does not call the reader for SIMULATOR, REPLAY, or a mismatched account", async () => {
    let calls = 0;
    const reader = countingReader(() => {
      calls += 1;
    });
    const simulator = await captureBrokerSnapshot({
      environment: "SIMULATOR",
      provenance: "LIVE",
      binding: accountBinding(),
      configured: true,
      reader,
      observedAt: AT,
    });
    expect(simulator.brokerCallSkipped).toBe(true);
    expect(simulator.unavailable).toBe(true);
    const replay = await captureBrokerSnapshot({
      environment: "PAPER",
      provenance: "REPLAY",
      binding: accountBinding(),
      configured: true,
      reader,
      observedAt: AT,
    });
    expect(replay.brokerCallSkipped).toBe(true);
    const mismatched = await captureBrokerSnapshot({
      environment: "LIVE",
      provenance: "LIVE",
      binding: accountBinding("PAPER"),
      configured: true,
      reader,
      observedAt: AT,
    });
    expect(mismatched.brokerCallSkipped).toBe(true);
    expect(calls).toBe(0);
    const adapter = createMetaApiReconciliationAdapter({
      binding: accountBinding(),
      token: TOKEN,
      accountId: ACCOUNT,
      reader,
    });
    expect(adapter.readOnly).toBe(true);
    expect(adapter).not.toHaveProperty("submit");
    expect(JSON.stringify(adapter)).not.toContain(TOKEN);
    expect(JSON.stringify(adapter)).not.toContain(ACCOUNT);
    const captured = await adapter.capture({ environment: "PAPER", provenance: "LIVE", observedAt: AT });
    expect(calls).toBe(4);
    expect(captured.complete).toBe(true);
    expect(JSON.stringify(captured)).not.toContain(TOKEN);
  });

  it("drops secret-bearing broker payloads and does not invent orders when the reader fails", async () => {
    const reader: MetaApiReconciliationReader = {
      getOrders: async () => ({ kind: "ok", value: [{ token: TOKEN, orderId: "order-1", symbol: "XAUUSD", volume: 0.2 }] }),
      getDeals: async () => {
        throw new Error(TOKEN);
      },
      getPositions: async () => ({ kind: "unavailable" }),
      getAccountState: async () => ({ kind: "ok", value: { balance: 10, currency: "USD", password: TOKEN } }),
    };
    const captured = await captureBrokerSnapshot({
      environment: "PAPER",
      provenance: "LIVE",
      binding: accountBinding(),
      configured: true,
      reader,
      observedAt: AT,
    });
    expect(captured.channels.orders).toBe("unavailable");
    expect(captured.orders).toEqual([]);
    expect(captured.channels.account).toBe("unavailable");
    expect(JSON.stringify(captured)).not.toContain(TOKEN);
    expect(captured.complete).toBe(false);
  });
});

describe("phase 9 static review", () => {
  it("does not add a retry, a broker submit, a clock identity, or a destructive migration", () => {
    const root = join(import.meta.dirname, "..");
    const files = ["reconciliation", "persistence"].flatMap((dir) => readdirSync(join(root, dir))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => readFileSync(join(root, dir, name), "utf8")));
    const source = files.join("\n");
    for (const token of ["Date.now", "Math.random", "fetch(", "place_order", "submit_order", "execute_trade", "MetaTrader5", "console.log", "console.error", "DROP", "DELETE FROM"]) {
      expect(source).not.toContain(token);
    }
    expect(source).not.toContain("submitAuthorizedExecution");
    const store = readFileSync(join(root, "persistence", "store.ts"), "utf8");
    expect(store.match(/UPDATE\s+[a-z_]+/g)).toEqual(["UPDATE schema_meta"]);
  });
});

function order(orderId: string, clientId: string, volume: number, symbol = "XAUUSD") {
  return {
    orderId,
    clientId,
    symbol,
    volume,
    direction: "LONG" as const,
    state: "ORDER_STATE_PLACED",
    stopLoss: 4624.5,
    takeProfit: 4648,
  };
}

function readIdentities(store: TradingStore): ExecutionAttemptRecord[] {
  const db = new DatabaseSync(store.path);
  const rows = db.prepare("SELECT execution_identity FROM execution_attempts").all() as Array<{ execution_identity: string }>;
  db.close();
  return rows.flatMap((row) => [...store.readAttempts(row.execution_identity)]);
}

function countingReader(onCall: () => void): MetaApiReconciliationReader {
  const ok = async (value: unknown) => {
    onCall();
    return { kind: "ok" as const, value };
  };
  return {
    getOrders: () => ok([order("order-1", CLIENT, 0.2)]),
    getDeals: () => ok([]),
    getPositions: () => ok([]),
    getAccountState: () => ok({ balance: 10000, equity: 10000, margin: 100, currency: "USD" }),
  };
}
