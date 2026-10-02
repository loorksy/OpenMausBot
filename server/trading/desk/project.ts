import type { TradingEvent } from "../../../shared/trading/events.ts";
import { readXauUsdJobMount } from "../jobs/mount.ts";
import type { PositionLifecycleState } from "../lifecycle/position.ts";
import { openTradingStore } from "../persistence/store.ts";

/** Desk presence is the latest real trading event. It does not invent time. */
export const DESK_PRESENCE = [
  "IDLE",
  "WATCHING",
  "OBSERVING",
  "ANALYZING",
  "WAITING",
  "AWAITING_APPROVAL",
  "EXECUTING",
  "RECONCILING",
  "MONITORING",
  "REVIEWING",
  "BLOCKED",
  "PAUSED",
  "ERROR",
] as const;

export type DeskPresence = (typeof DESK_PRESENCE)[number];

const PRESENCE_BY_EVENT: Partial<Record<TradingEvent["type"], DeskPresence>> = {
  "monitoring.started": "WATCHING",
  "market.updated": "OBSERVING",
  "market.quote.updated": "OBSERVING",
  "account.observed": "OBSERVING",
  "position.observed": "OBSERVING",
  "analysis.started": "ANALYZING",
  "analysis.completed": "ANALYZING",
  "decision.created": "ANALYZING",
  "risk.check.started": "ANALYZING",
  "approval.requested": "AWAITING_APPROVAL",
  "execution.requested": "EXECUTING",
  "order.submitted": "EXECUTING",
  "reconciliation.started": "RECONCILING",
  "monitoring.completed": "MONITORING",
  "review.created": "REVIEWING",
  "monitoring.blocked": "BLOCKED",
  "job.blocked": "BLOCKED",
  "emergency.stop": "BLOCKED",
  "agent.paused": "PAUSED",
  "job.paused": "PAUSED",
  "agent.failed": "ERROR",
  "market.unavailable": "BLOCKED",
};

export interface DeskProjection {
  readonly presence: DeskPresence;
  readonly at: string | null;
  readonly eventType: TradingEvent["type"] | null;
  readonly positionState: PositionLifecycleState | null;
  readonly killSwitchEngaged: boolean;
  readonly correlation: {
    readonly agentRunId: string | null;
    readonly occurrenceId: string | null;
    readonly routineId: string | null;
    readonly routineRunId: string | null;
    readonly threadId: string | null;
    readonly providerTurnId: string | null;
    readonly executionRequestId: string | null;
    readonly positionId: string | null;
  };
  readonly sections: readonly ["agent", "chart", "position", "timeline", "decision", "approval"];
}

export function projectDesk(input: {
  readonly events: readonly TradingEvent[];
  readonly positionState?: PositionLifecycleState | null;
}): DeskProjection {
  const ordered = [...input.events].sort((left, right) => left.at.localeCompare(right.at) || left.eventId.localeCompare(right.eventId));
  let presence: DeskPresence = "IDLE";
  let current: TradingEvent | null = null;
  for (const event of ordered) {
    const next = PRESENCE_BY_EVENT[event.type];
    if (next !== undefined) {
      presence = next;
      current = event;
    }
  }
  const payload = current !== null && current.payload !== null && typeof current.payload === "object"
    ? current.payload as Record<string, unknown>
    : {};
  const text = (key: string): string | null => typeof payload[key] === "string" ? payload[key] : null;
  return {
    presence,
    at: current?.at ?? null,
    eventType: current?.type ?? null,
    positionState: input.positionState ?? null,
    killSwitchEngaged: ordered.some((event) => event.type === "emergency.stop"),
    correlation: {
      agentRunId: current?.agentRunId ?? null,
      occurrenceId: text("occurrenceId") ?? current?.correlationId ?? null,
      routineId: text("routineId"),
      routineRunId: text("routineRunId"),
      threadId: text("threadId") ?? current?.runtimeThreadId ?? null,
      providerTurnId: text("providerTurnId") ?? current?.runtimeTurnId ?? null,
      executionRequestId: text("executionRequestId"),
      positionId: text("positionId"),
    },
    sections: ["agent", "chart", "position", "timeline", "decision", "approval"],
  };
}

/** Reads the configured trading store. An unconfigured store stays idle.
 * It does not invent events. The desk chart is drawn by KLineChart Pro in
 * the client from the canonical market contract. This report is not a
 * market provider and it does not name a second chart engine. */
export function tradingDeskReport(env: Readonly<Record<string, string | undefined>>): DeskProjection & {
  readonly source: "unconfigured" | "store";
} {
  let mount: ReturnType<typeof readXauUsdJobMount>;
  try {
    mount = readXauUsdJobMount(env);
  } catch {
    return { ...projectDesk({ events: [] }), source: "unconfigured" };
  }
  if (!mount.mounted) return { ...projectDesk({ events: [] }), source: "unconfigured" };
  const store = openTradingStore({ path: mount.path, environment: mount.environment });
  try {
    return { ...projectDesk({ events: store.readEvents() }), source: "store" };
  } finally {
    store.close();
  }
}
