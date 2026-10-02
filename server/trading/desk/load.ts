import type { TradingEvent } from "../../../shared/trading/events.ts";
import { recordIdSchema } from "../../../shared/trading/ids.ts";
import type { ExecutionState } from "../execution/result.ts";
import { readXauUsdJobMount } from "../jobs/mount.ts";
import type { PositionLifecycleInput } from "../lifecycle/position.ts";
import type { MonitoringDecisionName } from "../monitoring/cycle.ts";
import { tradingHealthReport } from "../production/health.ts";
import type { PersistedMonitoringCycle } from "../persistence/monitoring-cycles.ts";
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
  const exit = exitFrom(store, occurrence);
  const position = positionFrom(snapshot, occurrence?.executionState ?? null, occurrence?.reconciliationState ?? null, request?.acceptedQuantity ?? null, exit.state);
  const memory = occurrence === null ? [] : store.memory.read(occurrence.occurrenceId).map((record) => ({
    recordId: record.recordId,
    kind: record.kind,
    recordedAt: record.recordedAt,
    body: record.body,
  }));
  const cited = occurrence === null ? { unresolved: false, decision: null, risk: null, policy: null, gate: null } : citedRecords(store, occurrence);
  const approval = occurrence === null ? { open: null, decision: null, fact: null, unresolved: false } : approvalFrom(store, occurrence.occurrenceId);
  const monitoring = occurrence === null ? { record: null, malformed: false } : monitoringFrom(store, occurrence.occurrenceId);
  const kill = killFrom(store, occurrence?.agentRunId ?? null);
  const entryAttempts = occurrence?.agentRunId ? store.readAttemptsByAgent(occurrence.agentRunId) : [];
  return {
    source: "store",
    serverNow,
    environment: store.environment,
    events,
    market,
    positionInputs: position.inputs,
    brokerView: position.view,
    killSwitch: kill,
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
    decision: cited.decision,
    risk: cited.risk,
    policy: cited.policy,
    gate: cited.gate,
    approvalOpen: approval.open,
    approvalDecision: approval.decision,
    approvalFact: approval.fact,
    unresolvedCitation: cited.unresolved || approval.unresolved,
    monitoringMalformed: monitoring.malformed,
    execution: occurrence?.executionState && occurrence.executionRequestId
      ? {
        id: occurrence.executionRequestId,
        state: occurrence.executionState,
        reasons: [],
        brokerCalled: brokerCalledFor(entryAttempts, occurrence.executionRequestId, occurrence.executionState),
      }
      : null,
    exitExecution: exit.execution,
    reconciliation: occurrence?.reconciliationState && occurrence.reconciliationRunId
      ? { id: occurrence.reconciliationRunId, state: occurrence.reconciliationState }
      : null,
    monitoring: monitoring.record,
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
  exitState: PositionLifecycleInput["exitState"],
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
        exitState,
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
      exitState,
      ambiguous: false,
    },
    view: {
      positionId: selected.positionId,
      direction: selected.direction,
      quantity: selected.quantity,
    },
  };
}

function killFrom(store: TradingStore, agentRunId: string | null): TradingRoomInput["killSwitch"] {
  if (agentRunId === null) return "missing";
  const read = store.killSwitches.read(agentRunId);
  return read.status === "unknown" || read.state === null ? "missing" : read.state;
}

function citedRecords(store: TradingStore, occurrence: NonNullable<ReturnType<TradingStore["occurrences"]["readByOccurrenceId"]>>): {
  unresolved: boolean;
  decision: TradingRoomInput["decision"];
  risk: TradingRoomInput["risk"];
  policy: TradingRoomInput["policy"];
  gate: TradingRoomInput["gate"];
} {
  let unresolved = false;
  const decision = occurrence.decisionId === null ? null : store.artifacts.readDecision(occurrence.decisionId);
  const risk = occurrence.riskDecisionId === null ? null : store.artifacts.readRisk(occurrence.riskDecisionId);
  const policy = occurrence.policyDecisionId === null ? null : store.artifacts.readPolicy(occurrence.policyDecisionId);
  const gate = occurrence.gateDecisionId === null ? null : store.artifacts.readGate(occurrence.gateDecisionId);
  if (decision === "missing" || decision === "malformed" || risk === "missing" || risk === "malformed" || policy === "missing" || policy === "malformed" || gate === "missing" || gate === "malformed") {
    unresolved = true;
  }
  return {
    unresolved,
    decision: decision === null || decision === "missing" || decision === "malformed" ? null : decision,
    risk: risk === null || risk === "missing" || risk === "malformed" ? null : { id: risk.id, state: risk.state, reasons: risk.reasons },
    policy: policy === null || policy === "missing" || policy === "malformed" ? null : { id: policy.id, state: policy.state, progression: policy.progression, reasons: policy.reasons },
    gate: gate === null || gate === "missing" || gate === "malformed" ? null : { id: gate.id, state: gate.state, reasons: gate.reasons },
  };
}

