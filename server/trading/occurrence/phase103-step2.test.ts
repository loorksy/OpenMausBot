import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { XauUsdRoutineMarker } from "../../../shared/trading/routine-marker.ts";
import { createXauUsdToolSession } from "../agent/session.ts";
import { OpenAICompatDriver } from "../../drivers/openai-compat.ts";
import { createDeterministicXauUsdProvider } from "../infrastructure/market_data/provider.ts";
import type { RuntimeEvent } from "../../contracts.ts";
import { RoutineManager, type RoutineRunOn, type RoutineRunTrigger } from "../../routines.ts";
import { requireSingleCorrelation } from "../persistence/occurrences.ts";
import { openTradingStore } from "../persistence/store.ts";
import { routineAgentRunId, routineOccurrenceId } from "./identity.ts";
import {
  XAUUSD_CHAT_DRIVER_KINDS,
  assertXauUsdRuntimeGrant,
  bindXauUsdProviderTurn,
  dispatchXauUsdRoutineTurn,
  installXauUsdMarketDataProvider,
  markedRoutineForTurn,
  readInstalledXauUsdMarketDataProvider,
  startNativeRoutineTurn,
  xauUsdRoutineTurnIsPending,
  type XauUsdRoutineDispatch,
} from "./runtime.ts";

const dirs: string[] = [];
afterEach(() => {
  installXauUsdMarketDataProvider(null);
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "xauusd-runtime-"));
  dirs.push(dir);
  return dir;
}

const startedAt = "2026-08-28T10:00:00.000Z";
const routineRunId = "22222222-2222-4222-8222-222222222222";
const threadId = "thread-from-store";
const marker: XauUsdRoutineMarker = {
  environment: "PAPER",
  autonomyLevel: 4,
  permissions: ["market.read", "decision.propose", "intent.propose", "specialist.consult"],
};

function paperProvider() {
  return createDeterministicXauUsdProvider({
    providerId: "explicit-paper-feed",
    environment: "PAPER",
    successProvenance: "LIVE",
  });
}

function configuredEnv(dir: string, environment = "PAPER") {
  return {
    OMB_XAUUSD_STORE_PATH: join(dir, "trading.db"),
    OMB_XAUUSD_ENVIRONMENT: environment,
  };
}

function dispatchInput(overrides: Partial<XauUsdRoutineDispatch> = {}): XauUsdRoutineDispatch {
  return {
    marker,
    routineId: "routine-1",
    routineRunId,
    threadId,
    driverKind: "openai-compat",
    env: configuredEnv(tempDir()),
    marketDataProvider: paperProvider(),
    startedAt,
    startTurn: async () => {},
    ...overrides,
  };
}

const SSE = 'data: {"choices":[{"index":0,"delta":{"content":"No trade."}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n';

