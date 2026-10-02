import { z } from "zod";

import { tradingEnvironmentSchema, type TradingEnvironment } from "./environment.ts";
import { TradingDomainError } from "./errors.ts";
import { assertNoSecretFields, formatZodError, recordIdSchema, seal, TRADING_SCHEMA_VERSION, utcTimestampSchema, zodCode } from "./ids.ts";
import { xauUsdInstrumentSchema, type XauUsdInstrument } from "./instrument.ts";

/** Directions that may be proposed. NO_TRADE and WAIT are decisions, not intents. */
export const ORDER_INTENT_DIRECTIONS = [
  "LONG",
  "SHORT",
  "MANAGE_EXISTING_POSITION",
  "EXIT_EXISTING_POSITION",
] as const;

export type OrderIntentDirection = (typeof ORDER_INTENT_DIRECTIONS)[number];

/** A proposal that a later execution gate may consider. `executable` and
 * `brokerSubmit` are fixed false. The record has no broker credentials and
 * no submit capability. */
export interface OrderIntent {
  readonly schemaVersion: 1;
  readonly kind: "order-intent";
  readonly id: string;
  readonly agentRunId: string;
  readonly environment: TradingEnvironment;
  readonly instrument: XauUsdInstrument;
  readonly decisionId: string;
  readonly createdAt: string;
  readonly direction: OrderIntentDirection;
  readonly executable: false;
  readonly brokerSubmit: false;
  readonly entry?: number;
  readonly stop?: number;
  readonly targets: readonly number[];
  readonly riskCheckId?: string;
  readonly policyCheckId?: string;
}

const price = z.number().finite().positive();

const orderIntentSchema = z.object({
  schemaVersion: z.literal(TRADING_SCHEMA_VERSION),
  kind: z.literal("order-intent", { error: "record must be an order intent, not a broker submit" }),
  id: recordIdSchema,
  agentRunId: recordIdSchema,
  environment: tradingEnvironmentSchema,
  instrument: xauUsdInstrumentSchema,
  decisionId: recordIdSchema,
  createdAt: utcTimestampSchema,
  direction: z.enum(ORDER_INTENT_DIRECTIONS, { error: "NO_TRADE and WAIT are not order intents" }),
  executable: z.literal(false, { error: "an order intent is not executable" }),
  brokerSubmit: z.literal(false, { error: "an order intent cannot submit to a broker" }),
  entry: price.optional(),
  stop: price.optional(),
  targets: z.array(price).max(8),
  riskCheckId: recordIdSchema.optional(),
  policyCheckId: recordIdSchema.optional(),
}).strict();

export function parseOrderIntent(value: unknown): OrderIntent {
  assertNoSecretFields(value, "order intent");
  const parsed = orderIntentSchema.safeParse(value);
  if (!parsed.success) {
    throw new TradingDomainError(zodCode(parsed.error, "invalid_order_intent"), formatZodError(parsed.error));
  }
  return seal(parsed.data);
}

type _ExecutableIsFalse = [OrderIntent["executable"]] extends [false] ? true : never;
type _BrokerSubmitIsFalse = [OrderIntent["brokerSubmit"]] extends [false] ? true : never;

export const orderIntentCannotExecute: _ExecutableIsFalse = true;
export const orderIntentCannotSubmit: _BrokerSubmitIsFalse = true;
