import { z } from "zod";

import { TradingDomainError } from "./errors.ts";
import { assertNoSecretFields, formatZodError, seal, zodCode } from "./ids.ts";
import { checkFields, failClosedMatchesStatus, type CheckStatus } from "./risk.ts";
import type { TradingEnvironment } from "./environment.ts";
import type { XauUsdInstrument } from "./instrument.ts";

/** Result shape for a later deterministic policy engine. This module does
 * not decide whether a trade is allowed. */
export interface PolicyCheck {
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

const policyCheckSchema = z.object(checkFields).strict().superRefine(failClosedMatchesStatus);

export function parsePolicyCheck(value: unknown): PolicyCheck {
  assertNoSecretFields(value, "policy check");
  const parsed = policyCheckSchema.safeParse(value);
  if (!parsed.success) {
    throw new TradingDomainError(zodCode(parsed.error, "invalid_policy_check"), formatZodError(parsed.error));
  }
  return seal(parsed.data);
}