describe("XAUUSD routine runtime mount", () => {
  it("keeps an ordinary routine on the native turn when no marker is present", async () => {
    const started: string[] = [];
    await startNativeRoutineTurn({
      active: [{ id: routineRunId, routineId: "routine-1" }],
      markerOf: () => undefined,
      threadId,
      driverKind: "claudeAgent",
      env: configuredEnv(tempDir()),
      marketDataProvider: paperProvider(),
      startedAt,
      startTurn: async () => { started.push("startTurn"); },
    });
    expect(started).toEqual(["startTurn"]);
    expect(bindXauUsdProviderTurn({
      threadId,
      providerTurnId: "provider-turn-9",
      modelProvider: "openai-compat",
      modelId: "fixture-model",
      observedAt: startedAt,
    })).toBeUndefined();
    expect(xauUsdRoutineTurnIsPending(threadId)).toBe(false);
  });

  it("continues the native turn when XAUUSD configuration is absent", async () => {
    const started: string[] = [];
    await dispatchXauUsdRoutineTurn(dispatchInput({
      env: {},
      startTurn: async () => { started.push(threadId); },
    }));
    expect(started).toEqual([threadId]);
    expect(readInstalledXauUsdMarketDataProvider()).toBeNull();
    expect(bindXauUsdProviderTurn({
      threadId,
      providerTurnId: "provider-turn-9",
      modelProvider: "openai-compat",
      modelId: "fixture-model",
      observedAt: startedAt,
    })).toBeUndefined();
  });

  it("fails closed for partial, invalid, and mismatched configuration", async () => {
    const started = vi.fn(async () => {});
    const pathOnly = dispatchInput({
      env: { OMB_XAUUSD_STORE_PATH: join(tempDir(), "trading.db") },
      startTurn: started,
    });
    await expect(dispatchXauUsdRoutineTurn(pathOnly)).rejects.toMatchObject({ code: "trading_store_rejected" });
    await expect(dispatchXauUsdRoutineTurn(dispatchInput({
      env: { OMB_XAUUSD_ENVIRONMENT: "PAPER" },
      startTurn: started,
    }))).rejects.toMatchObject({ code: "trading_store_rejected" });
    await expect(dispatchXauUsdRoutineTurn(dispatchInput({
      env: configuredEnv(tempDir(), "DEMO"),
      startTurn: started,
    }))).rejects.toMatchObject({ code: "environment_rejected" });
    await expect(dispatchXauUsdRoutineTurn(dispatchInput({
      marker: { ...marker, environment: "LIVE" },
      startTurn: started,
    }))).rejects.toMatchObject({ code: "environment_isolation" });
    await expect(dispatchXauUsdRoutineTurn(dispatchInput({
      env: configuredEnv(tempDir(), "LIVE"),
      startTurn: started,
    }))).rejects.toMatchObject({ code: "environment_isolation" });
    expect(started).not.toHaveBeenCalled();
  });

  it("fails closed when the market-data provider is missing or is a simulator fallback", async () => {
    const started = vi.fn(async () => {});
    await expect(dispatchXauUsdRoutineTurn(dispatchInput({
      marketDataProvider: null,
      startTurn: started,
    }))).rejects.toMatchObject({ code: "market_data_provider_unavailable" });
    await expect(dispatchXauUsdRoutineTurn(dispatchInput({
      marketDataProvider: createDeterministicXauUsdProvider({
        providerId: "fixture",
        environment: "SIMULATOR",
        successProvenance: "SIMULATOR",
      }),
      startTurn: started,
    }))).rejects.toMatchObject({ code: "environment_isolation" });
    expect(started).not.toHaveBeenCalled();
  });

  it("fails closed for providers that do not use the OpenAI chat runtime", async () => {
    const unsupported = ["claudeAgent", "codex", "pi", "boatAgent", "boxAgent", "grokAgent", "customAcp"];
    for (const driverKind of unsupported) {
      const started = vi.fn(async () => {});
      await expect(dispatchXauUsdRoutineTurn(dispatchInput({ driverKind, startTurn: started }))).rejects.toMatchObject({
        code: "tool_unavailable",
      });
      expect(started).not.toHaveBeenCalled();
    }
    for (const driverKind of XAUUSD_CHAT_DRIVER_KINDS) {
      expect(unsupported).not.toContain(driverKind);
    }
  });

  it("rejects secret fields before a grant or occurrence is stored", async () => {
    const started = vi.fn(async () => {});
    for (const key of ["token", "apiKey", "secret", "password", "accountId", "metaApiToken"]) {
      const provider = paperProvider();
      await expect(dispatchXauUsdRoutineTurn(dispatchInput({
        marketDataProvider: { ...provider, [key]: "hidden" },
        startTurn: started,
      }))).rejects.toMatchObject({ code: "credentials_forbidden" });
    }
    expect(started).not.toHaveBeenCalled();
  });

  it("rejects a missing, ambiguous, or second provider correlation", async () => {
    expect(() => requireSingleCorrelation([])).toThrow(/exactly one/);
    expect(() => requireSingleCorrelation([1, 2])).toThrow(/exactly one/);
    const store = openTradingStore({ path: join(tempDir(), "trading.db"), environment: "PAPER" });
    store.occurrences.insertRoutineOccurrence({
      routineId: "routine-1",
      routineRunId,
      threadId,
      environment: "PAPER",
      startedAt,
    });
    expect(() => store.occurrences.attachProviderTurn({
      routineId: "routine-1",
      routineRunId,
      threadId: "other-thread",
      providerTurnId: "provider-turn-9",
    })).toThrow(/exactly one/);
    const attached = store.occurrences.attachProviderTurn({
      routineId: "routine-1",
      routineRunId,
      threadId,
      providerTurnId: "provider-turn-9",
    });
    expect(attached.providerTurnId).toBe("provider-turn-9");
    expect(store.occurrences.attachProviderTurn({
      routineId: "routine-1",
      routineRunId,
      threadId,
      providerTurnId: "provider-turn-9",
    }).providerTurnId).toBe("provider-turn-9");
    expect(() => store.occurrences.attachProviderTurn({
      routineId: "routine-1",
      routineRunId,
      threadId,
      providerTurnId: "provider-turn-other",
    })).toThrow(/differs/);
    expect(store.occurrences.readByRoutineRun(routineRunId)?.providerTurnId).toBe("provider-turn-9");
    expect(() => store.occurrences.attachProviderTurn({
      routineId: "routine-1",
      routineRunId,
      threadId,
      providerTurnId: "provider-turn-9",
      token: "metaapi-token",
    } as never)).toThrow(/secret|credential/i);
    store.close();
  });
});

