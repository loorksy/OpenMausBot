import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { recordIdSchema } from "../../../shared/trading/ids.ts";
import { parseXauUsdRoutineMarker } from "../../../shared/trading/routine-marker.ts";
import { RoutineManager, type RoutineRunOn, type RoutineRunTrigger } from "../../routines.ts";
import {
  parseOccurrenceDomainStatus,
  routineAgentRunId,
  routineOccurrenceId,
} from "./identity.ts";
import { TRADING_STORE_SCHEMA_SQL } from "../persistence/schema.ts";
import { openTradingStore } from "../persistence/store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "xauusd-occurrence-"));
  dirs.push(dir);
  return dir;
}

const marker = {
  environment: "PAPER" as const,
  autonomyLevel: 5 as const,
  permissions: ["market.read", "intent.propose"] as const,
};

function manager(file: string) {
  return new RoutineManager({
    file,
    now: () => Date.parse("2026-08-28T10:00:00Z"),
    botState: () => "ready",
    goalState: () => "ready",
    createTask: () => ({ threadId: "thread-from-store" }),
    startTurn: async (
      _botId: string,
      _threadId: string,
      _prompt: string,
      _runOn: RoutineRunOn,
      _triggerSource: RoutineRunTrigger,
      _onDispatchError: (message: string) => void,
    ) => {},
  });
}

describe("XAUUSD routine marker", () => {
  it("accepts SIMULATOR, PAPER, and LIVE at the autonomy bounds", () => {
    expect(parseXauUsdRoutineMarker({
      environment: "SIMULATOR",
      autonomyLevel: 0,
      permissions: ["market.read", "decision.propose", "intent.propose", "specialist.consult"],
    })).toMatchObject({ environment: "SIMULATOR", autonomyLevel: 0 });
    expect(parseXauUsdRoutineMarker(marker)).toMatchObject({ environment: "PAPER", autonomyLevel: 5 });
    expect(parseXauUsdRoutineMarker({ ...marker, environment: "LIVE", autonomyLevel: 0 })).toMatchObject({
      environment: "LIVE",
      autonomyLevel: 0,
    });
  });

  it("rejects unknown permissions, bad environments, bad autonomy, and secret fields", () => {
    expect(() => parseXauUsdRoutineMarker({ ...marker, permissions: ["execute"] })).toThrow(TradingDomainError);
    expect(() => parseXauUsdRoutineMarker({ ...marker, permissions: ["trade.execute"] })).toThrow(/unknown trading permission/);
    expect(() => parseXauUsdRoutineMarker({ ...marker, permissions: ["broker.execute"] })).toThrow(/unknown trading permission/);
    expect(() => parseXauUsdRoutineMarker({ ...marker, permissions: ["order.submit"] })).toThrow(/unknown trading permission/);
    expect(() => parseXauUsdRoutineMarker({ ...marker, permissions: ["metaapi"] })).toThrow(/unknown trading permission/);
    expect(() => parseXauUsdRoutineMarker({ ...marker, permissions: ["admin"] })).toThrow(/unknown trading permission/);
    expect(() => parseXauUsdRoutineMarker({ ...marker, environment: "DEMO" })).toThrow(/environment_rejected|SIMULATOR, PAPER, or LIVE/);
    try {
      parseXauUsdRoutineMarker({ ...marker, environment: "DEMO" });
    } catch (error) {
      expect(error).toMatchObject({ code: "environment_rejected" });
    }
    expect(() => parseXauUsdRoutineMarker({ ...marker, autonomyLevel: 6 })).toThrow(/autonomy/);
    expect(() => parseXauUsdRoutineMarker({ ...marker, autonomyLevel: -1 })).toThrow(/autonomy/);
    expect(() => parseXauUsdRoutineMarker({ ...marker, autonomyLevel: "5" })).toThrow(/autonomy/);
    for (const secret of ["token", "apiKey", "api_key", "secret", "password", "authorization", "accountId", "account_id", "brokerToken", "metaApiToken", "account"]) {
      expect(() => parseXauUsdRoutineMarker({ ...marker, [secret]: "hidden" })).toThrow(/secret|credential/i);
    }
    expect(() => parseXauUsdRoutineMarker({ ...marker, symbol: "EURUSD" })).toThrow(/instrument/);
  });
});

