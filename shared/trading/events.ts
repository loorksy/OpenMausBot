import type { RuntimeEvent } from "../runtime-events.ts";
import { z } from "zod";

import { tradingEnvironmentSchema, type TradingEnvironment } from "./environment.ts";
import { TradingDomainError } from "./errors.ts";
import { assertNoSecretFields, formatZodError, recordIdSchema, seal, TRADING_SCHEMA_VERSION, utcTimestampSchema, zodCode } from "./ids.ts";
import { xauUsdInstrumentSchema, type XauUsdInstrument } from "./instrument.ts";

/** Trading facts. These strings are disjoint from the harness RuntimeEvent
 * union. Correlation with a turn copies ids; it does not merge the unions. */
export const TRADING_EVENT_SOURCE = "trading-domain" as const;

export const TRADING_EVENT_TYPES = [
  "agent.started",
  "agent.thinking",
  "agent.tool.started",
  "agent.tool.completed",
  "agent.failed",
  "market.updated",
  "market.quote.updated",
  "market.candles.updated",
  "market.stale",
  "market.unavailable",
  "market.invalid",
  "market.provider_error",
  "market.snapshot.created",
  "market.replay.started",
  "market.replay.advanced",
  "market.replay.completed",
  "market.replay.failed",
  "analysis.started",
  "analysis.completed",
  "scenario.created",
  "decision.created",
  "decision.expired",
  "risk.check.started",
  "risk.check.passed",
  "risk.check.failed",
  "policy.check.passed",
  "policy.check.failed",
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.modified",
  "order.intent.created",
  "order.submitted",
  "order.accepted",
  "order.rejected",
  "order.filled",
  "position.opened",
  "position.updated",
  "position.closed",
  "reconciliation.started",
  "reconciliation.completed",
  "reconciliation.desynced",
  "agent.paused",
  "agent.resumed",
  "emergency.stop",
  "review.created",
  "memory.updated",
] as const;

export type TradingEventType = (typeof TRADING_EVENT_TYPES)[number];

export interface TradingEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly type: TradingEventType;
  readonly source: typeof TRADING_EVENT_SOURCE;
  readonly at: string;
  readonly agentRunId: string;
  readonly correlationId: string;
  readonly environment: TradingEnvironment;
  readonly instrument: XauUsdInstrument;
  readonly actor: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly prevState?: string;
  readonly nextState?: string;
  readonly runtimeEventId?: string;
  readonly runtimeThreadId?: string;
  readonly runtimeTurnId?: string;
}

const tradingEventSchema = z.object({
  schemaVersion: z.literal(TRADING_SCHEMA_VERSION),
  eventId: recordIdSchema,
  type: z.enum(TRADING_EVENT_TYPES),
  source: z.literal(TRADING_EVENT_SOURCE),
  at: utcTimestampSchema,
  agentRunId: recordIdSchema,
  correlationId: recordIdSchema,
  environment: tradingEnvironmentSchema,
  instrument: xauUsdInstrumentSchema,
  actor: z.string().trim().min(1).max(128),
  payload: z.record(z.string(), z.unknown()).default({}),
  prevState: z.string().trim().min(1).max(80).optional(),
  nextState: z.string().trim().min(1).max(80).optional(),
  runtimeEventId: recordIdSchema.optional(),
  runtimeThreadId: recordIdSchema.optional(),
  runtimeTurnId: recordIdSchema.optional(),
}).strict();

export function parseTradingEvent(value: unknown): TradingEvent {
  assertNoSecretFields(value, "trading event");
  const parsed = tradingEventSchema.safeParse(value);
  if (!parsed.success) {
    throw new TradingDomainError(zodCode(parsed.error, "invalid_event"), formatZodError(parsed.error));
  }
  return seal(parsed.data);
}

export function isTradingEvent(value: unknown): value is TradingEvent {
  if (value === null || typeof value !== "object") return false;
  const record = value as { source?: unknown; type?: unknown };
  return record.source === TRADING_EVENT_SOURCE
    && typeof record.type === "string"
    && (TRADING_EVENT_TYPES as readonly string[]).includes(record.type);
}

type TradingRuntimeOverlap = Extract<TradingEvent["type"], RuntimeEvent["type"]>;
export const tradingEventsAreNotRuntimeEvents: [TradingRuntimeOverlap] extends [never] ? true : never = true;
