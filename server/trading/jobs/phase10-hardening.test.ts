import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseAutonomyState, type AutonomyLevel } from "../../../shared/trading/autonomy.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { parseKillSwitchState } from "../../../shared/trading/kill-switch.ts";
import { openTradingStore, type TradingStore } from "../persistence/store.ts";
import { dispatchDueJobs, holdForApproval, noteReconciliation, plannedWake, rememberJob, cancelJob } from "./dispatch.ts";
import { authorizeJobExecution } from "./gate.ts";
import { interpretMonitoringRequest, type XauUsdJobRequestContext } from "./interpret.ts";
import { readXauUsdJobMount, XAUUSD_ENVIRONMENT_ENV, XAUUSD_STORE_PATH_ENV } from "./mount.ts";
import { XAUUSD_WAKE_LEASE_MS } from "./model.ts";
import type { XauUsdTurnRequest, XauUsdTurnStarter } from "./dispatch.ts";

const AT = "2026-08-15T14:30:00.000Z";
const RUN = "run-1";
const THREAD = "thread-1";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(): TradingStore {
  const dir = mkdtempSync(join(tmpdir(), "xauusd-lease-"));
  dirs.push(dir);
  return openTradingStore({ path: join(dir, "trading.db"), environment: "PAPER" });
}

function context(text: string, level: AutonomyLevel = 0): XauUsdJobRequestContext {
  return {
    text,
    environment: "PAPER",
    autonomy: parseAutonomyState({
      schemaVersion: 1,
      environment: "PAPER",
      level,
      name: ["OBSERVE", "ANALYZE", "RECOMMEND", "REQUIRE_APPROVAL", "EXECUTE_UNDER_POLICY", "AUTONOMOUS_MONITORING"][level],
      agentRunId: RUN,
      updatedAt: AT,
    }),
    permissions: ["market.read"],
    agentRunId: RUN,
    runtimeThreadId: THREAD,
    taskId: "task-1",
    requestedAt: AT,
  };
}

function minutesLater(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60 * 1000).toISOString();
}

function hoursLater(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 60 * 60 * 1000).toISOString();
}

async function dispatch(saved: TradingStore, now: string, turns: XauUsdTurnStarter) {
  const started: XauUsdTurnRequest[] = [];
  const result = await dispatchDueJobs(saved.jobs.listJobs(), saved.jobs, {
    startTurn: async (request) => {
      started.push(request);
      return turns.startTurn(request);
    },
    turnIsActive: turns.turnIsActive?.bind(turns),
  }, now);
  return { ...result, started };
}

function accepting(): XauUsdTurnStarter {
  return {
    startTurn: async (request) => ({ runtimeTurnId: request.runtimeTurnId }),
  };
}

