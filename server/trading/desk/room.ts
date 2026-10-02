import type { Decision } from "../../../shared/trading/decision.ts";
import type { ProvenanceStatus, TradingEnvironment } from "../../../shared/trading/environment.ts";
import type { TradingEvent } from "../../../shared/trading/events.ts";
import type { KillSwitchState } from "../../../shared/trading/kill-switch.ts";
import type { ReconciliationState } from "../../../shared/trading/reconciliation.ts";
import type { ExecutionState } from "../execution/result.ts";
import { derivePositionLifecycle, type PositionLifecycleInput, type PositionLifecycleState } from "../lifecycle/position.ts";
import type { MonitoringDecisionName } from "../monitoring/cycle.ts";
import type { OccurrenceDomainStatus } from "../occurrence/identity.ts";

/** Presentation presence. EXECUTING is intentionally absent: the ledger
 * cannot distinguish an in-flight reserve from SUBMISSION_UNKNOWN. */
export const ROOM_PRESENCE = [
  "PAUSED",
  "ERROR",
  "CONFIRMING",
  "EXIT_WORKING",
  "DEGRADED",
  "MONITORING",
  "AWAITING_APPROVAL",
  "DECISION_READY",
  "ANALYZING",
  "OBSERVING",
  "WAITING_FOR_DATA",
  "IDLE",
] as const;

export type RoomPresence = (typeof ROOM_PRESENCE)[number];

export const NEXT_ACTIONS = [
  "STORE_UNAVAILABLE",
  "BLOCKED_KILL_SWITCH_UNKNOWN",
  "BLOCKED_KILL_SWITCH",
  "BLOCKED_DESYNCED",
  "WAITING_FOR_RECONCILIATION",
  "PAUSED",
  "WAITING_FOR_APPROVAL",
  "WAITING_FOR_RISK_REASSESSMENT",
  "WAITING_FOR_POLICY_REASSESSMENT",
  "WAITING_FOR_GATE_APPROVAL",
  "ELIGIBLE_NOT_SUBMITTED",
  "EXIT_RECOMMENDED",
  "EXIT_WORKING",
  "WAITING_FOR_BROKER_CONFIRMATION",
  "MONITORING",
  "POSITION_OPEN_NO_CYCLE",
  "NO_TRADE",
  "WAIT",
  "EXPIRED",
  "REJECTED",
  "ANALYSIS_STARTED",
  "WAITING_FOR_TRUSTED_MARKET",
  "NO_RECORDED_NEXT_STEP",
] as const;

export type NextActionCode = (typeof NEXT_ACTIONS)[number];

export type UserAction = "NONE" | "ASK" | "APPROVE" | "REJECT";

export type BlockingCondition =
  | "KILL_SWITCH_ENGAGED"
  | "KILL_SWITCH_UNKNOWN"
  | "PAUSED"
  | "RECONCILIATION_DESYNCED"
  | "RECONCILIATION_UNKNOWN"
  | "MARKET_DATA_STALE"
  | "MARKET_DATA_UNAVAILABLE"
  | "EXIT_AUTHORIZATION_REQUIRED"
  | "EXIT_CLOSE_NOT_REPRESENTABLE"
  | null;

export interface RoomRecordRef {
  readonly kind: string;
  readonly id: string;
}

export interface RoomNextAction {
  readonly action: NextActionCode;
  readonly reason: string | null;
  readonly blockingCondition: BlockingCondition;
  readonly allowedUserAction: UserAction;
  /** Primary action. Open approvals also list REJECT beside APPROVE. */
  readonly allowedUserActions: readonly UserAction[];
  readonly authoritativeRecord: RoomRecordRef | null;
  readonly expiresAt: string | null;
  readonly safety: {
    readonly killSwitch: "open" | "engaged" | "unknown";
    readonly paused: boolean;
    readonly autonomousOrdersBlocked: boolean;
  };
}

export interface RoomTimelineEntry {
  readonly eventId: string;
  readonly type: TradingEvent["type"];
  readonly at: string;
  readonly actor: string;
  readonly nextState: string | null;
  readonly occurrenceId: string | null;
  readonly monitoringDecision: string | null;
  readonly failureCodes: readonly string[];
}

