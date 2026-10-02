import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseKillSwitchState } from "../../../shared/trading/kill-switch.ts";
import type { XauUsdRoutineMarker } from "../../../shared/trading/routine-marker.ts";
import { FORBIDDEN_EXECUTION_TOOL_NAMES, XAUUSD_TOOL_CATALOG } from "../agent/catalog.ts";
import { createDeterministicXauUsdProvider } from "../infrastructure/market_data/provider.ts";
import { routineAgentRunId, routineOccurrenceId } from "../occurrence/identity.ts";
import {
  bindXauUsdProviderTurn,
  startNativeRoutineTurn,
} from "../occurrence/runtime.ts";
import { openTradingStore, type TradingStore } from "../persistence/store.ts";
import { buildBrokerSnapshot, type BrokerAccountSnapshot } from "../reconciliation/snapshot.ts";
import { RoutineManager, type RoutineRunOn, type RoutineRunTrigger } from "../../routines.ts";
import { runMonitoringCycle, type MonitoringCycleInput, type MonitoringDecisionName } from "./cycle.ts";

const AT = "2026-08-15T14:30:00.000Z";
const ROUTINE_RUN = "44444444-4444-4444-8444-444444444444";
const TURN = "turn-provider-1";
const TOKEN = "metaapi-token-value";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function agentRunId(): string {
  return routineAgentRunId(ROUTINE_RUN);
}

function marker(level: XauUsdRoutineMarker["autonomyLevel"] = 5): XauUsdRoutineMarker {
  return {
    environment: "PAPER",
    autonomyLevel: level,
    permissions: ["market.read", "account.read", "position.read", "decision.propose", "intent.propose"],
  };
}

function store(): TradingStore {
  const dir = mkdtempSync(join(tmpdir(), "xauusd-monitor-"));
  dirs.push(dir);
  return openTradingStore({ path: join(dir, "trading.db"), environment: "PAPER" });
}

