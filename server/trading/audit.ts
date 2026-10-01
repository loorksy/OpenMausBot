import type { TradingEnvironment } from "../../shared/trading/environment.ts";
import {
  parseTradingEvent,
  type TradingEvent,
  type TradingEventType,
} from "../../shared/trading/events.ts";
import { recordIdSchema } from "../../shared/trading/ids.ts";

/** Builds one trading-domain event from caller-supplied ids. A bad id drops
 * the event instead of inventing one. This does not touch RuntimeEvent. */

export function tradingFact(input: {
  readonly type: TradingEventType;
  readonly eventId: string;
  readonly at: string;
  readonly agentRunId: string;
  readonly correlationId: string;
  readonly environment: TradingEnvironment;
  readonly actor: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly nextState?: string;
  readonly runtimeThreadId?: string | null;
  readonly runtimeTurnId?: string | null;
}): TradingEvent | null {
  if (!recordIdSchema.safeParse(input.eventId).success) return null;
  if (!recordIdSchema.safeParse(input.agentRunId).success) return null;
  if (!recordIdSchema.safeParse(input.correlationId).success) return null;
  try {
    return parseTradingEvent({
      schemaVersion: 1,
      eventId: input.eventId,
      type: input.type,
      source: "trading-domain",
      at: input.at,
      agentRunId: input.agentRunId,
      correlationId: input.correlationId,
      environment: input.environment,
      instrument: "XAUUSD",
      actor: input.actor,
      payload: input.payload,
      nextState: input.nextState,
      runtimeThreadId: input.runtimeThreadId ?? undefined,
      runtimeTurnId: input.runtimeTurnId ?? undefined,
    });
  } catch {
    return null;
  }
}
