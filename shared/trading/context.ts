import { z } from "zod";

import { assertProvenanceForEnvironment, provenanceStatusSchema, tradingEnvironmentSchema, type ProvenanceStatus, type TradingEnvironment } from "./environment.ts";
import { TradingDomainError } from "./errors.ts";
import { assertNoSecretFields, formatZodError, recordIdSchema, seal, TRADING_SCHEMA_VERSION, utcTimestampSchema, zodCode } from "./ids.ts";
import { xauUsdInstrumentSchema, type XauUsdInstrument } from "./instrument.ts";

/** Structured XAUUSD context. It points at a snapshot and evidence records.
 * It does not embed a raw candle dump or grant any authority. */
export interface XauUsdContext {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly agentRunId: string;
  readonly environment: TradingEnvironment;
  readonly instrument: XauUsdInstrument;
  readonly snapshotId: string;
  readonly evidenceIds: readonly string[];
  readonly versionManifestId: string;
  readonly asOf: string;
  readonly provenance: ProvenanceStatus;
  readonly createdAt: string;
  readonly supersedes?: string;
  readonly session?: string;
}

const contextSchema = z.object({
  schemaVersion: z.literal(TRADING_SCHEMA_VERSION),
  id: recordIdSchema,
  agentRunId: recordIdSchema,
  environment: tradingEnvironmentSchema,
  instrument: xauUsdInstrumentSchema,
  snapshotId: recordIdSchema,
  evidenceIds: z.array(recordIdSchema).max(50),
  versionManifestId: recordIdSchema,
  asOf: utcTimestampSchema,
  provenance: provenanceStatusSchema,
  createdAt: utcTimestampSchema,
  supersedes: recordIdSchema.optional(),
  session: z.string().trim().min(1).max(80).optional(),
}).strict();

export function parseXauUsdContext(value: unknown): XauUsdContext {
  assertNoSecretFields(value, "trading context");
  const parsed = contextSchema.safeParse(value);
  if (!parsed.success) {
    throw new TradingDomainError(zodCode(parsed.error, "invalid_context"), formatZodError(parsed.error));
  }
  assertProvenanceForEnvironment(parsed.data.environment, parsed.data.provenance);
  return seal(parsed.data);
}