describe("routine marker persistence", () => {
  it("keeps a valid marker across save and load and leaves ordinary routines ordinary", () => {
    const file = join(tempDir(), "routines.json");
    const first = manager(file);
    const ordinary = first.create({
      name: "Digest",
      prompt: "Summarize the queue.",
      botId: "bot-a",
      schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
    });
    const marked = first.create({
      name: "Gold watch",
      prompt: "Review XAUUSD.",
      botId: "bot-a",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
      xauusd: marker,
    });
    expect(ordinary.xauusd).toBeUndefined();
    expect(marked.xauusd).toEqual(marker);
    const reloaded = manager(file);
    const restored = reloaded.listRoutines().find((routine) => routine.id === marked.id);
    const plain = reloaded.listRoutines().find((routine) => routine.id === ordinary.id);
    expect(restored?.xauusd).toEqual(marker);
    expect(plain?.xauusd).toBeUndefined();
    reloaded.update(marked.id, { name: "Gold watch renamed" });
    expect(manager(file).listRoutines().find((routine) => routine.id === marked.id)?.xauusd).toEqual(marker);
  });

  it("does not schedule a malformed marker and does not rewrite the file while loading", () => {
    const file = join(tempDir(), "routines.json");
    const created = manager(file).create({
      name: "Digest",
      prompt: "Summarize the queue.",
      botId: "bot-a",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });
    const disk = JSON.parse(readFileSync(file, "utf8")) as { routines: Array<Record<string, unknown>> };
    disk.routines.push({
      ...disk.routines[0],
      id: "bad-routine",
      name: "Bad",
      xauusd: { ...marker, token: "metaapi-token" },
    });
    writeFileSync(file, JSON.stringify(disk));
    const before = readFileSync(file, "utf8");
    const loaded = manager(file);
    expect(loaded.listRoutines().map((routine) => routine.id)).toEqual([created.id]);
    expect(JSON.stringify(loaded.listRoutines())).not.toContain("metaapi-token");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses a room goal that declares XAUUSD", () => {
    const routines = manager(join(tempDir(), "routines.json"));
    expect(() => routines.create({
      name: "Room gold",
      prompt: "Review XAUUSD.",
      botId: "bot-a",
      target: "room-goal",
      groupId: "room-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
      xauusd: marker,
    })).toThrow(/Room goals cannot declare an XAUUSD routine/);
    expect(routines.listRoutines()).toHaveLength(0);
  });
});

describe("trading occurrence identity", () => {
  const routineRunId = "11111111-1111-4111-8111-111111111111";
  const threadId = "thread-from-store";

  it("derives a stable occurrence id and a distinct agent run id", () => {
    const occurrenceId = routineOccurrenceId(routineRunId);
    const agentRunId = routineAgentRunId(routineRunId);
    expect(occurrenceId).toBe(routineOccurrenceId(routineRunId));
    expect(agentRunId).toBe(routineAgentRunId(routineRunId));
    expect(occurrenceId).toMatch(/^occ\.[a-f0-9]{40}$/);
    expect(agentRunId).toMatch(/^run\.[a-f0-9]{40}$/);
    expect(recordIdSchema.safeParse(occurrenceId).success).toBe(true);
    expect(recordIdSchema.safeParse(agentRunId).success).toBe(true);
    expect(occurrenceId).not.toBe(routineRunId);
    expect(agentRunId).not.toBe(routineRunId);
    expect(agentRunId).not.toBe(threadId);
    expect(agentRunId).not.toBe(occurrenceId);
    expect(parseOccurrenceDomainStatus("turn_not_started")).toBe("turn_not_started");
    expect(parseOccurrenceDomainStatus("no_trade")).toBe("no_trade");
    expect(parseOccurrenceDomainStatus("desynced")).toBe("desynced");
    expect(() => parseOccurrenceDomainStatus("EXECUTING")).toThrow(TradingDomainError);
    expect(() => parseOccurrenceDomainStatus("FILLED")).toThrow(TradingDomainError);
  });
});