function bind(saved: TradingStore, reconciliation: "RECONCILED" | "DEGRADED" | "DESYNCED" | "UNKNOWN" | null = "RECONCILED", execution: "SUBMISSION_ACCEPTED" | "SUBMISSION_UNKNOWN" = "SUBMISSION_ACCEPTED") {
  const occurrenceId = routineOccurrenceId(ROUTINE_RUN);
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
  saved.occurrences.attachExecutionReceipt({
    occurrenceId,
    agentRunId: agentRunId(),
    environment: "PAPER",
    executionRequestId: "exr.monitor-1",
    executionState: execution,
    failureCode: execution === "SUBMISSION_UNKNOWN" ? "BROKER_UNKNOWN" : null,
    domainStatus: execution === "SUBMISSION_UNKNOWN" ? "submitted_unknown" : null,
  });
  if (reconciliation !== null) {
    saved.occurrences.attachReconciliationReceipt({
      occurrenceId,
      agentRunId: agentRunId(),
      environment: "PAPER",
      executionRequestId: "exr.monitor-1",
      reconciliationRunId: `rec.monitor-${reconciliation}`,
      reconciliationState: reconciliation,
      reconciledAt: AT,
    });
  }
  return occurrenceId;
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

function market(provenance = "LIVE", providerTimestamp = AT) {
  return {
    snapshotId: "snap-1",
    provenance,
    freshness: provenance === "STALE" ? "stale" : provenance === "UNAVAILABLE" ? "unavailable" : "fresh",
    providerTimestamp,
    bid: 4630,
    ask: 4633,
    spread: 3,
  };
}

function account() {
  return {
    equity: 10_000,
    currency: "USD",
    exposureSide: "long",
    exposureLots: 0.12,
    openRiskAmount: 0,
    asOf: AT,
    provenance: "LIVE",
    freshness: "fresh",
    sourceId: "acct-fixture",
    sourceVersion: "v1",
  };
}

function book(positions: BrokerAccountSnapshot["positions"] = []): BrokerAccountSnapshot {
  return buildBrokerSnapshot({
    bindingId: "paper-binding-1",
    environment: "PAPER",
    observedAt: AT,
    brokerCallSkipped: false,
    channels: { orders: "read", deals: "read", positions: "read", account: "read" },
    source: "injected-reader",
    orders: [],
    deals: [],
    positions,
    account: { balance: 10000, equity: 10000, margin: 100, currency: "USD" },
  });
}

function position(positionId: string, volume = 0.12, symbol = "XAUUSD") {
  return { positionId, symbol, volume, direction: "LONG" as const };
}

function cycle(saved: TradingStore, overrides: Partial<MonitoringCycleInput> = {}, occurrenceId?: string) {
  const id = occurrenceId ?? saved.occurrences.readByRoutineRun(ROUTINE_RUN)?.occurrenceId ?? bind(saved);
  return runMonitoringCycle({
    store: saved,
    occurrenceId: id,
    marker: marker(),
    observedAt: AT,
    market: market(),
    account: account(),
    snapshot: book(),
    killSwitch: kill(false),
    paused: false,
    decision: "NO_ACTION",
    riskConfig: { version: "risk-v1", maxRiskPercent: 0.02, requireStop: true },
    policyConfig: { version: "policy-v1" },
    ...overrides,
  });
}

describe("phase 10.4 native monitoring", () => {
  it("runs from RoutineManager as one routine run, one thread, and one provider turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xauusd-monitor-routine-"));
    dirs.push(dir);
    const path = join(dir, "trading.db");
    const threads: string[] = [];
    const manager = new RoutineManager({
      file: join(dir, "routines.json"),
      now: () => Date.parse(AT),
      botState: () => "ready",
      goalState: () => "ready",
      createTask: () => {
        threads.push("thread-from-store");
        return { threadId: "thread-from-store" };
      },
      startTurn: async (
        _botId: string,
        threadId: string,
        _prompt: string,
        _runOn: RoutineRunOn,
        _triggerSource: RoutineRunTrigger,
        _onDispatchError: (message: string) => void,
      ) => {
        const active = manager.listRuns()
          .filter((run) => run.status === "running")
          .map((run) => ({ id: run.id, routineId: run.routineId }));
        await startNativeRoutineTurn({
          active,
          markerOf: (routineId) => manager.listRoutines().find((routine) => routine.id === routineId)?.xauusd,
          threadId,
          driverKind: "openai-compat",
          env: { OMB_XAUUSD_STORE_PATH: path, OMB_XAUUSD_ENVIRONMENT: "PAPER" },
          marketDataProvider: createDeterministicXauUsdProvider({
            providerId: "explicit-paper-feed",
            environment: "PAPER",
            successProvenance: "LIVE",
          }),
          startedAt: AT,
          startTurn: async () => {
            bindXauUsdProviderTurn({
              threadId,
              providerTurnId: TURN,
              modelProvider: "openai-compat",
              modelId: "fixture-model",
              observedAt: AT,
            });
          },
        });
      },
    });
    const routine = manager.create({
      name: "XAUUSD watch",
      prompt: "Observe XAUUSD.",
      botId: "bot-a",
      schedule: { type: "interval", everyMinutes: 15, anchorAt: Date.parse(AT) },
      xauusd: marker(),
    });
    manager.runNow(routine.id);
    await manager.tick();
    expect(manager.listRuns()).toHaveLength(1);
    expect(threads).toEqual(["thread-from-store"]);
    const run = manager.listRuns()[0];
    expect(run?.threadId).toBe("thread-from-store");
    const saved = openTradingStore({ path, environment: "PAPER" });
    const occurrence = saved.occurrences.readByRoutineRun(run?.id ?? "");
    expect(occurrence?.providerTurnId).toBe(TURN);
    expect(occurrence?.threadId).toBe("thread-from-store");
    expect(occurrence?.routineId).toBe(routine.id);
    const observed = runMonitoringCycle({
      store: saved,
      occurrenceId: occurrence?.occurrenceId ?? "",
      marker: marker(),
      observedAt: AT,
      market: market(),
      account: account(),
      snapshot: book(),
      killSwitch: parseKillSwitchState({
        schemaVersion: 1,
        environment: "PAPER",
        engaged: false,
        agentRunId: occurrence?.agentRunId ?? "",
        updatedAt: AT,
        source: "operator",
      }),
      paused: false,
      decision: "CONTINUE_MONITORING",
      riskConfig: { version: "risk-v1", maxRiskPercent: 0.02, requireStop: true },
      policyConfig: { version: "policy-v1" },
    });
    expect(observed.routineRunId).toBe(run?.id);
    expect(observed.providerTurnId).toBe(TURN);
    expect(observed.brokerCalled).toBe(false);
    expect(saved.occurrences.readByRoutineRun(run?.id ?? "")?.occurrenceId).toBe(observed.occurrenceId);
    saved.close();
  });

  it("accepts a live observation and blocks stale, unavailable, simulator, and replay data", () => {
    const live = store();
    const accepted = cycle(live);
    expect(accepted.market.provenance).toBe("LIVE");
    expect(accepted.market.bid).toBe(4630);
    expect(accepted.market.ask).toBe(4633);
    expect(accepted.semantics).toContain("WATCHING");
    expect(accepted.failureCodes).toEqual([]);
    expect(accepted.events.at(-1)?.type).toBe("monitoring.completed");
    expect(accepted.executionSubmitted).toBe(false);

    const stale = store();
    const aged = cycle(stale, { market: market("STALE", "2026-08-15T14:00:00.000Z") });
    expect(aged.semantics).toContain("DATA_STALE");
    expect(aged.semantics).toContain("WATCHING");
    expect(aged.autonomousExecutionBlocked).toBe(true);
    expect(aged.failureCodes).toContain("MARKET_DATA_STALE");
    expect(aged.events.some((event) => event.type === "market.stale")).toBe(true);

    const missing = store();
    const unavailable = cycle(missing, { market: null });
    expect(unavailable.market.provenance).toBe("UNAVAILABLE");
    expect(unavailable.failureCodes).toContain("MARKET_DATA_UNAVAILABLE");
    expect(unavailable.executionSubmitted).toBe(false);

    const simulator = store();
    const simulated = cycle(simulator, { market: market("SIMULATOR") });
    expect(simulated.failureCodes).toContain("PROVENANCE_REJECTED");
    expect(simulated.brokerCalled).toBe(false);

    const replay = store();
    const replayed = cycle(replay, { market: market("REPLAY") });
    expect(replayed.failureCodes).toContain("PROVENANCE_REJECTED");
    expect(replayed.executionSubmitted).toBe(false);
  });

  it("uses the broker position and does not invent one from an accepted order", () => {
    const saved = store();
    const present = cycle(saved, { snapshot: book([position("pos-9")]) });
    expect(present.position).toMatchObject({ state: "POSITION_PRESENT", positionId: "pos-9", quantity: 0.12, entry: null });
    expect(present.executionState).toBe("SUBMISSION_ACCEPTED");

    const acceptedOnly = store();
    const empty = cycle(acceptedOnly, { snapshot: book([]) });
    expect(empty.position.state).toBe("NO_POSITION");
    expect(empty.position.positionId).toBeNull();
    expect(empty.semantics).toContain("NO_POSITION");
    expect(empty.executionSubmitted).toBe(false);

    const ambiguous = store();
    const mixed = cycle(ambiguous, { snapshot: book([position("pos-a"), position("pos-b")]) });
    expect(mixed.position.state).toBe("AMBIGUOUS");
    expect(mixed.failureCodes).toContain("POSITION_IDENTITY_AMBIGUOUS");
    expect(mixed.semantics).toContain("RECONCILIATION_REQUIRED");
    expect(mixed.brokerCalled).toBe(false);

    const foreign = store();
    const other = cycle(foreign, { snapshot: book([position("fx-1", 1, "EURUSD")]) });
    expect(other.position.state).toBe("NO_POSITION");
    expect(other.position.positionId).toBeNull();
    expect(other.foreignSymbols).toEqual(["EURUSD"]);
    expect(JSON.stringify(other.position)).not.toContain("EURUSD");
    expect(JSON.stringify(other.modelContext.position)).toContain("EURUSD");
  });

  it("blocks degraded, desynced, and unknown reconciliation without submitting a remainder", () => {
    const healthy = store();
    const reconciled = cycle(healthy, { decision: "CONTINUE_MONITORING" });
    expect(reconciled.reconciliationState).toBe("RECONCILED");
    expect(reconciled.failureCodes).toEqual([]);
    expect(reconciled.autonomousExecutionBlocked).toBe(false);
    expect(reconciled.semantics).toContain("WATCHING");

    const degradedStore = store();
    const degraded = cycle(degradedStore, { snapshot: book([position("pos-9", 0.05)]) }, bind(degradedStore, "DEGRADED"));
    expect(degraded.reconciliationState).toBe("DEGRADED");
    expect(degraded.position.quantity).toBe(0.05);
    expect(degraded.failureCodes).toContain("RECONCILIATION_DEGRADED");
    expect(degraded.autonomousExecutionBlocked).toBe(true);
    expect(degraded.executionSubmitted).toBe(false);
    expect(degradedStore.readAttempts("exn.none")).toEqual([]);

    const desyncedStore = store();
    const desynced = cycle(desyncedStore, {}, bind(desyncedStore, "DESYNCED"));
    expect(desynced.failureCodes).toContain("RECONCILIATION_DESYNCED");
    expect(desynced.executionSubmitted).toBe(false);

    const unknownStore = store();
    const unknown = cycle(unknownStore, {}, bind(unknownStore, "UNKNOWN", "SUBMISSION_UNKNOWN"));
    expect(unknown.executionState).toBe("SUBMISSION_UNKNOWN");
    expect(unknown.failureCodes).toContain("RECONCILIATION_UNKNOWN");
    expect(unknown.brokerCalled).toBe(false);
  });

  it("passes a monitoring decision through risk and policy without a broker close", () => {
    const saved = store();
    const result = cycle(saved, {
      decision: "EXIT",
      snapshot: book([position("pos-9")]),
      exitReason: "monitoring exit proposal",
      proposedExitQuantity: 0.12,
      exitEntry: 4632.5,
      exitStop: 4624.5,
    });
    expect(result.decision).toBe("EXIT");
    expect(result.proposal?.risk.state).toBeTruthy();
    expect(result.policy.state).toBeTruthy();
    expect(result.exitProposal).toMatchObject({
      instrument: "XAUUSD",
      positionId: "pos-9",
      positionQuantity: 0.12,
      proposedExitQuantity: 0.12,
      executable: false,
      brokerSubmit: false,
    });
    expect(result.failureCodes).toContain("EXIT_CLOSE_NOT_REPRESENTABLE");
    expect(result.brokerCalled).toBe(false);
    expect(result.executionSubmitted).toBe(false);
    expect(result.semantics).toContain("EXIT_REQUIRED");
    const names = XAUUSD_TOOL_CATALOG.map((tool) => tool.name);
    for (const banned of [...FORBIDDEN_EXECUTION_TOOL_NAMES, "execute_order", "modify_position", "position.close"]) {
      expect(names).not.toContain(banned);
    }
  });

  it("keeps pause and the emergency stop apart, and the model cannot clear the stop", () => {
    const pausedStore = store();
    const paused = cycle(pausedStore, { paused: true, decision: "CONTINUE_MONITORING" });
    expect(paused.semantics).toContain("PAUSED");
    expect(paused.semantics).toContain("WATCHING");
    expect(paused.events.some((event) => event.type === "market.updated")).toBe(true);
    expect(paused.failureCodes).toContain("PAUSED");
    expect(paused.executionSubmitted).toBe(false);
    expect(paused.events.some((event) => event.type === "emergency.stop")).toBe(false);

    const stoppedStore = store();
    const engaged = kill(true);
    const stopped = cycle(stoppedStore, { killSwitch: engaged });
    expect(stopped.failureCodes).toContain("KILL_SWITCH_ENGAGED");
    expect(stopped.events.some((event) => event.type === "emergency.stop")).toBe(true);
    expect(stopped.brokerCalled).toBe(false);
    expect(engaged.engaged).toBe(true);

    const rejected = store();
    bind(rejected);
    expect(() => cycle(rejected, { disableKillSwitch: true } as Partial<MonitoringCycleInput>)).toThrow(/unsupported field/);
    expect(engaged.engaged).toBe(true);
  });

  it("records correlated monitoring events and leaves credentials out", () => {
    const saved = store();
    const result = cycle(saved, { decision: "WAIT" });
    expect(result.events.map((event) => event.type)).toEqual([
      "monitoring.started",
      "market.updated",
      "account.observed",
      "position.observed",
      "decision.created",
      "monitoring.completed",
    ]);
    for (const event of result.events) {
      expect(event.agentRunId).toBe(result.agentRunId);
      expect(event.correlationId).toBe(result.occurrenceId);
      expect(event.runtimeThreadId).toBe(result.threadId);
      expect(event.runtimeTurnId).toBe(result.providerTurnId);
      expect(event.payload).toMatchObject({
        occurrenceId: result.occurrenceId,
        routineId: result.routineId,
        routineRunId: result.routineRunId,
      });
      expect(JSON.stringify(event)).not.toContain(TOKEN);
    }
    expect(result.events.some((event) => event.type === "agent.thinking")).toBe(false);
    expect(JSON.stringify(result.modelContext)).not.toContain(TOKEN);
    expect(JSON.stringify(saved.occurrences.readByOccurrenceId(result.occurrenceId))).not.toContain(TOKEN);
    expect(() => cycle(saved, { token: TOKEN } as Partial<MonitoringCycleInput>)).toThrow(/secret|credential|unsupported field/i);
  });

  it("does not create a second occurrence or retry an unknown submission after restart", () => {
    const saved = store();
    const occurrenceId = bind(saved, "UNKNOWN", "SUBMISSION_UNKNOWN");
    const first = cycle(saved, {}, occurrenceId);
    const path = saved.path;
    const eventCount = saved.readEvents().length;
    saved.close();
    const reopened = openTradingStore({ path, environment: "PAPER" });
    const second = cycle(reopened, {}, occurrenceId);
    expect(second.occurrenceId).toBe(first.occurrenceId);
    expect(second.executionState).toBe("SUBMISSION_UNKNOWN");
    expect(second.failureCodes).toContain("RECONCILIATION_UNKNOWN");
    expect(reopened.readEvents()).toHaveLength(eventCount);
    expect(reopened.occurrences.readByRoutineRun(ROUTINE_RUN)?.executionRequestId).toBe("exr.monitor-1");
    expect(reopened.readAttempts("exn.none")).toEqual([]);
    reopened.close();
  });

  it("does not schedule, poll, or submit from the monitoring cycle", () => {
    const source = readFileSync(new URL("./cycle.ts", import.meta.url), "utf8");
    for (const token of [
      "setInterval",
      "setTimeout",
      "while(true)",
      "while (true)",
      "node-cron",
      "bullmq",
      "submitAuthorizedExecution",
      "close_position",
      "place_order",
      "new Worker",
    ]) {
      expect(source).not.toContain(token);
    }
    const decisions: MonitoringDecisionName[] = ["NO_ACTION", "WAIT", "CONTINUE_MONITORING"];
    expect(decisions).not.toContain("LONG" as MonitoringDecisionName);
  });
});