export interface RoomMarketObservation {
  readonly provenance: ProvenanceStatus;
  readonly timeframe: string | null;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly spread: number | null;
  readonly providerTimestamp: string | null;
  readonly receivedAt: string | null;
  readonly ageMs: number | null;
  readonly candleCount: number;
}

export interface TradingRoomState {
  readonly source: "unconfigured" | "store" | "unavailable";
  readonly serverNow: string;
  readonly environment: TradingEnvironment | null;
  readonly instrument: "XAUUSD";
  readonly tradingCursor: null;
  readonly market: {
    readonly provider: "unconfigured" | "available" | "unavailable";
    readonly observation: RoomMarketObservation | null;
  };
  readonly agentPresence: RoomPresence;
  readonly decision: Decision | null;
  readonly decisionAvailability: "RECORD" | "NOT_AVAILABLE";
  readonly risk: { readonly id: string; readonly state: string; readonly reasons: readonly string[] } | null;
  readonly policy: { readonly id: string; readonly state: string; readonly progression: string; readonly reasons: readonly string[] } | null;
  readonly approval: {
    readonly open: { readonly requestId: string; readonly expiresAt: string; readonly decisionId: string } | null;
    readonly decision: { readonly id: string; readonly state: string; readonly reasons: readonly string[] } | null;
  };
  readonly gate: { readonly id: string; readonly state: string; readonly reasons: readonly string[] } | null;
  readonly execution: {
    readonly id: string;
    readonly state: ExecutionState;
    readonly reasons: readonly string[];
    readonly brokerCalled: boolean;
  } | null;
  readonly reconciliation: { readonly id: string; readonly state: ReconciliationState } | null;
  readonly position: {
    readonly availability: "NOT_AVAILABLE" | "UNKNOWN" | "DERIVED";
    readonly state: PositionLifecycleState | null;
    readonly brokerPositionId: string | null;
    readonly direction: "LONG" | "SHORT" | null;
    readonly brokerQuantity: number | null;
  };
  readonly monitoring: {
    readonly availability: "NOT_AVAILABLE" | "EVENT_ONLY" | "RECORD";
    readonly observedAt: string | null;
    readonly decision: MonitoringDecisionName | string | null;
    readonly failureCodes: readonly string[];
    readonly brokerHealth: "HEALTHY" | "DEGRADED" | "UNAVAILABLE" | "UNKNOWN" | null;
  };
  readonly exit: {
    readonly proposal: "NOT_AVAILABLE" | "RECORDED";
    readonly authorizationRequired: boolean;
    readonly closeNotRepresentable: boolean;
    readonly execution: { readonly id: string; readonly state: ExecutionState; readonly brokerCalled: boolean } | null;
  };
  readonly killSwitch: { readonly state: "open" | "engaged" | "unknown"; readonly updatedAt: string | null };
  readonly pause: { readonly paused: boolean; readonly jobId: string | null };
  readonly nextAction: RoomNextAction;
  readonly timeline: readonly RoomTimelineEntry[];
  readonly memory: readonly { readonly recordId: string; readonly kind: string; readonly recordedAt: string; readonly body: string }[];
  readonly learning: { readonly accepted: boolean; readonly reason: string | null; readonly revisionId: string | null; readonly target: string | null } | null;
  readonly review: "NOT_AVAILABLE";
  readonly attachedConversation: {
    readonly availability: "ATTACHED" | "NOT_AVAILABLE";
    readonly threadId: string | null;
    readonly providerTurnId: string | null;
    readonly occurrenceId: string | null;
    readonly agentRunId: string | null;
    readonly routineId: string | null;
    readonly routineRunId: string | null;
  };
}

