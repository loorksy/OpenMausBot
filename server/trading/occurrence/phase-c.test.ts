import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTONOMY_NAMES, parseAutonomyState, type AutonomyLevel } from "../../../shared/trading/autonomy.ts";
import { parseDecision, type DecisionDirection } from "../../../shared/trading/decision.ts";
import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { isTradingEvent, parseTradingEvent, tradingEventsAreNotRuntimeEvents, type TradingEvent } from "../../../shared/trading/events.ts";
import { parseKillSwitchState, type KillSwitchState } from "../../../shared/trading/kill-switch.ts";
import { parseOrderIntent, type OrderIntentDirection } from "../../../shared/trading/order-intent.ts";
import type { RuntimeEvent } from "../../../shared/runtime-events.ts";
import { XAUUSD_TOOL_CATALOG, FORBIDDEN_EXECUTION_TOOL_NAMES } from "../agent/catalog.ts";
import { assessApproval } from "../approval/assess.ts";
import { openTradingApproval, settleNativeTradingApproval } from "../approval/native.ts";
import { loadTradingRoom } from "../desk/load.ts";
import { projectTradingRoom, type TradingRoomInput } from "../desk/room.ts";
import { evaluateExecutionEligibility } from "../eligibility/handoff.ts";
import { submitEligibleExecution } from "../eligibility/execute.ts";
import { createMemoryExecutionLedger } from "../execution/ledger.ts";
import type { XauUsdExecutionProvider } from "../execution/provider.ts";
import { submitAuthorizedExecution, type ExecutionSubmitInput } from "../execution/submit.ts";
import { evaluateFireTimeGate, type FireTimeGateInput } from "../gate/evaluate.ts";
import { createDeterministicXauUsdProvider } from "../infrastructure/market_data/provider.ts";
import { correlateNativeConversation } from "./correlation.ts";
import { routineAgentRunId, routineOccurrenceId } from "./identity.ts";
import {
  bindXauUsdProviderTurn,
  dispatchXauUsdRoutineTurn,
  installXauUsdMarketDataProvider,
  startNativeRoutineTurn,
} from "./runtime.ts";
import { evaluateXauUsdProposal, type ProposalInput } from "../proposal/evaluate.ts";
import { openTradingStore, type TradingStore } from "../persistence/store.ts";
import { RoutineManager } from "../../routines.ts";

const AT = "2026-08-28T10:00:00.000Z";
const LATER = "2026-08-28T10:01:00.000Z";
const RUN = "22222222-2222-4222-8222-222222222222";
const THREAD = "thread-from-store";
const OTHER_THREAD = "thread-unrelated";
const TURN = "provider-turn-9";
const dirs: string[] = [];
const stores: TradingStore[] = [];