describe("native routine to provider turn", () => {
  it("uses the native task and the provider turn id on one occurrence", async () => {
    const dir = tempDir();
    const env = configuredEnv(dir);
    const calls: string[] = [];
    let grant: ReturnType<typeof bindXauUsdProviderTurn>;
    let manager!: RoutineManager;
    manager = new RoutineManager({
      file: join(dir, "routines.json"),
      now: () => Date.parse(startedAt),
      botState: () => "ready",
      goalState: () => "ready",
      createTask: () => {
        calls.push("createTask");
        return { threadId };
      },
      startTurn: async (
        _botId: string,
        startedThread: string,
        _prompt: string,
        _runOn: RoutineRunOn,
        _triggerSource: RoutineRunTrigger,
      ) => {
        calls.push("startTurn");
        await startNativeRoutineTurn({
          active: manager.listRuns().filter((run) =>
            run.threadId === startedThread && (run.status === "running" || run.status === "waiting")),
          markerOf: (routineId) => manager.listRoutines().find((routine) => routine.id === routineId)?.xauusd,
          threadId: startedThread,
          driverKind: "openai-compat",
          env,
          marketDataProvider: paperProvider(),
          startedAt,
          startTurn: async () => {
            expect(bindXauUsdProviderTurn({
              threadId: "child-thread",
              providerTurnId: "provider-turn-child",
              modelProvider: "openai-compat",
              modelId: "fixture-model",
              observedAt: startedAt,
            })).toBeUndefined();
            grant = bindXauUsdProviderTurn({
              threadId: startedThread,
              providerTurnId: "provider-turn-9",
              modelProvider: "openai-compat",
              modelId: "fixture-model",
              observedAt: startedAt,
            });
            const repeated = bindXauUsdProviderTurn({
              threadId: startedThread,
              providerTurnId: "provider-turn-9",
              modelProvider: "openai-compat",
              modelId: "fixture-model",
              observedAt: startedAt,
            });
            expect(repeated?.correlation.runtimeTurnId).toBe("provider-turn-9");
            expect(() => bindXauUsdProviderTurn({
              threadId: startedThread,
              providerTurnId: "",
              modelProvider: "openai-compat",
              modelId: "fixture-model",
              observedAt: startedAt,
            })).toThrow(/provider turn id/i);
            expect(() => bindXauUsdProviderTurn({
              threadId: startedThread,
              providerTurnId: "provider-turn-other",
              modelProvider: "openai-compat",
              modelId: "fixture-model",
              observedAt: startedAt,
            })).toThrow(/differs/);
            calls.push("provider");
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
      if (!calls.includes("provider")) throw new Error("provider turn was not reached");
    });
    expect(calls).toEqual(["createTask", "startTurn", "provider"]);
    const run = manager.listRuns().find((candidate) => candidate.routineId === routine.id);
    expect(run?.threadId).toBe(threadId);
    expect(grant?.agentRunId).toBe(routineAgentRunId(run!.id));
    expect(grant?.environment).toBe("PAPER");
    expect(grant?.autonomyLevel).toBe(4);
    expect(grant?.permissions).toEqual([...marker.permissions]);
    expect(grant?.correlation.runtimeThreadId).toBe(threadId);
    expect(grant?.correlation.runtimeTurnId).toBe("provider-turn-9");
    expect(grant?.correlation.routineId).toBe(routine.id);
    expect(grant?.correlation.routineRunId).toBe(run!.id);
    expect(grant?.correlation.occurrenceId).toBe(routineOccurrenceId(run!.id));
    expect(grant?.agentRunId).not.toBe(grant?.correlation.runtimeTurnId);
    expect(grant?.agentRunId).not.toBe(threadId);
    expect(grant?.agentRunId).not.toBe(run!.id);
    expect(() => assertXauUsdRuntimeGrant({ ...grant!, token: "metaapi-token" } as never)).toThrow(/secret|credential/i);
    const session = createXauUsdToolSession(grant!);
    expect(session.executionAuthority).toBe(false);
    expect(session.definitions.map((definition) => definition.function.name)).not.toContain("place_order");
    await session.close();
    const stored = openTradingStore({ path: env.OMB_XAUUSD_STORE_PATH, environment: "PAPER" });
    const row = stored.occurrences.readByRoutineRun(run!.id);
    expect(row?.providerTurnId).toBe("provider-turn-9");
    expect(row?.threadId).toBe(threadId);
    expect(row?.agentRunId).toBe(grant?.agentRunId);
    expect(row?.domainStatus).toBe("turn_not_started");
    stored.close();
    expect(bindXauUsdProviderTurn({
      threadId,
      providerTurnId: "provider-turn-later",
      modelProvider: "openai-compat",
      modelId: "fixture-model",
      observedAt: startedAt,
    })).toBeUndefined();
    expect(() => markedRoutineForTurn(
      [{ id: "run-a", routineId: "routine-a" }, { id: "run-b", routineId: "routine-b" }],
      () => marker,
    )).toThrow(/ambiguous/);
  });

  it("leaves an ordinary routine unmarked", async () => {
    const dir = tempDir();
    const calls: string[] = [];
    let manager!: RoutineManager;
    manager = new RoutineManager({
      file: join(dir, "routines.json"),
      now: () => Date.parse(startedAt),
      botState: () => "ready",
      goalState: () => "ready",
      createTask: () => {
        calls.push("createTask");
        return { threadId: "ordinary-thread" };
      },
      startTurn: async (_botId, startedThread) => {
        calls.push("startTurn");
        await startNativeRoutineTurn({
          active: manager.listRuns().filter((run) =>
            run.threadId === startedThread && (run.status === "running" || run.status === "waiting")),
          markerOf: (routineId) => manager.listRoutines().find((routine) => routine.id === routineId)?.xauusd,
          threadId: startedThread,
          driverKind: "openai-compat",
          env: configuredEnv(dir),
          marketDataProvider: paperProvider(),
          startedAt,
          startTurn: async () => { calls.push("provider"); },
        });
      },
    });
    const routine = manager.create({
      name: "Digest",
      prompt: "Summarize the queue.",
      botId: "bot-a",
      schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
    });
    manager.runNow(routine.id);
    await vi.waitFor(() => {
      if (!calls.includes("provider")) throw new Error("ordinary turn was not reached");
    });
    expect(calls).toEqual(["createTask", "startTurn", "provider"]);
    expect(existsSync(join(dir, "trading.db"))).toBe(false);
    expect(manager.listRoutines()[0]?.xauusd).toBeUndefined();
  });
});

describe("OpenAI chat runtime correlation", () => {
  it("mounts XAUUSD tools with the provider turn id and leaves a later turn unmarked", async () => {
    const dir = tempDir();
    const env = configuredEnv(dir);
    const toolCalls: string[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { tools?: Array<{ function: { name: string } }> };
      toolCalls.push((body.tools ?? []).map((tool) => tool.function.name));
      return new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
    }));
    const instance = await OpenAICompatDriver.create({
      instanceId: "openai",
      displayName: "OpenAI",
      enabled: true,
      config: OpenAICompatDriver.decodeConfig({
        url: "https://api.example.test/v1",
        apiKeyEnv: "MINIMAX_API_KEY",
        model: "fixture-model",
      }),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const events: RuntimeEvent[] = [];
    instance.adapter.onEvent((event) => events.push(event));
    try {
      await dispatchXauUsdRoutineTurn(dispatchInput({
        env,
        marketDataProvider: paperProvider(),
        startTurn: async () => {
          await instance.adapter.sendTurn({ threadId, text: "Review XAUUSD.", model: "fixture-model" });
          await vi.waitFor(() => {
            if (!events.some((event) => event.type === "turn.completed")) throw new Error("turn still running");
          });
        },
      }));
      const started = events.find((event) => event.type === "turn.started");
      expect(started?.turnId).toBeTruthy();
      expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
      expect(toolCalls[0]).toEqual(expect.arrayContaining([
        "list_xauusd_tools",
        "get_xauusd_quote",
        "get_xauusd_candles",
        "propose_decision",
        "propose_order_intent",
      ]));
      for (const banned of ["place_order", "submit_order", "execute_trade", "consult_specialist", "get_xauusd_observation"]) {
        expect(toolCalls[0]).not.toContain(banned);
      }
      const stored = openTradingStore({ path: env.OMB_XAUUSD_STORE_PATH, environment: "PAPER" });
      const row = stored.occurrences.readByRoutineRun(routineRunId);
      expect(row?.providerTurnId).toBe(started?.turnId);
      expect(row?.providerTurnId).not.toBe(row?.agentRunId);
      expect(row?.threadId).toBe(threadId);
      stored.close();

      events.length = 0;
      await instance.adapter.sendTurn({ threadId: "ordinary-thread", text: "Hello.", model: "fixture-model" });
      await vi.waitFor(() => {
        if (!events.some((event) => event.type === "turn.completed")) throw new Error("ordinary turn still running");
      });
      expect(toolCalls[1]?.some((name) => name.includes("xauusd"))).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    } finally {
      await instance.dispose();
    }
  });

  it("does not mount XAUUSD tools when the chat runtime has tools disabled", async () => {
    const dir = tempDir();
    const env = configuredEnv(dir);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const instance = await OpenAICompatDriver.create({
      instanceId: "openai",
      displayName: "OpenAI",
      enabled: true,
      config: OpenAICompatDriver.decodeConfig({
        url: "https://api.example.test/v1",
        apiKeyEnv: "MINIMAX_API_KEY",
        model: "fixture-model",
        tools: false,
      }),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    try {
      await expect(dispatchXauUsdRoutineTurn(dispatchInput({
        env,
        marketDataProvider: paperProvider(),
        startTurn: () => instance.adapter.sendTurn({ threadId, text: "Review XAUUSD.", model: "fixture-model" }),
      }))).rejects.toMatchObject({ code: "tool_unavailable" });
      const stored = openTradingStore({ path: env.OMB_XAUUSD_STORE_PATH, environment: "PAPER" });
      expect(stored.occurrences.readByRoutineRun(routineRunId)?.providerTurnId).toBeNull();
      stored.close();
    } finally {
      await instance.dispose();
    }
  });
});

describe("step 2 static boundary", () => {
  it("does not mint provider turns or mount XAUUSD from unsupported drivers", () => {
    const runtime = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8");
    for (const banned of ["newId(", "Math.random", "Date.now", "createDeterministicXauUsdProvider", "setInterval", "setTimeout", "MetaApi", "place_order", "submit_order"]) {
      expect(runtime).not.toContain(banned);
    }
    for (const file of ["claude.ts", "codex.ts", "pi.ts", "boatagent.ts", "acp/core.ts"]) {
      expect(readFileSync(join(import.meta.dirname, "../../drivers", file), "utf8")).not.toContain("bindXauUsdProviderTurn");
    }
    expect(markedRoutineForTurn([], () => marker)).toBeUndefined();
  });
});
