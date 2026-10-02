import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseAutonomyState, type AutonomyLevel } from "../../../shared/trading/autonomy.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { parseKillSwitchState } from "../../../shared/trading/kill-switch.ts";
import { FORBIDDEN_EXECUTION_TOOL_NAMES, XAUUSD_TOOL_CATALOG } from "../agent/catalog.ts";
import { openTradingStore, type TradingStore } from "../persistence/store.ts";
import { RoutineManager } from "../../routines.ts";
import { dispatchDueJobs, holdForApproval, noteMarketObservation, noteReconciliation, rememberJob, cancelJob, pauseJob } from "./dispatch.ts";
import { authorizeJobExecution } from "./gate.ts";
import { interpretMonitoringRequest, type XauUsdJobRequestContext } from "./interpret.ts";
import { XAUUSD_JOB_MAX_DURATION_MS } from "./model.ts";
import type { XauUsdTurnRequest } from "./dispatch.ts";

const AT = "2026-08-15T14:30:00.000Z";
const RUN = "run-1";
const THREAD = "thread-1";
const TASK = "task-1";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(): TradingStore {
  const dir = mkdtempSync(join(tmpdir(), "xauusd-job-"));
  dirs.push(dir);
  return openTradingStore({ path: join(dir, "trading.db"), environment: "PAPER" });
}

function autonomy(level: AutonomyLevel, environment: "PAPER" | "LIVE" | "SIMULATOR" = "PAPER") {
  return parseAutonomyState({
    schemaVersion: 1,
    environment,
    level,
    name: ["OBSERVE", "ANALYZE", "RECOMMEND", "REQUIRE_APPROVAL", "EXECUTE_UNDER_POLICY", "AUTONOMOUS_MONITORING"][level],
    agentRunId: RUN,
    updatedAt: AT,
  });
}

function context(text: string, level: AutonomyLevel = 0, environment: "PAPER" | "LIVE" | "SIMULATOR" = "PAPER"): XauUsdJobRequestContext {
  return {
    text,
    environment,
    autonomy: autonomy(level, environment),
    permissions: ["market.read"],
    agentRunId: RUN,
    runtimeThreadId: THREAD,
    taskId: TASK,
    requestedAt: AT,
  };
}

function hoursLater(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 60 * 60 * 1000).toISOString();
}

function minutesLater(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60 * 1000).toISOString();
}

async function wake(jobsStore: TradingStore, now: string) {
  const turns: XauUsdTurnRequest[] = [];
  const result = await dispatchDueJobs(jobsStore.jobs.listJobs(), jobsStore.jobs, {
    startTurn: async (request) => {
      turns.push(request);
      return { runtimeTurnId: request.runtimeTurnId };
    },
  }, now);
  jobsStore.ledger.appendEvents?.(result.events);
  return { ...result, turns };
}

