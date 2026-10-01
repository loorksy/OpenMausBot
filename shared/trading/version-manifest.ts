import { z } from "zod";

import { tradingEnvironmentSchema, type TradingEnvironment } from "./environment.ts";
import { TradingDomainError } from "./errors.ts";
import { assertNoSecretFields, formatZodError, recordIdSchema, seal, TRADING_SCHEMA_VERSION, utcTimestampSchema, zodCode } from "./ids.ts";

/** Pins the versions a run reasoned under. Dataset version is required when
 * the caller marks the run as historical replay. */
export interface VersionManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly agentRunId: string;
  readonly environment: TradingEnvironment;
  readonly createdAt: string;
  readonly runtimeVersion: string;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly toolCatalogVersion: string;
  readonly riskVersion: string;
  readonly policyVersion: string;
  readonly featureDataVersion: string;
  readonly datasetVersion?: string;
}

const versionField = z.string().trim().min(1).max(128);

const versionManifestSchema = z.object({
  schemaVersion: z.literal(TRADING_SCHEMA_VERSION),
  id: recordIdSchema,
  agentRunId: recordIdSchema,
  environment: tradingEnvironmentSchema,
  createdAt: utcTimestampSchema,
  runtimeVersion: versionField,
  modelProvider: versionField,
  modelId: versionField,
  promptVersion: versionField,
  toolCatalogVersion: versionField,
  riskVersion: versionField,
  policyVersion: versionField,
  featureDataVersion: versionField,
  datasetVersion: versionField.optional(),
}).strict();

export function parseVersionManifest(value: unknown): VersionManifest {
  assertNoSecretFields(value, "version manifest");
  const parsed = versionManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new TradingDomainError(zodCode(parsed.error, "invalid_version_manifest"), formatZodError(parsed.error));
  }
  return seal(parsed.data);
}

/** Replay and backtest runs must name the dataset. A missing dataset fails closed. */
export function assertReplayDataset(manifest: VersionManifest): void {
  if (!manifest.datasetVersion) {
    throw new TradingDomainError(
      "invalid_version_manifest",
      "A historical run requires a dataset version",
    );
  }
}
