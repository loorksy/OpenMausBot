import { z } from "zod";

import { tradingEnvironmentSchema, type TradingEnvironment } from "./environment.ts";
import { TradingDomainError } from "./errors.ts";
import { formatZodError, recordIdSchema, seal, TRADING_SCHEMA_VERSION, utcTimestampSchema, zodCode } from "./ids.ts";

/** Separate from provider approvalMode (ask / edits / auto / full / custom).
 * No level in this contract submits to a broker. */
export const AUTONOMY_LEVELS = [0, 1, 2, 3, 4, 5] as const;

export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const AUTONOMY_NAMES = {
  0: "OBSERVE",
  1: "ANALYZE",
  2: "RECOMMEND",
  3: "REQUIRE_APPROVAL",
  4: "EXECUTE_UNDER_POLICY",
  5: "AUTONOMOUS_MONITORING",
} as const;

export type AutonomyName = (typeof AUTONOMY_NAMES)[AutonomyLevel];

export interface AutonomyState {
  readonly schemaVersion: 1;
  readonly environment: TradingEnvironment;
  readonly level: AutonomyLevel;
  readonly name: AutonomyName;
  readonly agentRunId: string;
  readonly updatedAt: string;
}

const autonomyStateSchema = z.object({
  schemaVersion: z.literal(TRADING_SCHEMA_VERSION),
  environment: tradingEnvironmentSchema,
  level: z.union([
    z.literal(0),
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
  ]),
  name: z.enum([
    "OBSERVE",
    "ANALYZE",
    "RECOMMEND",
    "REQUIRE_APPROVAL",
    "EXECUTE_UNDER_POLICY",
    "AUTONOMOUS_MONITORING",
  ]),
  agentRunId: recordIdSchema,
  updatedAt: utcTimestampSchema,
}).strict().superRefine((value, ctx) => {
  if (AUTONOMY_NAMES[value.level] !== value.name) {
    ctx.addIssue({ code: "custom", path: ["name"], message: "autonomy name does not match the level" });
  }
});

export function parseAutonomyState(value: unknown): AutonomyState {
  const parsed = autonomyStateSchema.safeParse(value);
  if (!parsed.success) {
    throw new TradingDomainError(zodCode(parsed.error, "autonomy_rejected"), formatZodError(parsed.error));
  }
  return seal(parsed.data);
}

/** Autonomy never grants a direct broker submit. The execution gate, which
 * is not implemented in this phase, is the only future submit path. */
export function autonomyAllowsDirectSubmit(_level: AutonomyLevel): false {
  return false;
}