export interface TradingRoomInput {
  readonly source: TradingRoomState["source"];
  readonly serverNow: string;
  readonly environment: TradingEnvironment | null;
  readonly events: readonly TradingEvent[];
  readonly market: TradingRoomState["market"];
  readonly positionInputs: PositionLifecycleInput | "unavailable";
  readonly brokerView: {
    readonly positionId: string | null;
    readonly direction: "LONG" | "SHORT" | null;
    readonly quantity: number | null;
  } | null;
  readonly killSwitch: KillSwitchState | "missing";
  readonly job: { readonly jobId: string; readonly status: string } | null;
  readonly occurrence: {
    readonly occurrenceId: string;
    readonly routineId: string;
    readonly routineRunId: string;
    readonly threadId: string | null;
    readonly providerTurnId: string | null;
    readonly agentRunId: string;
    readonly domainStatus: OccurrenceDomainStatus | null;
  } | null;
  readonly decision: Decision | null;
  readonly risk: TradingRoomState["risk"];
  readonly policy: TradingRoomState["policy"];
  readonly gate: TradingRoomState["gate"];
  readonly approvalOpen: TradingRoomState["approval"]["open"];
  readonly approvalDecision: TradingRoomState["approval"]["decision"];
  readonly execution: TradingRoomState["execution"];
  readonly exitExecution: TradingRoomState["exit"]["execution"];
  readonly reconciliation: TradingRoomState["reconciliation"];
  readonly monitoring: {
    readonly availability: "RECORD";
    readonly observedAt: string;
    readonly decision: MonitoringDecisionName;
    readonly failureCodes: readonly string[];
    readonly brokerHealth: "HEALTHY" | "DEGRADED" | "UNAVAILABLE" | "UNKNOWN";
    readonly exitProposalRecorded: boolean;
  } | null;
  readonly memory: TradingRoomState["memory"];
  readonly learning: TradingRoomState["learning"];
}

const MONITORING_DECISIONS = new Set([
  "NO_ACTION",
  "CONTINUE_MONITORING",
  "WAIT",
  "EXIT",
  "PAUSE",
  "BLOCKED",
  "REQUIRES_RECONCILIATION",
]);

/** Same event rows in any arrival order project the same room. Position
 * comes only from derivePositionLifecycle inputs, never from event types. */
export function projectTradingRoom(input: TradingRoomInput): TradingRoomState {
  const timeline = timelineFrom(input.events);
  const position = projectPosition(input);
  const killSwitch = projectKillSwitch(input.killSwitch);
  const paused = input.job?.status === "PAUSED";
  const monitoring = projectMonitoring(input, timeline);
  const exitFlags = exitFlagsFrom(monitoring);
  const presence = projectPresence(input, position, killSwitch.state, paused, monitoring, timeline);
  const autonomousOrdersBlocked = input.reconciliation?.state === "DESYNCED" || input.reconciliation?.state === "UNKNOWN"
    || position.state === "POSITION_DESYNCED"
    || position.state === "POSITION_UNKNOWN";
  const safety = {
    killSwitch: killSwitch.state,
    paused,
    autonomousOrdersBlocked,
  };
  const nextAction = projectNextAction(input, position, presence, monitoring, exitFlags, safety);
  const threadId = input.occurrence?.threadId ?? null;
  return {
    source: input.source,
    serverNow: input.serverNow,
    environment: input.environment,
    instrument: "XAUUSD",
    tradingCursor: null,
    market: input.market,
    agentPresence: input.source === "store" ? presence : "IDLE",
    decision: input.decision,
    decisionAvailability: input.decision === null ? "NOT_AVAILABLE" : "RECORD",
    risk: input.risk,
    policy: input.policy,
    approval: { open: input.approvalOpen, decision: input.approvalDecision },
    gate: input.gate,
    execution: input.execution,
    reconciliation: input.reconciliation,
    position,
    monitoring,
    exit: {
      proposal: exitFlags.proposal,
      authorizationRequired: exitFlags.authorizationRequired,
      closeNotRepresentable: exitFlags.closeNotRepresentable,
      execution: input.exitExecution,
    },
    killSwitch,
    pause: { paused, jobId: paused ? input.job?.jobId ?? null : input.job?.jobId ?? null },
    nextAction,
    timeline,
    memory: input.memory,
    learning: input.learning,
    review: "NOT_AVAILABLE",
    attachedConversation: threadId === null
      ? {
        availability: "NOT_AVAILABLE",
        threadId: null,
        providerTurnId: null,
        occurrenceId: input.occurrence?.occurrenceId ?? null,
        agentRunId: input.occurrence?.agentRunId ?? null,
        routineId: input.occurrence?.routineId ?? null,
        routineRunId: input.occurrence?.routineRunId ?? null,
      }
      : {
        availability: "ATTACHED",
        threadId,
        providerTurnId: input.occurrence?.providerTurnId ?? null,
        occurrenceId: input.occurrence?.occurrenceId ?? null,
        agentRunId: input.occurrence?.agentRunId ?? null,
        routineId: input.occurrence?.routineId ?? null,
        routineRunId: input.occurrence?.routineRunId ?? null,
      },
  };
}

