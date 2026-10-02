import { z } from "zod";

import { tradingEnvironmentSchema, type TradingEnvironment } from "./environment.ts";
import { TradingDomainError } from "./errors.ts";
import { assertNoSecretFields, formatZodError, recordIdSchema, seal, TRADING_SCHEMA_VERSION, utcTimestampSchema, zodCode } from "./ids.ts";
import { xauUsdInstrumentSchema, type XauUsdInstrument } from "./instrument.ts";

/** Result shape for a later deterministic risk engine. UNAVAILABLE and FAILED
 * must fail closed. This module does not calculate size or equity risk. */
export const CHECK_STATUSES = ["PASSED", "FAILED", "UNAVAILABLE"] as const;

export type CheckStatus = (typeof CHECK_STATUSES)[number];

export interface RiskCheck {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly agentRunId: string;
  readonly environment: TradingEnvironment;
  readonly instrument: XauUsdInstrument;
  readonly decisionId: string;
  readonly snapshotId: string;
  readonly versionManifestId: string;
  readonly status: CheckStatus;
  readonly failClosed: boolean;
  readonly reasons: readonly string[];
  readonly createdAt: string;
}

const checkFields = {
  schemaVersion: z.literal(TRADING_SCHEMA_VERSION),
  id: recordIdSchema,
  agentRunId: recordIdSchema,
  environment: tradingEnvironmentSchema,
  instrument: xauUsdInstrumentSchema,
  decisionId: recordIdSchema,
  snapshotId: recordIdSchema,
  versionManifestId: recordIdSchema,
  status: z.enum(CHECK_STATUSES),
  failClosed: z.boolean(),
  reasons: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  createdAt: utcTimestampSchema,
};

const riskCheckSchema = z.object(checkFields).strict().superRefine(failClosedMatchesStatus);

export function parseRiskCheck(value: unknown): RiskCheck {
  assertNoSecretFields(value, "risk check");
  const parsed = riskCheckSchema.safeParse(value);
  if (!parsed.success) {
    throw new TradingDomainError(zodCode(parsed.error, "invalid_risk_check"), formatZodError(parsed.error));
  }
  return seal(parsed.data);
}

export function failClosedMatchesStatus(
  value: { status: CheckStatus; failClosed: boolean },
  ctx: z.RefinementCtx,
): void {
  const mustClose = value.status !== "PASSED";
  if (value.failClosed !== mustClose) {
    ctx.addIssue({
      code: "custom",
      path: ["failClosed"],
      message: value.status === "PASSED"
        ? "a passed check is not fail-closed"
        : `${value.status} must fail closed`,
    });
  }
}

export { checkFields };