describe("xauusd jobs", () => {
  it("turns a natural request into a bounded XAUUSD job", () => {
    const job = interpretMonitoringRequest(context("راقب XAUUSD كل 15 دقيقة خلال الـ24 ساعة القادمة"));
    expect(job.instrument).toBe("XAUUSD");
    expect(job.environment).toBe("PAPER");
    expect(job.durationMs).toBe(XAUUSD_JOB_MAX_DURATION_MS);
    expect(job.endAt).toBe(hoursLater(AT, 24));
    expect(job.everyMinutes).toBe(15);
    expect(job.scheduleSource).toBe("requested");
    expect(job.nextWakeAt).toBe(AT);
    const same = interpretMonitoringRequest(context("راقب الذهب لمدة 24 ساعة"));
    expect(same.instrument).toBe("XAUUSD");
    expect(same.everyMinutes).toBe(15);
    expect(same.scheduleSource).toBe("configured-default");
    expect(() => interpretMonitoringRequest(context("راقب الذهب"))).toThrow(TradingDomainError);
    expect(() => interpretMonitoringRequest(context("راقب الذهب لمدة 48 ساعة"))).toThrow(TradingDomainError);
    expect(() => interpretMonitoringRequest(context("watch live gold for 24 hours", 0, "PAPER"))).toThrow(TradingDomainError);
    const live = interpretMonitoringRequest(context("watch gold for 24 hours", 0, "LIVE"));
    expect(live.environment).toBe("LIVE");
    expect(live.durationMs).toBe(XAUUSD_JOB_MAX_DURATION_MS);
  });

  it("wakes on the interval without a second turn, and isolates another job", async () => {
    const saved = store();
    const first = rememberJob(saved.jobs, interpretMonitoringRequest(context("راقب XAUUSD كل 15 دقيقة خلال الـ24 ساعة القادمة"))).job;
    const second = rememberJob(saved.jobs, interpretMonitoringRequest(context("راقب الذهب لمدة 6 ساعات", 1))).job;
    expect(second.jobId).not.toBe(first.jobId);
    const due = await wake(saved, minutesLater(AT, 45));
    expect(due.turns).toHaveLength(2);
    expect(due.turns.map((turn) => turn.jobId).sort()).toEqual([first.jobId, second.jobId].sort());
    expect(due.turns.every((turn) => turn.runtimeThreadId === THREAD)).toBe(true);
    expect(new Set(due.turns.map((turn) => turn.wakeId)).size).toBe(2);
    const again = await wake(saved, minutesLater(AT, 45));
    expect(again.turns).toHaveLength(0);
    const slot = saved.jobs.readWakes(first.jobId);
    expect(slot).toHaveLength(1);
    expect(slot[0]?.scheduledFor).toBe(minutesLater(AT, 45));
    expect(saved.jobs.readJob(first.jobId)?.status).toBe("SLEEPING");
    expect(saved.jobs.readJob(first.jobId)?.nextWakeAt).toBe(minutesLater(AT, 60));
    expect(due.turns[0]?.prompt).not.toMatch(/RSI|MACD|moving average|place_order|BUY/i);
    saved.close();
  });

  it("recovers a job, approval, and unresolved execution without repeating a wake", async () => {
    const first = store();
    const path = first.path;
    const created = rememberJob(first.jobs, interpretMonitoringRequest(context("راقب XAUUSD كل 15 دقيقة لمدة 24 ساعة", 3))).job;
    holdForApproval(first.jobs, created, {
      approvalId: "apr-1",
      proposalBinding: "bind-1",
      entry: 4632.5,
      stop: 4624.5,
      quantity: 0.2,
      environment: "PAPER",
      expiresAt: hoursLater(AT, 1),
    }, AT);
    noteReconciliation(first.jobs, first.jobs.readJob(created.jobId)!, "UNKNOWN", "SUBMISSION_UNKNOWN", AT);
    first.close();
    const reopened = openTradingStore({ path, environment: "PAPER" });
    const restored = reopened.jobs.readJob(created.jobId);
    expect(restored?.status).toBe("WAITING_FOR_APPROVAL");
    expect(restored?.approval?.proposalBinding).toBe("bind-1");
    expect(restored?.executionState).toBe("SUBMISSION_UNKNOWN");
    expect(restored?.reconciliationState).toBe("UNKNOWN");
    const held = await wake(reopened, minutesLater(AT, 15));
    expect(held.turns).toHaveLength(0);
    const blocked = authorizeJobExecution(restored!, facts());
    expect(blocked.handoff).toBe("none");
    expect(blocked.brokerCall).toBe(false);
    reopened.close();
  });

  it("collapses missed slots, then requires a fresh gate before any handoff", async () => {
    const saved = store();
    const job = rememberJob(saved.jobs, interpretMonitoringRequest(context("watch XAUUSD every 15 minutes for 24 hours"))).job;
    const due = await wake(saved, minutesLater(AT, 45));
    expect(due.turns).toHaveLength(1);
    expect(due.turns[0]?.prompt).toContain("current XAUUSD observation");
    const handoff = authorizeJobExecution(saved.jobs.readJob(job.jobId)!, facts({ gateState: null, provenance: "STALE" }));
    expect(handoff.handoff).toBe("none");
    const fresh = authorizeJobExecution(saved.jobs.readJob(job.jobId)!, facts());
    expect(fresh.handoff).toBe("none");
    saved.close();
  });

  it("keeps approval, kill switch, provenance, and environment constraints", async () => {
    const saved = store();
    const job = rememberJob(saved.jobs, interpretMonitoringRequest(context("راقب الذهب، وإذا ظهر قرار يحتاج موافقتي أرسل طلب موافقة لمدة 24 ساعة", 3))).job;
    const held = holdForApproval(saved.jobs, job, {
      approvalId: "apr-1",
      proposalBinding: "bind-1",
      entry: 4632.5,
      stop: 4624.5,
      quantity: 0.2,
      environment: "PAPER",
      expiresAt: hoursLater(AT, 1),
    }, AT);
    expect(held.status).toBe("WAITING_FOR_APPROVAL");
    expect(held.statusLabel).toBe("Waiting for approval");
    expect(authorizeJobExecution(held, facts()).handoff).toBe("existing-execution-boundary");
    expect(authorizeJobExecution(held, facts()).brokerCall).toBe(false);
    expect(authorizeJobExecution(held, facts({ quantity: 0.1 })).handoff).toBe("none");
    expect(authorizeJobExecution(held, facts({ stop: 4600 })).handoff).toBe("none");
    expect(authorizeJobExecution(held, facts({ entry: 4700 })).handoff).toBe("none");
    expect(authorizeJobExecution(held, facts({ environment: "LIVE" })).handoff).toBe("none");
    expect(authorizeJobExecution(held, facts({ proposalBinding: "bind-2" })).handoff).toBe("none");
    expect(held.environment).toBe("PAPER");
    const expired = await wake(saved, hoursLater(AT, 2));
    expect(expired.turns).toHaveLength(1);
    expect(saved.jobs.readJob(job.jobId)?.status).not.toBe("WAITING_FOR_APPROVAL");
    const engaged = parseKillSwitchState({
      schemaVersion: 1,
      environment: "PAPER",
      engaged: true,
      agentRunId: RUN,
      updatedAt: AT,
      source: "operator",
    });
    const before = JSON.stringify(engaged);
    expect(authorizeJobExecution(job, facts({ killSwitch: engaged })).reason).toBe("kill_switch");
    expect(JSON.stringify(engaged)).toBe(before);
    const observed = noteMarketObservation(saved.jobs, saved.jobs.readJob(job.jobId)!, {
      observationId: "obs-1",
      provenance: "UNAVAILABLE",
    }, AT);
    expect(observed.provenance).toBe("UNAVAILABLE");
    const stale = noteMarketObservation(saved.jobs, observed, { observationId: "obs-2", provenance: "STALE" }, AT);
    expect(stale.provenance).toBe("STALE");
    expect(() => rememberJob(saved.jobs, interpretMonitoringRequest(context("watch XAUUSD for 24 hours", 4, "LIVE")))).toThrow(TradingDomainError);
    saved.close();
  });

  it("does not execute below the gate, and does not wake a finished or cancelled job", async () => {
    const saved = store();
    for (const level of [0, 1, 2] as const) {
      const job = interpretMonitoringRequest(context("watch XAUUSD for 1 hour", level));
      expect(authorizeJobExecution(job, facts()).handoff).toBe("none");
      expect(authorizeJobExecution(job, facts()).brokerCall).toBe(false);
    }
    const level4 = interpretMonitoringRequest(context("watch XAUUSD for 1 hour", 4));
    expect(authorizeJobExecution(level4, facts()).handoff).toBe("existing-execution-boundary");
    expect(authorizeJobExecution(level4, facts({ reconciliationState: "DESYNCED" })).reason).toBe("reconciliation");
    expect(authorizeJobExecution(level4, facts({ executionState: "SUBMISSION_UNKNOWN" })).reason).toBe("execution_unresolved");
    const level5 = interpretMonitoringRequest(context("watch XAUUSD every 15 minutes for 6 hours", 5));
    expect(authorizeJobExecution(level5, facts({ gateState: "BLOCKED" })).handoff).toBe("none");
    expect(authorizeJobExecution(level5, facts()).brokerCall).toBe(false);
    expect(authorizeJobExecution(level4, facts({ provenance: "REPLAY" })).reason).toBe("provenance");
    expect(authorizeJobExecution(level4, facts({ provenance: "STALE" })).reason).toBe("provenance");
    expect(authorizeJobExecution(level4, facts({ provenance: "UNAVAILABLE" })).reason).toBe("provenance");
    expect(authorizeJobExecution(level4, facts({ environment: "LIVE" })).handoff).toBe("none");
    expect(level4.environment).toBe("PAPER");
    const simulator = interpretMonitoringRequest(context("watch XAUUSD for 1 hour", 4, "SIMULATOR"));
    const simulatorSwitch = parseKillSwitchState({
      schemaVersion: 1,
      environment: "SIMULATOR",
      engaged: false,
      agentRunId: RUN,
      updatedAt: AT,
      source: "operator",
    });
    expect(authorizeJobExecution(simulator, facts({
      environment: "SIMULATOR",
      provenance: "LIVE",
      killSwitch: simulatorSwitch,
    })).handoff).toBe("none");
    expect(simulator.environment).toBe("SIMULATOR");
    const running = rememberJob(saved.jobs, level4).job;
    cancelJob(saved.jobs, running, AT);
    expect((await wake(saved, AT)).turns).toHaveLength(0);
    const paused = rememberJob(saved.jobs, interpretMonitoringRequest(context("watch gold for 6 hours", 4))).job;
    pauseJob(saved.jobs, paused, AT);
    expect((await wake(saved, AT)).turns).toHaveLength(0);
    const ending = rememberJob(saved.jobs, interpretMonitoringRequest(context("watch gold for 1 hour", 0))).job;
    const done = await wake(saved, hoursLater(AT, 2));
    expect(done.turns).toHaveLength(0);
    expect(saved.jobs.readJob(ending.jobId)?.status).toBe("COMPLETED");
    expect(saved.jobs.readJob(ending.jobId)?.statusLabel).toBe("Job completed");
    saved.close();
  });

  it("uses the existing routine tick and records a real wake event", async () => {
    const clocks: number[] = [];
    const dir = mkdtempSync(join(tmpdir(), "omb-job-clock-"));
    dirs.push(dir);
    const routines = new RoutineManager({
      file: join(dir, "routines.json"),
      now: () => Date.parse(AT),
      botState: () => "ready",
      createTask: () => ({ threadId: THREAD }),
      startTurn: async () => {},
      onClock: (now) => {
        clocks.push(now);
      },
    });
    await routines.tick();
    expect(clocks).toEqual([Date.parse(AT)]);
    const saved = store();
    const created = rememberJob(saved.jobs, interpretMonitoringRequest(context("watch XAUUSD every 15 minutes for 24 hours"))).job;
    expect(saved.readEvents().map((event) => event.type)).toContain("job.created");
    const result = await wake(saved, AT);
    expect(result.events.map((event) => event.type)).toContain("job.wake.started");
    expect(result.events.map((event) => event.type)).toContain("job.wake.scheduled");
    expect(saved.readEvents().some((event) => event.type === "job.wake.started" && event.runtimeThreadId === THREAD)).toBe(true);
    expect(saved.jobs.readJob(created.jobId)?.statusLabel).toBe("Waiting for next scheduled check");
    expect(result.events.every((event) => event.source === "trading-domain")).toBe(true);
    expect(JSON.stringify(result.events)).not.toContain("thinking");
    const names = XAUUSD_TOOL_CATALOG.map((tool) => tool.name);
    for (const banned of [...FORBIDDEN_EXECUTION_TOOL_NAMES, "execute_trade", "metaapi_execute"]) {
      expect(names).not.toContain(banned);
    }
    saved.close();
  });
});