export function projectPosition(input: Pick<TradingRoomInput, "source" | "positionInputs" | "brokerView">): TradingRoomState["position"] {
  if (input.source !== "store") {
    return { availability: "NOT_AVAILABLE", state: null, brokerPositionId: null, direction: null, brokerQuantity: null };
  }
  if (input.positionInputs === "unavailable") {
    return { availability: "UNKNOWN", state: "POSITION_UNKNOWN", brokerPositionId: null, direction: null, brokerQuantity: null };
  }
  const view = input.brokerView;
  return {
    availability: "DERIVED",
    state: derivePositionLifecycle(input.positionInputs),
    brokerPositionId: view?.positionId ?? null,
    direction: view?.direction ?? null,
    brokerQuantity: view?.quantity ?? null,
  };
}

function projectKillSwitch(value: TradingRoomInput["killSwitch"]): TradingRoomState["killSwitch"] {
  if (value === "missing") return { state: "unknown", updatedAt: null };
  return { state: value.engaged ? "engaged" : "open", updatedAt: value.updatedAt };
}

function projectMonitoring(input: TradingRoomInput, timeline: readonly RoomTimelineEntry[]): TradingRoomState["monitoring"] {
  if (input.monitoring !== null) {
    return {
      availability: "RECORD",
      observedAt: input.monitoring.observedAt,
      decision: input.monitoring.decision,
      failureCodes: input.monitoring.failureCodes,
      brokerHealth: input.monitoring.brokerHealth,
    };
  }
  const evidence = [...timeline].reverse().find((entry) => entry.type === "monitoring.completed" || entry.type === "monitoring.blocked");
  if (evidence === undefined) {
    return { availability: "NOT_AVAILABLE", observedAt: null, decision: null, failureCodes: [], brokerHealth: null };
  }
  return {
    availability: "EVENT_ONLY",
    observedAt: evidence.at,
    decision: evidence.monitoringDecision,
    failureCodes: evidence.failureCodes,
    brokerHealth: null,
  };
}

function exitFlagsFrom(
  monitoring: TradingRoomState["monitoring"],
): { proposal: "NOT_AVAILABLE" | "RECORDED"; authorizationRequired: boolean; closeNotRepresentable: boolean } {
  const codes = new Set(monitoring.failureCodes);
  const authorizationRequired = codes.has("EXIT_AUTHORIZATION_REQUIRED");
  const closeNotRepresentable = codes.has("EXIT_CLOSE_NOT_REPRESENTABLE");
  const recorded = monitoring.availability === "RECORD" && (authorizationRequired || closeNotRepresentable || monitoring.decision === "EXIT");
  return {
    proposal: recorded ? "RECORDED" : "NOT_AVAILABLE",
    authorizationRequired,
    closeNotRepresentable,
  };
}

