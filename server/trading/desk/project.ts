import type { TradingEvent } from "../../../shared/trading/events.ts";
import type { PositionLifecycleState } from "../lifecycle/position.ts";

/** Not a trading-room projection. It does not read events, the kill switch,
 * a position, or an execution. `projectTradingRoom` is the only room projection. */
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

export interface DeskProjection {
  readonly authoritative: false;
  readonly presence: null;
  readonly at: null;
  readonly eventType: null;
  readonly positionState: null;
  readonly killSwitchEngaged: null;
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

export function projectDesk(_input?: {
  readonly events?: readonly TradingEvent[];
  readonly positionState?: PositionLifecycleState | null;
}): DeskProjection & { readonly authoritative: false } {
  return {
    authoritative: false,
    presence: null,
    at: null,
    eventType: null,
    positionState: null,
    killSwitchEngaged: null,
    correlation: {
      agentRunId: null,
      occurrenceId: null,
      routineId: null,
      routineRunId: null,
      threadId: null,
      providerTurnId: null,
      executionRequestId: null,
      positionId: null,
    },
    sections: ["agent", "chart", "position", "timeline", "decision", "approval"],
  };
}

/** Retained so older imports do not become a second room. It does not open
 * the store and it does not report presence, position, or the kill switch. */
export function tradingDeskReport(_env?: Readonly<Record<string, string | undefined>>): DeskProjection & {
  readonly authoritative: false;
  readonly source: "not-authoritative";
} {
  return { ...projectDesk(), authoritative: false, source: "not-authoritative" };
}