describe("trading occurrence store", () => {
  const startedAt = "2026-08-28T10:00:00Z";
  const routineRunId = "22222222-2222-4222-8222-222222222222";

  it("inserts a nullable provider turn id and rejects a second row for the same run", () => {
    const store = openTradingStore({ path: join(tempDir(), "trading.db"), environment: "PAPER" });
    const row = store.occurrences.insertRoutineOccurrence({
      routineId: "routine-1",
      routineRunId,
      threadId: "thread-from-store",
      environment: "PAPER",
      startedAt,
    });
    expect(row.providerTurnId).toBeNull();
    expect(row.instrument).toBe("XAUUSD");
    expect(row.environment).toBe("PAPER");
    expect(row.domainStatus).toBe("turn_not_started");
    expect(row.routineRunId).toBe(routineRunId);
    expect(row.threadId).toBe("thread-from-store");
    expect(row.agentRunId).toBe(routineAgentRunId(routineRunId));
    expect(row.occurrenceId).toBe(routineOccurrenceId(routineRunId));
    expect(row.approvalId).toBeNull();
    expect(row.provenance).toBeNull();
    expect(row.proposalBindingHash).toBeNull();
    expect(store.occurrences.readByRoutineRun(routineRunId)).toEqual(row);
    expect(() => store.occurrences.insertRoutineOccurrence({
      routineId: "routine-1",
      routineRunId,
      threadId: "thread-from-store",
      environment: "PAPER",
      startedAt,
    })).toThrow(TradingDomainError);
    expect(() => store.occurrences.insertRoutineOccurrence({
      routineId: "routine-1",
      routineRunId: "33333333-3333-4333-8333-333333333333",
      threadId: "thread-from-store",
      environment: "LIVE",
      startedAt,
    })).toThrow(/partition/);
    expect(() => store.occurrences.insertRoutineOccurrence({
      routineId: "routine-1",
      routineRunId: "33333333-3333-4333-8333-333333333333",
      threadId: "thread-from-store",
      environment: "PAPER",
      startedAt,
      token: "metaapi-token",
    } as never)).toThrow(/secret|unsupported field/i);
    store.close();
  });

  it("migrates version 2 to version 3 without dropping job rows and can run twice", () => {
    const path = join(tempDir(), "trading.db");
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE schema_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        environment TEXT NOT NULL,
        partition_key TEXT NOT NULL
      );
      INSERT INTO schema_meta (id, version, environment, partition_key) VALUES (1, 2, 'PAPER', 'xauusd/PAPER');
      CREATE TABLE xauusd_jobs (
        revision_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        status TEXT NOT NULL,
        environment TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE (job_id, sequence)
      );
      INSERT INTO xauusd_jobs (revision_id, job_id, sequence, status, environment, payload_json)
      VALUES ('rev-1', 'job-1', 1, 'SLEEPING', 'PAPER', '{"keep":true}');
      CREATE TABLE xauusd_job_wakes (
        wake_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        status TEXT NOT NULL,
        agent_run_id TEXT NOT NULL,
        runtime_thread_id TEXT NOT NULL,
        runtime_turn_id TEXT,
        payload_json TEXT NOT NULL,
        UNIQUE (job_id, scheduled_for)
      );
      INSERT INTO xauusd_job_wakes (
        wake_id, job_id, scheduled_for, status, agent_run_id, runtime_thread_id, runtime_turn_id, payload_json
      ) VALUES ('wake-1', 'job-1', '2026-08-28T10:00:00Z', 'dispatched', 'run.keep', 'thread-1', 'turn-1', '{"keep":true}');
    `);
    db.close();
    const upgraded = openTradingStore({ path, environment: "PAPER" });
    expect(upgraded.schemaVersion).toBe(6);
    upgraded.close();
    const check = new DatabaseSync(path);
    expect(check.prepare("SELECT version FROM schema_meta WHERE id = 1").get()).toMatchObject({ version: 6 });
    expect(check.prepare("SELECT job_id, payload_json FROM xauusd_jobs").get()).toMatchObject({
      job_id: "job-1",
      payload_json: '{"keep":true}',
    });
    expect(check.prepare("SELECT wake_id FROM xauusd_job_wakes").get()).toMatchObject({ wake_id: "wake-1" });
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trading_occurrences'").get())
      .toMatchObject({ name: "trading_occurrences" });
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trading_approval_transports'").get())
      .toMatchObject({ name: "trading_approval_transports" });
    expect(() => check.prepare(`
      INSERT INTO trading_occurrences (
        occurrence_id, routine_id, routine_run_id, thread_id, agent_run_id, instrument, environment,
        domain_status, started_at
      ) VALUES ('occ.bad', 'routine-1', 'run-1', 'thread-1', 'run.bad', 'EURUSD', 'PAPER', 'turn_not_started', '2026-08-28T10:00:00Z')
    `).run()).toThrow();
    expect(() => check.prepare(`
      INSERT INTO trading_occurrences (
        occurrence_id, routine_id, routine_run_id, thread_id, agent_run_id, instrument, environment,
        domain_status, started_at
      ) VALUES ('occ.bad', 'routine-1', 'run-1', 'thread-1', 'run.bad', 'XAUUSD', 'PAPER', 'FILLED', '2026-08-28T10:00:00Z')
    `).run()).toThrow();
    check.close();
    const again = openTradingStore({ path, environment: "PAPER" });
    expect(again.schemaVersion).toBe(6);
    expect(again.occurrences.readByRoutineRun("run-1")).toBeNull();
    again.close();
    const still = new DatabaseSync(path);
    expect(still.prepare("SELECT job_id FROM xauusd_jobs").get()).toMatchObject({ job_id: "job-1" });
    still.close();
    expect(TRADING_STORE_SCHEMA_SQL).not.toContain("DROP");
    expect(TRADING_STORE_SCHEMA_SQL).not.toContain("DELETE");
    const source = readFileSync(new URL("./identity.ts", import.meta.url), "utf8")
      + readFileSync(new URL("../persistence/occurrences.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/Math\.random|Date\.now|randomUUID|newId\(/);
  });
});