function projectPresence(
  input: TradingRoomInput,
  position: TradingRoomState["position"],
  _killSwitch: "open" | "engaged" | "unknown",
  paused: boolean,
  monitoring: TradingRoomState["monitoring"],
  timeline: readonly RoomTimelineEntry[],
): RoomPresence {
  if (paused) return "PAUSED";
  if (isError(input, timeline)) return "ERROR";
  if (
    position.state === "POSITION_UNKNOWN"
    || position.state === "POSITION_PENDING"
    || position.state === "POSITION_DESYNCED"
    || input.execution?.state === "SUBMISSION_UNKNOWN"
    || input.exitExecution?.state === "SUBMISSION_UNKNOWN"
  ) return "CONFIRMING";
  // POSITION_CLOSING caused by an accepted exit is EXIT_WORKING. Any other
  // closing book stays CONFIRMING. Unknown still outranks this branch.
  if (input.exitExecution?.state === "SUBMISSION_ACCEPTED" && (position.state === "POSITION_CLOSING" || (position.brokerQuantity !== null && position.brokerQuantity > 0))) {
    return "EXIT_WORKING";
  }
  if (position.state === "POSITION_CLOSING") return "CONFIRMING";
  if (input.reconciliation?.state === "DEGRADED" || monitoring.brokerHealth === "DEGRADED") return "DEGRADED";
  if (
    monitoring.availability === "RECORD"
    && (position.state === "POSITION_OPEN" || position.state === "POSITION_PARTIALLY_OPEN")
  ) return "MONITORING";
  if (input.approvalOpen !== null && input.approvalDecision === null) return "AWAITING_APPROVAL";
  if (input.decision !== null && (input.decision.status === "DRAFT" || input.decision.status === "VALIDATING" || input.decision.status === "APPROVED")) {
    return "DECISION_READY";
  }
  if (analysisOpen(timeline) && input.decision === null && input.occurrence?.domainStatus !== "turn_failed") return "ANALYZING";
  if (trustedObservation(timeline)) return "OBSERVING";
  const provenance = input.market.observation?.provenance ?? null;
  if (provenance === "STALE" || provenance === "UNAVAILABLE" || latestMarketUntusted(timeline)) return "WAITING_FOR_DATA";
  return "IDLE";
}

function isError(input: TradingRoomInput, timeline: readonly RoomTimelineEntry[]): boolean {
  if (input.job?.status === "FAILED") return true;
  if (input.occurrence?.domainStatus === "turn_failed") return true;
  const failureAt = latestOf(timeline, new Set(["agent.failed", "job.failed"]))?.at ?? null;
  if (failureAt === null) return false;
  const successAt = latestOf(timeline, new Set(["monitoring.completed", "analysis.completed"]))?.at ?? null;
  return successAt === null || failureAt > successAt;
}

function analysisOpen(timeline: readonly RoomTimelineEntry[]): boolean {
  const started = latestOf(timeline, new Set(["analysis.started"]));
  if (started === undefined) return false;
  const completed = latestOf(timeline, new Set(["analysis.completed"]));
  return completed === undefined || started.at > completed.at || (started.at === completed.at && started.eventId > completed.eventId);
}

function trustedObservation(timeline: readonly RoomTimelineEntry[]): boolean {
  const entry = latestOf(timeline, new Set([
    "market.updated",
    "market.quote.updated",
    "market.candles.updated",
    "account.observed",
    "position.observed",
  ]));
  if (entry === undefined) return false;
  return entry.nextState === "LIVE" || entry.nextState === "SIMULATOR" || entry.nextState === "REPLAY" || entry.nextState === null;
}

function latestMarketUntusted(timeline: readonly RoomTimelineEntry[]): boolean {
  const entry = latestOf(timeline, new Set(["market.stale", "market.unavailable", "market.invalid", "market.provider_error"]));
  if (entry === undefined) return false;
  const trusted = latestOf(timeline, new Set(["market.updated", "market.quote.updated", "market.candles.updated"]));
  return trusted === undefined || entry.at > trusted.at;
}

