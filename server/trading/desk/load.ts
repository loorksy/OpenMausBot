import type { TradingEvent } from "../../../shared/trading/events.ts";
import { recordIdSchema } from "../../../shared/trading/ids.ts";
import { readXauUsdJobMount } from "../jobs/mount.ts";
import type { PositionLifecycleInput } from "../lifecycle/position.ts";
import { tradingHealthReport } from "../production/health.ts";
import { openTradingStore, type TradingStore } from "../persistence/store.ts";
import type { DeskChartSeries } from "./market.ts";
import { projectTradingRoom, selectBrokerPosition, type TradingRoomInput, type TradingRoomState } from "./room.ts";

/** Builds the desk snapshot from the mounted store and one canonical candle
 * read. It does not append events and it does not invent a kill switch. */
export function loadTradingRoom(
  env: Readonly<Record<string, string | undefined>>,
  chart: DeskChartSeries,
  serverNow: string,
): TradingRoomState {
  const health = tradingHealthReport(env);
  const provider = health.marketData === "live"
    ? "available"
    : health.marketData === "unconfigured"
      ? "unconfigured"
      : "unavailable";
  const market: TradingRoomInput["market"] = {
    provider,
    observation: {
      provenance: chart.provenance,
      timeframe: chart.timeframe,
      bid: null,
      ask: null,
      spread: null,
      providerTimestamp: null,
      receivedAt: serverNow,
      ageMs: null,
      candleCount: chart.candles.length,
    },
  };
  let mount: ReturnType<typeof readXauUsdJobMount>;
  try {
    mount = readXauUsdJobMount(env);
  } catch {
    return projectTradingRoom(emptyInput("unavailable", serverNow, market));
  }
  if (!mount.mounted) return projectTradingRoom(emptyInput("unconfigured", serverNow, market));
  const store = openTradingStore({ path: mount.path, environment: mount.environment });
  try {
    return projectTradingRoom(inputFromStore(store, serverNow, market));
  } catch {
    return projectTradingRoom(emptyInput("unavailable", serverNow, market));
  } finally {
    store.close();
  }
}

function emptyInput(
  source: "unconfigured" | "unavailable",
  serverNow: string,
  market: TradingRoomInput["market"],
): TradingRoomInput {
  return {
    source,
    serverNow,
    environment: null,
    events: [],
    market,
    positionInputs: "unavailable",
    brokerView: null,
    killSwitch: "missing",
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
    reconciliation: null,
    monitoring: null,
    memory: [],
    learning: null,
  };
}

function inputFromStore(store: TradingStore, serverNow: string, market: TradingRoomInput["market"]): TradingRoomInput {
  const events = store.readEvents();
  const jobs = store.jobs.listJobs();
  const job = jobs.find((item) => item.status === "PAUSED") ?? jobs[0] ?? null;
  const occurrence = latestOccurrence(store, events);
  const snapshot = occurrence?.snapshotId ? store.readSnapshot(occurrence.snapshotId) : null;
  const request = occurrence?.executionRequestId ? store.readRequestById(occurrence.executionRequestId) : null;
  const position = positionFrom(snapshot, occurrence?.executionState ?? null, occurrence?.reconciliationState ?? null, request?.acceptedQuantity ?? null);
  const memory = occurrence === null ? [] : store.memory.read(occurrence.occurrenceId).map((record) => ({
    recordId: record.recordId,
    kind: record.kind,
    recordedAt: record.recordedAt,
    body: record.body,
  }));
  return {
    source: "store",
    serverNow,
    environment: store.environment,
    events,
    market,
    positionInputs: position.inputs,
    brokerView: position.view,
    killSwitch: "missing",
    job: job === null ? null : { jobId: job.jobId, status: job.status },
    occurrence: occurrence === null ? null : {
      occurrenceId: occurrence.occurrenceId,
      routineId: occurrence.routineId,
      routineRunId: occurrence.routineRunId,
      threadId: occurrence.threadId,
      providerTurnId: occurrence.providerTurnId,
      agentRunId: occurrence.agentRunId,
      domainStatus: occurrence.domainStatus,
    },
    decision: null,
    risk: null,
    policy: null,
    gate: null,
    approvalOpen: null,
    approvalDecision: null,
    execution: occurrence?.executionState && occurrence.executionRequestId
      ? {
        id: occurrence.executionRequestId,
        state: occurrence.executionState,
        reasons: [],
        brokerCalled: occurrence.executionState !== "NOT_SUBMITTED",
      }
      : null,
    exitExecution: null,
    reconciliation: occurrence?.reconciliationState && occurrence.reconciliationRunId
      ? { id: occurrence.reconciliationRunId, state: occurrence.reconciliationState }
      : null,
    monitoring: null,
    memory,
    learning: null,
  };
}

function latestOccurrence(store: TradingStore, events: readonly TradingEvent[]) {
  const ordered = [...events].sort((left, right) => right.at.localeCompare(left.at) || right.eventId.localeCompare(left.eventId));
  for (const event of ordered) {
    const occurrenceId = event.payload.occurrenceId;
    if (typeof occurrenceId !== "string" || !recordIdSchema.safeParse(occurrenceId).success) continue;
    const row = store.occurrences.readByOccurrenceId(occurrenceId);
    if (row !== null) return row;
  }
  return null;
}

function positionFrom(
  snapshot: ReturnType<TradingStore["readSnapshot"]>,
  executionState: PositionLifecycleInput["executionState"],
  reconciliationState: PositionLifecycleInput["reconciliationState"],
  authorizedQuantity: number | null,
): { inputs: PositionLifecycleInput | "unavailable"; view: TradingRoomInput["brokerView"] } {
  if (snapshot === null || snapshot.unavailable || snapshot.brokerCallSkipped || snapshot.channels.positions !== "read") {
    return { inputs: "unavailable", view: null };
  }
  const selected = selectBrokerPosition(snapshot.positions.map((position) => ({
    positionId: position.positionId,
    symbol: position.symbol,
    direction: position.direction,
    volume: position.volume,
  })));
  if (selected.ambiguous) {
    return {
      inputs: {
        executionState,
        reconciliationState,
        brokerPositionId: null,
        brokerQuantity: null,
        authorizedQuantity,
        exitState: null,
        ambiguous: true,
      },
      view: null,
    };
  }
  return {
    inputs: {
      executionState,
      reconciliationState,
      brokerPositionId: selected.positionId,
      brokerQuantity: selected.quantity,
      authorizedQuantity,
      exitState: null,
      ambiguous: false,
    },
    view: {
      positionId: selected.positionId,
      direction: selected.direction,
      quantity: selected.quantity,
    },
  };
}

export function roomLegacyFields(room: TradingRoomState): {
  readonly presence: TradingRoomState["agentPresence"];
  readonly at: string | null;
  readonly eventType: string | null;
  readonly positionState: TradingRoomState["position"]["state"];
  readonly killSwitchEngaged: boolean;
  readonly source: TradingRoomState["source"];
} {
  const latest = room.timeline.at(-1) ?? null;
  return {
    presence: room.agentPresence,
    at: latest?.at ?? null,
    eventType: latest?.type ?? null,
    positionState: room.position.state,
    killSwitchEngaged: room.killSwitch.state === "engaged",
    source: room.source,
  };
}