describe("phase 10.1 durability", () => {
  it("requires an explicit path and environment and does not create a database", () => {
    expect(readXauUsdJobMount({})).toEqual({ mounted: false });
    const missing = join(tmpdir(), "xauusd-mount-absent", "trading.db");
    expect(existsSync(missing)).toBe(false);
    expect(() => readXauUsdJobMount({ [XAUUSD_STORE_PATH_ENV]: missing })).toThrow(TradingDomainError);
    expect(existsSync(missing)).toBe(false);
    expect(() => readXauUsdJobMount({ [XAUUSD_ENVIRONMENT_ENV]: "PAPER" })).toThrow(TradingDomainError);
    expect(() => readXauUsdJobMount({
      [XAUUSD_STORE_PATH_ENV]: missing,
      [XAUUSD_ENVIRONMENT_ENV]: "LIVEISH",
    })).toThrow(TradingDomainError);
    expect(existsSync(missing)).toBe(false);
    const mount = readXauUsdJobMount({
      [XAUUSD_STORE_PATH_ENV]: missing,
      [XAUUSD_ENVIRONMENT_ENV]: "PAPER",
    });
    expect(mount).toEqual({ mounted: true, path: missing, environment: "PAPER" });
    expect(existsSync(missing)).toBe(false);
    expect(() => openTradingStore()).toThrow(TradingDomainError);
    const source = readFileSync(join(import.meta.dirname, "mount.ts"), "utf8");
    expect(source).not.toContain("DATA_DIR");
    expect(source).not.toContain("homedir");
    expect(source).not.toContain(".openmausbot");
    const index = readFileSync(join(import.meta.dirname, "../../index.ts"), "utf8");
    expect(index.match(/new RoutineManager\(/g)).toEqual(["new RoutineManager("]);
    expect(index).not.toContain("openTradingStore");
    expect(index).not.toContain("dispatchDueJobs");
    expect(index).not.toContain(XAUUSD_STORE_PATH_ENV);
  });

  it("keeps a deterministic wake id and reclaims an abandoned claim once", async () => {
    const saved = store();
    const job = rememberJob(saved.jobs, interpretMonitoringRequest(context("watch XAUUSD every 15 minutes for 24 hours"))).job;
    const first = plannedWake(job, AT, AT);
    const same = plannedWake(job, AT, minutesLater(AT, 5));
    expect(same.wakeId).toBe(first.wakeId);
    expect(same.runtimeTurnId).toBe(first.runtimeTurnId);
    expect(first.wakeId).not.toContain("-");
    expect(plannedWake(job, minutesLater(AT, 15), AT).wakeId).not.toBe(first.wakeId);
    expect(saved.jobs.claimWake(first, AT)).toEqual({ claimed: true, reclaimed: false });
    expect(XAUUSD_WAKE_LEASE_MS).toBe(2 * 60 * 1000);
    const early = await dispatch(saved, minutesLater(AT, 1), accepting());
    expect(early.started).toHaveLength(0);
    const recovered = await dispatch(saved, minutesLater(AT, 3), accepting());
    expect(recovered.started).toHaveLength(1);
    expect(recovered.started[0]?.wakeId).toBe(first.wakeId);
    expect(recovered.started[0]?.runtimeTurnId).toBe(first.runtimeTurnId);
    const duplicate = await dispatch(saved, minutesLater(AT, 3), accepting());
    expect(duplicate.started).toHaveLength(0);
    expect(saved.jobs.readWakes(job.jobId)).toHaveLength(1);
    expect(saved.jobs.readWakes(job.jobId)[0]?.status).toBe("completed");
    saved.close();
  });

  it("does not start a second turn after dispatch, and defers a later slot while that turn is active", async () => {
    const saved = store();
    const job = rememberJob(saved.jobs, interpretMonitoringRequest(context("watch XAUUSD every 15 minutes for 24 hours"))).job;
    const active = new Set<string>();
    let calls = 0;
    const turns: XauUsdTurnStarter = {
      startTurn: async (request) => {
        calls += 1;
        active.add(request.runtimeTurnId);
        return { runtimeTurnId: request.runtimeTurnId };
      },
      turnIsActive: (runtimeTurnId) => active.has(runtimeTurnId),
    };
    const started = await dispatch(saved, AT, turns);
    expect(calls).toBe(1);
    expect(saved.jobs.readJob(job.jobId)?.status).toBe("RUNNING");
    expect(saved.jobs.readWakes(job.jobId)[0]?.status).toBe("dispatched");
    const overlapped = await dispatch(saved, minutesLater(AT, 15), turns);
    expect(calls).toBe(1);
    expect(overlapped.started).toHaveLength(0);
    expect(overlapped.events.some((event) => event.type === "job.wake.deferred")).toBe(true);
    expect(saved.jobs.readWakes(job.jobId)).toHaveLength(1);
    active.clear();
    const crashed = await dispatch(saved, AT, turns);
    expect(calls).toBe(1);
    expect(crashed.started).toHaveLength(0);
    expect(saved.jobs.readWakes(job.jobId)[0]?.status).toBe("interrupted");
    const next = await dispatch(saved, minutesLater(AT, 30), accepting());
    expect(next.started).toHaveLength(1);
    expect(next.started[0]?.runtimeTurnId).not.toBe(started.started[0]?.runtimeTurnId);
    expect(saved.jobs.readJob(job.jobId)?.status).toBe("SLEEPING");
    saved.close();
  });

  it("does not wake a cancelled, completed, or approval-held job, and does not hand off an unsafe execution", async () => {
    const saved = store();
    const cancelled = rememberJob(saved.jobs, interpretMonitoringRequest(context("watch XAUUSD for 6 hours", 4))).job;
    cancelJob(saved.jobs, cancelled, AT);
    expect((await dispatch(saved, AT, accepting())).started).toHaveLength(0);
    const ending = rememberJob(saved.jobs, interpretMonitoringRequest(context("watch gold for 1 hour", 0))).job;
    const done = await dispatch(saved, hoursLater(AT, 2), accepting());
    expect(done.started).toHaveLength(0);
    expect(saved.jobs.readJob(ending.jobId)?.status).toBe("COMPLETED");
    const heldJob = rememberJob(saved.jobs, interpretMonitoringRequest(context("watch XAUUSD for 24 hours", 3))).job;
    const held = holdForApproval(saved.jobs, heldJob, {
      approvalId: "apr-1",
      proposalBinding: "bind-1",
      entry: 4632.5,
      stop: 4624.5,
      quantity: 0.2,
      environment: "PAPER",
      expiresAt: hoursLater(AT, 1),
    }, AT);
    expect((await dispatch(saved, minutesLater(AT, 15), accepting())).started).toHaveLength(0);
    expect(saved.jobs.readJob(held.jobId)?.status).toBe("WAITING_FOR_APPROVAL");
    const level4 = interpretMonitoringRequest(context("watch XAUUSD for 1 hour", 4));
    expect(authorizeJobExecution(level4, facts({ executionState: "SUBMISSION_UNKNOWN" })).reason).toBe("execution_unresolved");
    expect(authorizeJobExecution(level4, facts({ reconciliationState: "UNKNOWN" })).reason).toBe("reconciliation");
    expect(authorizeJobExecution(level4, facts({ reconciliationState: "DESYNCED" })).reason).toBe("reconciliation");
    noteReconciliation(saved.jobs, saved.jobs.readJob(held.jobId)!, "DESYNCED", "SUBMISSION_UNKNOWN", AT);
    const restored = saved.jobs.readJob(held.jobId)!;
    expect(restored.executionState).toBe("SUBMISSION_UNKNOWN");
    expect(restored.reconciliationState).toBe("DESYNCED");
    expect(authorizeJobExecution(restored, facts()).handoff).toBe("none");
    const engaged = parseKillSwitchState({
      schemaVersion: 1,
      environment: "PAPER",
      engaged: true,
      agentRunId: RUN,
      updatedAt: AT,
      source: "operator",
    });
    const before = JSON.stringify(engaged);
    expect(authorizeJobExecution(level4, facts({ killSwitch: engaged })).reason).toBe("kill_switch");
    expect(JSON.stringify(engaged)).toBe(before);
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