function projectNextAction(
  input: TradingRoomInput,
  position: TradingRoomState["position"],
  presence: RoomPresence,
  monitoring: TradingRoomState["monitoring"],
  exitFlags: { authorizationRequired: boolean; closeNotRepresentable: boolean },
  safety: RoomNextAction["safety"],
): RoomNextAction {
  const ask = input.occurrence?.threadId ? "ASK" as const : "NONE" as const;
  const base = (action: NextActionCode, extra: Partial<RoomNextAction> = {}): RoomNextAction => ({
    action,
    reason: extra.reason ?? null,
    blockingCondition: extra.blockingCondition ?? null,
    allowedUserAction: extra.allowedUserAction ?? "NONE",
    allowedUserActions: extra.allowedUserActions ?? [extra.allowedUserAction ?? "NONE"],
    authoritativeRecord: extra.authoritativeRecord ?? null,
    expiresAt: extra.expiresAt ?? null,
    safety,
  });
  if (input.source !== "store") return base("STORE_UNAVAILABLE");
  if (safety.killSwitch === "unknown") {
    return base("BLOCKED_KILL_SWITCH_UNKNOWN", { blockingCondition: "KILL_SWITCH_UNKNOWN" });
  }
  if (safety.killSwitch === "engaged") {
    return base("BLOCKED_KILL_SWITCH", { blockingCondition: "KILL_SWITCH_ENGAGED" });
  }
  if (position.state === "POSITION_DESYNCED" || input.reconciliation?.state === "DESYNCED") {
    return base("BLOCKED_DESYNCED", {
      blockingCondition: "RECONCILIATION_DESYNCED",
      authoritativeRecord: input.reconciliation ? { kind: "reconciliation", id: input.reconciliation.id } : null,
    });
  }
  if (position.state === "POSITION_UNKNOWN" || input.execution?.state === "SUBMISSION_UNKNOWN" || input.exitExecution?.state === "SUBMISSION_UNKNOWN") {
    return base("WAITING_FOR_RECONCILIATION", { blockingCondition: "RECONCILIATION_UNKNOWN" });
  }
  if (safety.paused) return base("PAUSED", { blockingCondition: "PAUSED", authoritativeRecord: input.job ? { kind: "job", id: input.job.jobId } : null });
  if (input.approvalOpen !== null && input.approvalDecision === null) {
    return base("WAITING_FOR_APPROVAL", {
      allowedUserAction: "APPROVE",
      allowedUserActions: ["APPROVE", "REJECT"],
      authoritativeRecord: { kind: "approval_request", id: input.approvalOpen.requestId },
      expiresAt: input.approvalOpen.expiresAt,
    });
  }
  if (input.gate?.state === "REQUIRES_RISK_REASSESSMENT") {
    return base("WAITING_FOR_RISK_REASSESSMENT", { authoritativeRecord: { kind: "gate", id: input.gate.id } });
  }
  if (input.gate?.state === "REQUIRES_POLICY_REASSESSMENT") {
    return base("WAITING_FOR_POLICY_REASSESSMENT", { authoritativeRecord: { kind: "gate", id: input.gate.id } });
  }
  if (input.gate?.state === "REQUIRES_APPROVAL") {
    return base("WAITING_FOR_GATE_APPROVAL", { authoritativeRecord: { kind: "gate", id: input.gate.id } });
  }
  if (input.gate?.state === "ELIGIBLE_FOR_EXECUTION" && input.execution === null && input.exitExecution === null) {
    return base("ELIGIBLE_NOT_SUBMITTED", { authoritativeRecord: { kind: "gate", id: input.gate.id }, allowedUserAction: ask, allowedUserActions: [ask] });
  }
  if (exitFlags.authorizationRequired && input.exitExecution === null) {
    return base("EXIT_RECOMMENDED", { blockingCondition: "EXIT_AUTHORIZATION_REQUIRED", allowedUserAction: "NONE", allowedUserActions: ["NONE"] });
  }
  if (exitFlags.closeNotRepresentable && input.exitExecution === null) {
    return base("EXIT_RECOMMENDED", { blockingCondition: "EXIT_CLOSE_NOT_REPRESENTABLE" });
  }
  if (input.exitExecution?.state === "SUBMISSION_ACCEPTED" && position.state === "POSITION_CLOSING") {
    return base("EXIT_WORKING", { authoritativeRecord: { kind: "execution", id: input.exitExecution.id } });
  }
  if (position.state === "POSITION_PENDING" || position.state === "POSITION_CLOSING") {
    return base("WAITING_FOR_BROKER_CONFIRMATION");
  }
  if ((position.state === "POSITION_OPEN" || position.state === "POSITION_PARTIALLY_OPEN") && monitoring.availability === "RECORD") {
    return base("MONITORING", { allowedUserAction: ask, allowedUserActions: [ask] });
  }
  if ((position.state === "POSITION_OPEN" || position.state === "POSITION_PARTIALLY_OPEN") && monitoring.availability !== "RECORD") {
    return base("POSITION_OPEN_NO_CYCLE");
  }
  if (input.decision?.status === "EXPIRED") {
    return base("EXPIRED", { authoritativeRecord: { kind: "decision", id: input.decision.id }, expiresAt: input.decision.expiry });
  }
  if (input.decision?.status === "REJECTED") {
    return base("REJECTED", { authoritativeRecord: { kind: "decision", id: input.decision.id } });
  }
  if (input.decision?.direction === "NO_TRADE") {
    return base("NO_TRADE", { authoritativeRecord: { kind: "decision", id: input.decision.id }, expiresAt: input.decision.expiry });
  }
  if (input.decision?.direction === "WAIT") {
    return base("WAIT", { authoritativeRecord: { kind: "decision", id: input.decision.id }, expiresAt: input.decision.expiry });
  }
  const provenance = input.market.observation?.provenance ?? null;
  if (provenance === "STALE") return base("WAITING_FOR_TRUSTED_MARKET", { blockingCondition: "MARKET_DATA_STALE", allowedUserAction: ask, allowedUserActions: [ask] });
  if (provenance === "UNAVAILABLE") return base("WAITING_FOR_TRUSTED_MARKET", { blockingCondition: "MARKET_DATA_UNAVAILABLE", allowedUserAction: ask, allowedUserActions: [ask] });
  if (presence === "ANALYZING") return base("ANALYSIS_STARTED", { allowedUserAction: ask, allowedUserActions: [ask] });
  return base("NO_RECORDED_NEXT_STEP", { allowedUserAction: ask, allowedUserActions: [ask] });
}

