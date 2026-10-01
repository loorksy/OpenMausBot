import { z } from "zod";

import { tradingEnvironmentSchema, type TradingEnvironment } from "./environment.ts";
import { TradingDomainError } from "./errors.ts";
import { formatZodError, recordIdSchema, seal, TRADING_SCHEMA_VERSION, utcTimestampSchema, zodCode } from "./ids.ts";

/** Durable switch state. Reading it does not start a runtime enforcer.
 * A missing or malformed state fails closed. An engaged switch blocks. */
export interface KillSwitchState {
  readonly schemaVersion: 1;
  readonly environment: TradingEnvironment;
  readonly engaged: boolean;
  readonly agentRunId: string;
  readonly updatedAt: string;
  readonly source: "operator" | "system";
}

const killSwitchStateSchema = z.object({
  schemaVersion: z.literal(TRADING_SCHEMA_VERSION),
  environment: tradingEnvironmentSchema,
  engaged: z.boolean(),
  agentRunId: recordIdSchema,
  updatedAt: utcTimestampSchema,
  source: z.enum(["operator", "system"]),
}).strict();

export function parseKillSwitchState(value: unknown): KillSwitchState {
  const parsed = killSwitchStateSchema.safeParse(value);
  if (!parsed.success) {
    throw new TradingDomainError(zodCode(parsed.error, "kill_switch_unknown"), formatZodError(parsed.error));
  }
  return seal(parsed.data);
}

export function assertSubmitNotBlockedByKnownSwitch(state: KillSwitchState): void {
  if (state.engaged) {
    throw new TradingDomainError("kill_switch_engaged", "Kill switch is engaged");
  }
}

/** When the caller has no state object, the safe reading is engaged. */
export function unknownKillSwitchBlocks(): true {
  return true;
}