function facts(overrides: Partial<Parameters<typeof authorizeJobExecution>[1]> = {}) {
  return {
    gateState: "ELIGIBLE_FOR_EXECUTION",
    provenance: "LIVE" as const,
    reconciliationState: "RECONCILED" as const,
    executionState: "SUBMISSION_ACCEPTED" as const,
    killSwitch: parseKillSwitchState({
      schemaVersion: 1,
      environment: "PAPER",
      engaged: false,
      agentRunId: RUN,
      updatedAt: AT,
      source: "operator",
    }),
    proposalBinding: "bind-1",
    entry: 4632.5,
    stop: 4624.5,
    quantity: 0.2,
    environment: "PAPER" as const,
    ...overrides,
  };
}

describe("phase 10 static review", () => {
  it("does not add a second timer, a broker call, or a strategy rule", () => {
    const root = import.meta.dirname;
    const source = readdirSync(root)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => readFileSync(join(root, name), "utf8"))
      .join("\n");
    for (const token of ["while(true)", "while (true)", "setInterval", "setTimeout", "Date.now", "Math.random", "place_order", "submit_order", "execute_trade", "createMetaApiExecutionAdapter"]) {
      expect(source).not.toContain(token);
    }
    expect(source).not.toMatch(/\bRSI\b|\bMACD\b/);
  });
});