function timelineFrom(events: readonly TradingEvent[]): RoomTimelineEntry[] {
  return [...events]
    .sort((left, right) => left.at.localeCompare(right.at) || left.eventId.localeCompare(right.eventId))
    .map((event) => {
      const payload = event.payload;
      const occurrenceId = typeof payload.occurrenceId === "string" ? payload.occurrenceId : null;
      const monitoringDecision = event.actor === "xauusd-monitoring" && typeof payload.decision === "string" && MONITORING_DECISIONS.has(payload.decision)
        ? payload.decision
        : null;
      const failureCodes = Array.isArray(payload.failureCodes)
        ? payload.failureCodes.filter((code): code is string => typeof code === "string")
        : [];
      return {
        eventId: event.eventId,
        type: event.type,
        at: event.at,
        actor: event.actor,
        nextState: event.nextState ?? null,
        occurrenceId,
        monitoringDecision,
        failureCodes,
      };
    });
}

function latestOf(timeline: readonly RoomTimelineEntry[], types: ReadonlySet<string>): RoomTimelineEntry | undefined {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (entry !== undefined && types.has(entry.type)) return entry;
  }
  return undefined;
}

/** One usable XAUUSD position. More than one, or an unusable row, is ambiguous. */
export function selectBrokerPosition(positions: readonly {
  readonly positionId: string;
  readonly symbol: string;
  readonly direction: string | null;
  readonly volume: number;
}[]): { readonly ambiguous: true } | { readonly ambiguous: false; readonly positionId: string | null; readonly direction: "LONG" | "SHORT" | null; readonly quantity: number | null } {
  const own = positions.filter((item) => item.symbol === "XAUUSD");
  const usable = (item: (typeof own)[number]): item is { positionId: string; symbol: string; direction: "LONG" | "SHORT"; volume: number } =>
    item.positionId.trim().length > 0
    && (item.direction === "LONG" || item.direction === "SHORT")
    && Number.isFinite(item.volume)
    && item.volume > 0;
  if (own.length > 1 || own.some((item) => !usable(item))) return { ambiguous: true };
  const one = own[0];
  if (one === undefined || !usable(one)) {
    return { ambiguous: false, positionId: null, direction: null, quantity: null };
  }
  return { ambiguous: false, positionId: one.positionId, direction: one.direction, quantity: one.volume };
}