function approvalFrom(store: TradingStore, occurrenceId: string): {
  open: TradingRoomInput["approvalOpen"];
  decision: TradingRoomInput["approvalDecision"];
  fact: TradingRoomInput["approvalFact"];
  unresolved: boolean;
} {
  const rows = store.approvals.readForOccurrence(occurrenceId);
  if (rows.ambiguous) return { open: null, decision: null, fact: null, unresolved: true };
  const open = rows.open === null ? null : { requestId: rows.open.requestId, expiresAt: rows.open.expiresAt, decisionId: rows.open.decisionId };
  const fact = readApprovalFact(rows.settled?.factJson ?? null);
  if (fact.unresolved) return { open, decision: null, fact: null, unresolved: true };
  if (rows.settled === null || rows.settled.decisionJson === null) {
    return { open, decision: null, fact: fact.fact, unresolved: false };
  }
  try {
    const parsed = JSON.parse(rows.settled.decisionJson) as { id?: unknown; state?: unknown; reasons?: unknown };
    if (typeof parsed.id !== "string" || typeof parsed.state !== "string" || !Array.isArray(parsed.reasons)) {
      return { open, decision: null, fact: null, unresolved: true };
    }
    return {
      open,
      decision: { id: parsed.id, state: parsed.state, reasons: parsed.reasons.filter((item): item is string => typeof item === "string") },
      fact: fact.fact,
      unresolved: false,
    };
  } catch {
    return { open, decision: null, fact: null, unresolved: true };
  }
}

function readApprovalFact(json: string | null): {
  fact: TradingRoomInput["approvalFact"];
  unresolved: boolean;
} {
  if (json === null) return { fact: null, unresolved: false };
  try {
    const parsed = JSON.parse(json) as { approvalId?: unknown; approved?: unknown; approvedAt?: unknown };
    if (typeof parsed.approvalId !== "string" || typeof parsed.approved !== "boolean" || typeof parsed.approvedAt !== "string") {
      return { fact: null, unresolved: true };
    }
    return {
      fact: { approvalId: parsed.approvalId, approved: parsed.approved, approvedAt: parsed.approvedAt },
      unresolved: false,
    };
  } catch {
    return { fact: null, unresolved: true };
  }
}

function monitoringFrom(store: TradingStore, occurrenceId: string): { record: TradingRoomInput["monitoring"]; malformed: boolean } {
  const cycle = store.monitoringCycles.readLatest(occurrenceId);
  if (cycle === "missing") return { record: null, malformed: false };
  if (cycle === "malformed") return { record: null, malformed: true };
  return { record: monitoringRecord(cycle), malformed: false };
}

function monitoringRecord(cycle: PersistedMonitoringCycle): NonNullable<TradingRoomInput["monitoring"]> {
  const proposal = cycle.exitProposal;
  return {
    availability: "RECORD",
    observedAt: cycle.observedAt,
    decision: cycle.decision as MonitoringDecisionName,
    failureCodes: cycle.failureCodes,
    brokerHealth: cycle.brokerHealth,
    exitProposalRecorded: proposal !== null,
    reconciliationState: cycle.reconciliationState,
    exitProposal: proposal === null ? null : {
      positionId: proposal.positionId,
      direction: proposal.direction,
      positionQuantity: proposal.positionQuantity,
      proposedExitQuantity: proposal.proposedExitQuantity,
      reason: proposal.reason,
    },
  };
}

function exitFrom(store: TradingStore, occurrence: ReturnType<TradingStore["occurrences"]["readByOccurrenceId"]>): {
  state: ExecutionState | null;
  execution: TradingRoomInput["exitExecution"];
} {
  if (occurrence === null) return { state: null, execution: null };
  const attempts = store.readAttemptsByAgent(occurrence.agentRunId).filter((attempt) => typeof attempt.closePositionId === "string" && attempt.closePositionId.length > 0);
  const selected = occurrence.exitExecutionRequestId === null
    ? latestExit(attempts)
    : latestExit(attempts.filter((attempt) => attempt.executionRequestId === occurrence.exitExecutionRequestId));
  if (selected !== null) {
    const brokerCalled = selected.sequence > 1 || selected.state === "SUBMISSION_ACCEPTED" || selected.state === "SUBMISSION_REJECTED" || selected.state === "FILL_REPORTED";
    return {
      state: selected.state,
      execution: {
        id: selected.executionRequestId,
        state: selected.state,
        brokerCalled,
        closePositionId: selected.closePositionId ?? null,
        quantity: selected.quantity,
        reason: null,
      },
    };
  }
  if (occurrence.exitExecutionState === null || occurrence.exitExecutionRequestId === null) return { state: null, execution: null };
  return {
    state: occurrence.exitExecutionState,
    execution: {
      id: occurrence.exitExecutionRequestId,
      state: occurrence.exitExecutionState,
      brokerCalled: occurrence.exitBrokerCalled === true,
      closePositionId: occurrence.exitClosePositionId,
      quantity: occurrence.exitQuantity,
      reason: occurrence.exitFailureCode,
    },
  };
}

function latestExit(attempts: readonly { sequence: number; submittedAt: string; executionRequestId: string; state: ExecutionState; closePositionId?: string | null; quantity: number }[]): (typeof attempts)[number] | null {
  return attempts.reduce<(typeof attempts)[number] | null>((best, attempt) => {
    if (best === null || attempt.sequence > best.sequence || (attempt.sequence === best.sequence && attempt.submittedAt > best.submittedAt)) return attempt;
    return best;
  }, null);
}

function brokerCalledFor(attempts: readonly { executionRequestId: string; sequence: number; state: ExecutionState; closePositionId?: string | null }[], requestId: string, state: ExecutionState): boolean {
  const own = attempts.filter((attempt) => attempt.executionRequestId === requestId && (attempt.closePositionId == null || attempt.closePositionId === ""));
  const latest = own.reduce<(typeof own)[number] | null>((best, attempt) => best === null || attempt.sequence > best.sequence ? attempt : best, null);
  if (latest === null) return false;
  return latest.sequence > 1 || state === "SUBMISSION_ACCEPTED" || state === "SUBMISSION_REJECTED" || state === "FILL_REPORTED";
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