afterEach(() => {
  installXauUsdMarketDataProvider(null);
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // The test already closed this store.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "xauusd-phase-c-"));
  dirs.push(dir);
  return dir;
}

function paperProvider() {
  return createDeterministicXauUsdProvider({
    providerId: "explicit-paper-feed",
    environment: "PAPER",
    successProvenance: "LIVE",
  });
}

function configuredEnv(dir: string) {
  return {
    OMB_XAUUSD_STORE_PATH: join(dir, "trading.db"),
    OMB_XAUUSD_ENVIRONMENT: "PAPER",
  };
}

const marker = {
  environment: "PAPER" as const,
  autonomyLevel: 4 as const,
  permissions: ["market.read", "decision.propose", "intent.propose"] as const,
};

function dispatch(dir: string, startTurn: () => Promise<unknown>, threadId = THREAD, routineRunId = RUN) {
  return dispatchXauUsdRoutineTurn({
    marker,
    routineId: "routine-1",
    routineRunId,
    threadId,
    driverKind: "openai-compat",
    env: configuredEnv(dir),
    marketDataProvider: paperProvider(),
    startedAt: AT,
    startTurn,
  });
}

function roomOf(dir: string, requestedThreadId?: string | null) {
  return loadTradingRoom(
    configuredEnv(dir),
    { provenance: "LIVE", timeframe: "M15", candles: [] },
    AT,
    requestedThreadId,
  );
}

function thinking(agentRunId: string, occurrenceId: string): TradingEvent {
  return parseTradingEvent({
    schemaVersion: 1,
    eventId: "evt-thinking-1",
    type: "agent.thinking",
    source: "trading-domain",
    at: LATER,
    agentRunId,
    correlationId: occurrenceId,
    environment: "PAPER",
    instrument: "XAUUSD",
    actor: "model",
    payload: { occurrenceId, text: "I'm checking the market." },
  });
}

describe("native thread correlation", () => {
  it("leaves an ordinary native turn without a trading occurrence", async () => {
    const dir = tempDir();
    const started: string[] = [];
    await startNativeRoutineTurn({
      active: [{ id: RUN, routineId: "routine-1" }],
      markerOf: () => undefined,
      threadId: THREAD,
      driverKind: "openai-compat",
      env: configuredEnv(dir),
      marketDataProvider: paperProvider(),
      startedAt: AT,
      startTurn: async () => { started.push("startTurn"); },
    });
    expect(started).toEqual(["startTurn"]);
    expect(bindXauUsdProviderTurn({
      threadId: THREAD,
      providerTurnId: TURN,
      modelProvider: "openai-compat",
      modelId: "fixture-model",
      observedAt: AT,
    })).toBeUndefined();
    const store = openTradingStore({ path: configuredEnv(dir).OMB_XAUUSD_STORE_PATH, environment: "PAPER" });
    expect(store.occurrences.listOccurrences()).toEqual([]);
    store.close();
    expect(roomOf(dir).attachedConversation.availability).toBe("NOT_AVAILABLE");
  });

  it("binds one native turn to one occurrence and the room's thread", async () => {
    const dir = tempDir();
    let grant: ReturnType<typeof bindXauUsdProviderTurn>;
    await dispatch(dir, async () => {
      grant = bindXauUsdProviderTurn({
        threadId: THREAD,
        providerTurnId: TURN,
        modelProvider: "openai-compat",
        modelId: "fixture-model",
        observedAt: AT,
      });
    });
    expect(grant?.correlation.runtimeThreadId).toBe(THREAD);
    expect(grant?.correlation.runtimeTurnId).toBe(TURN);
    expect(grant?.correlation.occurrenceId).toBe(routineOccurrenceId(RUN));
    expect(grant?.agentRunId).toBe(routineAgentRunId(RUN));
    expect(grant?.agentRunId).not.toBe(TURN);
    expect(grant?.agentRunId).not.toBe(THREAD);
    const store = openTradingStore({ path: configuredEnv(dir).OMB_XAUUSD_STORE_PATH, environment: "PAPER" });
    stores.push(store);
    const row = store.occurrences.readByRoutineRun(RUN);
    expect(store.occurrences.listOccurrences()).toHaveLength(1);
    expect(row).toMatchObject({
      threadId: THREAD,
      providerTurnId: TURN,
      occurrenceId: routineOccurrenceId(RUN),
      agentRunId: routineAgentRunId(RUN),
    });
    store.close();
    const room = roomOf(dir);
    expect(room.attachedConversation).toEqual({
      availability: "ATTACHED",
      threadId: THREAD,
      runtimeThreadId: THREAD,
      providerTurnId: TURN,
      runtimeTurnId: TURN,
      occurrenceId: routineOccurrenceId(RUN),
      agentRunId: routineAgentRunId(RUN),
      routineId: "routine-1",
      routineRunId: RUN,
    });
    expect(room.tradingCursor).toBeNull();
    expect(JSON.stringify(room)).not.toMatch(/token|apiKey|secret|metaapi/i);
  });

  it("keeps a missing thread and an unrelated thread unattached", () => {
    const missing = correlateNativeConversation({
      threadId: null,
      providerTurnId: TURN,
      occurrenceId: "occ-1",
      agentRunId: "run-1",
    });
    expect(missing.availability).toBe("NOT_AVAILABLE");
    expect(missing.threadId).toBeNull();
    expect(missing.runtimeThreadId).toBeNull();
    const unrelated = correlateNativeConversation({
      threadId: THREAD,
      providerTurnId: TURN,
      occurrenceId: routineOccurrenceId(RUN),
      agentRunId: routineAgentRunId(RUN),
      requestedThreadId: OTHER_THREAD,
    });
    expect(unrelated.availability).toBe("NOT_AVAILABLE");
    expect(unrelated.threadId).toBeNull();
    expect(JSON.stringify(unrelated)).not.toContain(OTHER_THREAD);
    expect(unrelated.occurrenceId).toBe(routineOccurrenceId(RUN));
  });
});

describe("native turn idempotency", () => {
  it("reuses the same occurrence and does not start a second provider turn", async () => {
    const dir = tempDir();
    const calls: string[] = [];
    await dispatch(dir, async () => {
      calls.push("first");
      bindXauUsdProviderTurn({
        threadId: THREAD,
        providerTurnId: TURN,
        modelProvider: "openai-compat",
        modelId: "fixture-model",
        observedAt: AT,
      });
    });
    await dispatch(dir, async () => { calls.push("second"); });
    expect(calls).toEqual(["first"]);
    const store = openTradingStore({ path: configuredEnv(dir).OMB_XAUUSD_STORE_PATH, environment: "PAPER" });
    stores.push(store);
    expect(store.occurrences.listOccurrences()).toHaveLength(1);
    expect(store.occurrences.readByRoutineRun(RUN)?.providerTurnId).toBe(TURN);
    expect(() => store.occurrences.insertRoutineOccurrence({
      routineId: "routine-1",
      routineRunId: RUN,
      threadId: THREAD,
      environment: "PAPER",
      startedAt: AT,
    })).toThrow(/rejected/i);
  });

  it("binds a retry that has not yet received a provider turn, still as one occurrence", async () => {
    const dir = tempDir();
    const calls: string[] = [];
    await expect(dispatch(dir, async () => {
      calls.push("first");
      throw new Error("turn dropped before bind");
    })).rejects.toThrow(/dropped/);
    await dispatch(dir, async () => {
      calls.push("second");
      bindXauUsdProviderTurn({
        threadId: THREAD,
        providerTurnId: TURN,
        modelProvider: "openai-compat",
        modelId: "fixture-model",
        observedAt: AT,
      });
    });
    expect(calls).toEqual(["first", "second"]);
    const store = openTradingStore({ path: configuredEnv(dir).OMB_XAUUSD_STORE_PATH, environment: "PAPER" });
    stores.push(store);
    expect(store.occurrences.listOccurrences()).toHaveLength(1);
    expect(store.occurrences.readByRoutineRun(RUN)?.providerTurnId).toBe(TURN);
  });

  it("fails closed when a retry names a different thread", async () => {
    const dir = tempDir();
    await dispatch(dir, async () => {
      bindXauUsdProviderTurn({
        threadId: THREAD,
        providerTurnId: TURN,
        modelProvider: "openai-compat",
        modelId: "fixture-model",
        observedAt: AT,
      });
    });
    const started = { called: false };
    await expect(dispatch(dir, async () => { started.called = true; }, OTHER_THREAD)).rejects.toThrow(/exactly one/);
    expect(started.called).toBe(false);
    const store = openTradingStore({ path: configuredEnv(dir).OMB_XAUUSD_STORE_PATH, environment: "PAPER" });
    stores.push(store);
    expect(store.occurrences.listOccurrences().map((row) => row.threadId)).toEqual([THREAD]);
    store.close();
    const room = roomOf(dir, OTHER_THREAD);
    expect(room.attachedConversation.availability).toBe("NOT_AVAILABLE");
    expect(JSON.stringify(room.attachedConversation)).not.toContain(OTHER_THREAD);
    expect(roomOf(dir).attachedConversation.threadId).toBe(THREAD);
  });
});

describe("room attachment", () => {
  it("finds the native thread from the durable occurrence before any trading event", async () => {
    const dir = tempDir();
    await dispatch(dir, async () => {
      bindXauUsdProviderTurn({
        threadId: THREAD,
        providerTurnId: TURN,
        modelProvider: "openai-compat",
        modelId: "fixture-model",
        observedAt: AT,
      });
    });
    const room = roomOf(dir);
    expect(room.source).toBe("store");
    expect(room.timeline).toEqual([]);
    expect(room.attachedConversation.threadId).toBe(THREAD);
    expect(room.attachedConversation.runtimeTurnId).toBe(TURN);
    expect(room.agentPresence).not.toBe("OBSERVING");
    expect(room.agentPresence).not.toBe("ANALYZING");
    expect(room.agentPresence).not.toBe("MONITORING");
  });

  it("does not let a chat sentence or a runtime frame become trading presence", async () => {
    const dir = tempDir();
    await dispatch(dir, async () => {
      bindXauUsdProviderTurn({
        threadId: THREAD,
        providerTurnId: TURN,
        modelProvider: "openai-compat",
        modelId: "fixture-model",
        observedAt: AT,
      });
    });
    const before = roomOf(dir).agentPresence;
    const store = openTradingStore({ path: configuredEnv(dir).OMB_XAUUSD_STORE_PATH, environment: "PAPER" });
    const row = store.occurrences.readByRoutineRun(RUN);
    if (!row) throw new Error("occurrence missing");
    store.appendEvents([thinking(row.agentRunId, row.occurrenceId)]);
    store.close();
    const after = roomOf(dir);
    expect(after.agentPresence).toBe(before);
    expect(after.agentPresence).not.toBe("OBSERVING");
    expect(after.timeline.map((entry) => entry.type)).toEqual(["agent.thinking"]);
    expect(after.tradingCursor).toBeNull();
    const runtime: RuntimeEvent = {
      eventId: "runtime-event-1",
      provider: "openai-compat",
      threadId: THREAD,
      createdAt: LATER,
      turnId: TURN,
      type: "turn.started",
    };
    expect(isTradingEvent(runtime)).toBe(false);
    expect(tradingEventsAreNotRuntimeEvents).toBe(true);
    expect(() => parseTradingEvent(runtime)).toThrow();
  });
});

describe("native approval correlation", () => {
  it("settles the same approval the room projects and does not execute a rejection", () => {
    const dir = tempDir();
    const env = configuredEnv(dir);
    const store = openTradingStore({ path: env.OMB_XAUUSD_STORE_PATH, environment: "SIMULATOR" });
    const occurrence = store.occurrences.insertRoutineOccurrence({
      routineId: "routine-1",
      routineRunId: RUN,
      threadId: THREAD,
      environment: "SIMULATOR",
      startedAt: AT,
    });
    store.occurrences.attachProviderTurn({
      routineId: "routine-1",
      routineRunId: RUN,
      threadId: THREAD,
      providerTurnId: TURN,
    });
    const { assessment } = approvalFixture(occurrence.agentRunId);
    openTradingApproval(store, {
      requestId: "req-trading-1",
      occurrenceId: occurrence.occurrenceId,
      requesterId: "owner",
      openedAt: AT,
      assessment,
    });
    store.close();
    const openRoom = loadTradingRoom(
      { ...env, OMB_XAUUSD_ENVIRONMENT: "SIMULATOR" },
      { provenance: "UNAVAILABLE", timeframe: null, candles: [] },
      AT,
    );
    expect(openRoom.approval.open?.requestId).toBe("req-trading-1");
    expect(openRoom.approval.decision).toBeNull();
    expect(openRoom.attachedConversation.threadId).toBe(THREAD);
    const settling = openTradingStore({ path: env.OMB_XAUUSD_STORE_PATH, environment: "SIMULATOR" });
    const rejected = settleNativeTradingApproval(settling, {
      requestId: "req-trading-1",
      behavior: "answer",
      message: "reject",
      source: "user",
      responderId: "owner",
      resolvedAt: LATER,
    });
    const again = settleNativeTradingApproval(settling, {
      requestId: "req-trading-1",
      behavior: "answer",
      message: "reject",
      source: "user",
      responderId: "owner",
      resolvedAt: LATER,
    });
    settling.close();
    expect(rejected.kind).toBe("trading");
    expect(again).toMatchObject({ kind: "trading", idempotent: true });
    if (rejected.kind !== "trading" || again.kind !== "trading") return;
    expect(again.decision.id).toBe(rejected.decision.id);
    expect(rejected.decision.state).toBe("REJECTED");
    expect(rejected.fact?.approved).toBe(false);
    const room = loadTradingRoom(
      { ...env, OMB_XAUUSD_ENVIRONMENT: "SIMULATOR" },
      { provenance: "UNAVAILABLE", timeframe: null, candles: [] },
      LATER,
    );
    expect(room.approval.decision?.id).toBe(rejected.decision.id);
    expect(room.approval.decision?.state).toBe("REJECTED");
    expect(room.approval.fact?.approved).toBe(false);
    expect(room.agentPresence).not.toBe("AWAITING_APPROVAL");
    const eligibility = evaluateExecutionEligibility({
      instrument: "XAUUSD",
      decision: assessment.decision,
      orderIntent: assessment.orderIntent,
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
      approvalConfig: assessment.config,
      gateConfig: { version: "gate-v1", maxMarketAgeMs: 60_000 },
      environment: "SIMULATOR",
      provenance: "SIMULATOR",
      assessedAt: LATER,
      agentRunId: occurrence.agentRunId,
      runtimeThreadId: THREAD,
      runtimeTurnId: TURN,
      autonomy: assessment.autonomy,
      permissions: assessment.permissions,
      policyApproval: "granted",
      approval: rejected.fact,
      approvalRequestId: "req-trading-1",
      reconciliation: "RECONCILED",
      killSwitch: assessment.killSwitch,
    });
    expect(eligibility.brokerCalled).toBe(false);
    expect(eligibility.orderSubmitted).toBe(false);
    expect(eligibility.stoppedAt).toBe("approval");
    expect(eligibility.state).not.toBe("ELIGIBLE_FOR_EXECUTION");
  });
});

describe("execution boundary", () => {
  it("re-reads the stored kill switch, blocks a stale market and a missing reconciliation, and does not submit twice", async () => {
    const ready = prepared();
    stores.push(ready.store);
    expect(ready.gate.state).toBe("ELIGIBLE_FOR_EXECUTION");
    const broker = countingProvider();
    const ledger = createMemoryExecutionLedger();
    const first = await submitAuthorizedExecution(executionInput(ready, broker.provider, ledger));
    const second = await submitAuthorizedExecution(executionInput(ready, broker.provider, ledger));
    expect(first.brokerCalled).toBe(true);
    expect(second.reasons).toContain("DUPLICATE_EXECUTION");
    expect(second.brokerCalled).toBe(false);
    expect(broker.calls()).toBe(1);
    const stale = evaluateFireTimeGate({
      ...ready.gateInput,
      market: { ...ready.gateInput.market!, freshness: "stale" },
    });
    expect(stale.state).toBe("BLOCKED");
    expect(stale.reasons).toContain("MARKET_DATA_STALE");
    ready.store.killSwitches.write(kill(true));
    const stopped = await submitAuthorizedExecution(executionInput(ready, broker.provider, createMemoryExecutionLedger(), { killSwitch: kill(false) }));
    expect(stopped.reasons).toContain("KILL_SWITCH_ENGAGED");
    expect(stopped.brokerCalled).toBe(false);
    expect(broker.calls()).toBe(1);
    const missingBook = evaluateExecutionEligibility({
      instrument: "XAUUSD",
      decision: ready.input.decision,
      orderIntent: ready.input.orderIntent,
      market: ready.input.market,
      account: ready.input.account,
      riskConfig: ready.input.riskConfig,
      policyConfig: ready.input.policyConfig,
      approvalConfig: { version: "approval-v1", maxAgeMs: 60_000 },
      gateConfig: { version: "gate-v1", maxMarketAgeMs: 60_000 },
      environment: ready.input.environment,
      provenance: ready.input.provenance,
      assessedAt: AT,
      agentRunId: "run-1",
      runtimeThreadId: THREAD,
      runtimeTurnId: TURN,
      autonomy: ready.input.autonomy,
      permissions: ready.input.permissions,
      policyApproval: "absent",
      approval: null,
      approvalRequestId: "req-1",
      reconciliation: null,
      killSwitch: ready.input.killSwitch,
      killSwitches: ready.store.killSwitches,
    });
    expect(missingBook.stoppedAt).toBe("reconciliation");
    expect(missingBook.brokerCalled).toBe(false);
    const handed = await submitEligibleExecution({
      instrument: "XAUUSD",
      decision: ready.input.decision,
      orderIntent: ready.input.orderIntent,
      market: ready.input.market,
      account: ready.input.account,
      riskConfig: ready.input.riskConfig,
      policyConfig: ready.input.policyConfig,
      approvalConfig: { version: "approval-v1", maxAgeMs: 60_000 },
      gateConfig: { version: "gate-v1", maxMarketAgeMs: 60_000 },
      environment: ready.input.environment,
      provenance: ready.input.provenance,
      assessedAt: AT,
      agentRunId: "run-1",
      runtimeThreadId: THREAD,
      runtimeTurnId: TURN,
      autonomy: ready.input.autonomy,
      permissions: ready.input.permissions,
      policyApproval: "absent",
      approval: null,
      approvalRequestId: "req-1",
      reconciliation: null,
      killSwitch: kill(false),
      killSwitches: ready.store.killSwitches,
      provider: broker.provider,
      ledger: createMemoryExecutionLedger(),
      accountBinding: binding(),
    });
    expect(handed.brokerCalled).toBe(false);
    expect(handed.execution).toBeNull();
    expect(broker.calls()).toBe(1);
  });
});

describe("routine correlation and snapshot separation", () => {
  it("follows routine run to the native thread and does not add a scheduler", async () => {
    const dir = tempDir();
    const env = configuredEnv(dir);
    const calls: string[] = [];
    let manager!: RoutineManager;
    manager = new RoutineManager({
      file: join(dir, "routines.json"),
      now: () => Date.parse(AT),
      botState: () => "ready",
      goalState: () => "ready",
      createTask: () => ({ threadId: THREAD }),
      startTurn: async (_botId, startedThread) => {
        calls.push(startedThread);
        await startNativeRoutineTurn({
          active: manager.listRuns().filter((run) =>
            run.threadId === startedThread && (run.status === "running" || run.status === "waiting")),
          markerOf: (routineId) => manager.listRoutines().find((routine) => routine.id === routineId)?.xauusd,
          threadId: startedThread,
          driverKind: "openai-compat",
          env,
          marketDataProvider: paperProvider(),
          startedAt: AT,
          startTurn: async () => {
            bindXauUsdProviderTurn({
              threadId: startedThread,
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
      name: "Gold watch",
      prompt: "Review XAUUSD.",
      botId: "bot-a",
      schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
      xauusd: marker,
    });
    manager.runNow(routine.id);
    await vi.waitFor(() => {
      if (!calls.includes(THREAD)) throw new Error("routine turn was not reached");
    });
    const run = manager.listRuns().find((candidate) => candidate.routineId === routine.id);
    expect(run?.threadId).toBe(THREAD);
    const store = openTradingStore({ path: env.OMB_XAUUSD_STORE_PATH, environment: "PAPER" });
    stores.push(store);
    const row = store.occurrences.readByRoutineRun(run!.id);
    expect(row?.threadId).toBe(THREAD);
    expect(row?.providerTurnId).toBe(TURN);
    expect(row?.occurrenceId).toBe(routineOccurrenceId(run!.id));
    expect(store.occurrences.listOccurrences()).toHaveLength(1);
    store.close();
    expect(roomOf(dir).attachedConversation).toMatchObject({
      availability: "ATTACHED",
      threadId: THREAD,
      runtimeThreadId: THREAD,
      providerTurnId: TURN,
      runtimeTurnId: TURN,
      occurrenceId: row?.occurrenceId,
      agentRunId: row?.agentRunId,
    });
    const runtime = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8");
    expect(runtime).not.toContain("setInterval");
    expect(runtime).not.toContain("new Worker");
    expect(runtime).not.toContain("TradingScheduler");
    expect(runtime).not.toContain("submitAuthorizedExecution");
    expect(runtime).not.toContain("provider.submit");
  });

  it("keeps the room on a snapshot and the broker call inside the execution boundary", () => {
    const files = productionSources(join(import.meta.dirname, "../.."));
    const submitters = files.filter((file) => readFileSync(file, "utf8").includes("provider.submit"));
    expect(submitters).toEqual([join(import.meta.dirname, "../execution/submit.ts")]);
    const desk = readFileSync(new URL("../desk/load.ts", import.meta.url), "utf8");
    const client = readFileSync(new URL("../../../src/components/TradingDesk.tsx", import.meta.url), "utf8");
    const execute = readFileSync(new URL("../eligibility/execute.ts", import.meta.url), "utf8");
    expect(desk).not.toContain("text/event-stream");
    expect(desk).not.toContain("EventSource");
    expect(client).not.toContain("EventSource");
    expect(client).not.toContain("STREAM_ID");
    expect(client).toContain("attachedConversationHref");
    expect(execute).toContain("submitAuthorizedExecution");
    expect(execute).not.toContain("provider.submit");
    const catalog = XAUUSD_TOOL_CATALOG.map((tool) => tool.name);
    for (const name of FORBIDDEN_EXECUTION_TOOL_NAMES) expect(catalog).not.toContain(name);
    expect(catalog).not.toContain("provider.submit");
    const projected = projectTradingRoom(emptyRoom());
    expect(projected.tradingCursor).toBeNull();
    expect(projected.agentPresence).not.toBe("OBSERVING");
  });
});

function emptyRoom(): TradingRoomInput {
  return {
    source: "store",
    serverNow: AT,
    environment: "PAPER",
    events: [],
    market: {
      provider: "available",
      observation: {
        provenance: "LIVE",
        timeframe: "M15",
        bid: null,
        ask: null,
        spread: null,
        providerTimestamp: AT,
        receivedAt: AT,
        ageMs: 0,
        candleCount: 0,
      },
    },
    positionInputs: {
      executionState: null,
      reconciliationState: "RECONCILED",
      brokerPositionId: null,
      brokerQuantity: null,
      authorizedQuantity: null,
      exitState: null,
      ambiguous: false,
    },
    brokerView: null,
    killSwitch: kill(false),
    job: null,
    occurrence: null,
    decision: null,
    risk: null,
    policy: null,
    gate: null,
    approvalOpen: null,
    approvalDecision: null,
    execution: null,
    exitExecution: null,
    reconciliation: { id: "rec-1", state: "RECONCILED" },
    monitoring: null,
    memory: [],
    learning: null,
  };
}

function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionSources(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

function approvalFixture(agentRunId: string) {
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
    expiry: "2026-08-28T18:00:00.000Z",
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
    entry: 2000,
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
      approvalRequestId: "req-trading-1",
      requestedQuantity: null,
      evaluationRunId: "eval-1",
      runtimeThreadId: THREAD,
      runtimeTurnId: TURN,
    },
  };
}

const EXEC_RUN = "run-1";

function decision(direction: DecisionDirection, stop?: number, targets: number[] = [4648]) {
  return parseDecision({
    schemaVersion: 1,
    id: "dec-1",
    agentRunId: EXEC_RUN,
    environment: "PAPER",
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
    expiry: "2026-08-28T18:00:00.000Z",
    evidenceQuality: "insufficient",
    versionManifestId: "ver-1",
  });
}

function intent(direction: OrderIntentDirection, entry: number, stop?: number, targets: number[] = [4648]) {
  return parseOrderIntent({
    schemaVersion: 1,
    kind: "order-intent",
    id: "intent-1",
    agentRunId: EXEC_RUN,
    environment: "PAPER",
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

function autonomy(level: AutonomyLevel) {
  return parseAutonomyState({
    schemaVersion: 1,
    environment: "PAPER",
    level,
    name: AUTONOMY_NAMES[level],
    agentRunId: EXEC_RUN,
    updatedAt: AT,
  });
}

function kill(engaged: boolean, environment: TradingEnvironment = "PAPER", agentRunId = EXEC_RUN): KillSwitchState {
  return parseKillSwitchState({
    schemaVersion: 1,
    environment,
    engaged,
    agentRunId,
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
    agentRunId: EXEC_RUN,
    autonomy: autonomy(4),
    permissions: ["decision.propose", "intent.propose"],
    approval: "absent",
    killSwitch: kill(false),
    requestedQuantity: 0.12,
    ...overrides,
  };
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

function prepared() {
  const input = proposal();
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
    agentRunId: EXEC_RUN,
    approvalRequestId: "req-1",
    requestedQuantity: input.requestedQuantity ?? null,
    evaluationRunId: "eval-1",
    runtimeThreadId: THREAD,
    runtimeTurnId: TURN,
  });
  const dir = tempDir();
  const store = openTradingStore({ path: join(dir, "trading.db"), environment: "PAPER" });
  store.killSwitches.write(parseKillSwitchState(input.killSwitch));
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
    agentRunId: EXEC_RUN,
    evaluationRunId: "eval-1",
    runtimeThreadId: THREAD,
    runtimeTurnId: TURN,
  };
  return { input, risk: evaluated.risk, policy: evaluated.policy, approval, gate: evaluateFireTimeGate(gateInput), gateInput, store };
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
    killSwitch: extra.killSwitch ?? ready.input.killSwitch,
    environment: ready.input.environment,
    provenance: ready.input.provenance,
    requestedQuantity: ready.input.requestedQuantity ?? null,
    provider: broker,
    ledger,
    submittedAt: AT,
    agentRunId: EXEC_RUN,
    evaluationRunId: "eval-1",
    runtimeThreadId: THREAD,
    runtimeTurnId: TURN,
    killSwitches: ready.store.killSwitches,
  };
}
