import { z } from "zod";

import { tradingEnvironmentSchema, type TradingEnvironment } from "./environment.ts";
import { TradingDomainError } from "./errors.ts";
import { assertNoSecretFields, formatZodError, recordIdSchema, seal, TRADING_SCHEMA_VERSION, utcTimestampSchema, zodCode } from "./ids.ts";
import { xauUsdInstrumentSchema, type XauUsdInstrument } from "./instrument.ts";

/** First-class outcomes. BUY and SELL are not the decision vocabulary. */
export const DECISION_DIRECTIONS = [
  "LONG",
  "SHORT",
  "NO_TRADE",
  "WAIT",
  "MANAGE_EXISTING_POSITION",
  "EXIT_EXISTING_POSITION",
] as const;

export type DecisionDirection = (typeof DECISION_DIRECTIONS)[number];

export const DECISION_STATUSES = [
  "DRAFT",
  "VALIDATING",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
  "EXECUTED",
] as const;

export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const EVIDENCE_QUALITIES = ["insufficient", "low", "mixed", "high"] as const;

export type EvidenceQuality = (typeof EVIDENCE_QUALITIES)[number];

/** Immutable reasoning record. Status EXECUTED means the decision lifecycle
 * completed. It is not a broker fill and it does not submit an order. */
export interface Decision {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly agentRunId: string;
  readonly environment: TradingEnvironment;
  readonly instrument: XauUsdInstrument;
  readonly createdAt: string;
  readonly supersedes?: string;
  readonly status: DecisionStatus;
  readonly thesis: string;
  readonly contextId: string;
  readonly snapshotId: string;
  readonly evidenceIds: readonly string[];
  readonly supportingEvidenceIds: readonly string[];
  readonly contradictingEvidenceIds: readonly string[];
  readonly missingInformation: readonly string[];
  readonly regimeId?: string;
  readonly scenarioId?: string;
  readonly direction: DecisionDirection;
  readonly trigger?: string;
  readonly entryConditions?: string;
  readonly invalidation?: string;
  readonly stop?: number;
  readonly targets: readonly number[];
  readonly riskIntent?: string;
  readonly policyConditions?: string;
  readonly expiry: string;
  readonly evidenceQuality: EvidenceQuality;
  readonly versionManifestId: string;
}

const text = (max: number) => z.string().trim().min(1).max(max);
const idList = z.array(recordIdSchema).max(50);
const price = z.number().finite().positive();

const decisionSchema = z.object({
  schemaVersion: z.literal(TRADING_SCHEMA_VERSION),
  id: recordIdSchema,
  agentRunId: recordIdSchema,
  environment: tradingEnvironmentSchema,
  instrument: xauUsdInstrumentSchema,
  createdAt: utcTimestampSchema,
  supersedes: recordIdSchema.optional(),
  status: z.enum(DECISION_STATUSES),
  thesis: text(8_000),
  contextId: recordIdSchema,
  snapshotId: recordIdSchema,
  evidenceIds: idList,
  supportingEvidenceIds: idList,
  contradictingEvidenceIds: idList,
  missingInformation: z.array(text(500)).max(20),
  regimeId: recordIdSchema.optional(),
  scenarioId: recordIdSchema.optional(),
  direction: z.enum(DECISION_DIRECTIONS, { error: "direction is not a decision outcome" }),
  trigger: text(2_000).optional(),
  entryConditions: text(2_000).optional(),
  invalidation: text(2_000).optional(),
  stop: price.optional(),
  targets: z.array(price).max(8),
  riskIntent: text(2_000).optional(),
  policyConditions: text(2_000).optional(),
  expiry: utcTimestampSchema,
  evidenceQuality: z.enum(EVIDENCE_QUALITIES),
  versionManifestId: recordIdSchema,
}).strict();

const DECISION_EDGES: Record<DecisionStatus, readonly DecisionStatus[]> = {
  DRAFT: ["VALIDATING", "REJECTED", "EXPIRED"],
  VALIDATING: ["APPROVED", "REJECTED", "EXPIRED"],
  APPROVED: ["EXECUTED", "EXPIRED", "REJECTED"],
  REJECTED: [],
  EXPIRED: [],
  EXECUTED: [],
};

export function parseDecision(value: unknown): Decision {
  assertNoSecretFields(value, "decision");
  const parsed = decisionSchema.safeParse(value);
  if (!parsed.success) {
    throw new TradingDomainError(zodCode(parsed.error, "invalid_decision"), formatZodError(parsed.error));
  }
  return seal(parsed.data);
}

/** Status changes are new records. The previous decision stays as it was. */
export function transitionDecision(
  previous: Decision,
  status: DecisionStatus,
  revision: { readonly id: string; readonly createdAt: string },
): Decision {
  if (!DECISION_EDGES[previous.status].includes(status)) {
    throw new TradingDomainError(
      "invalid_decision",
      `Cannot move a decision from ${previous.status} to ${status}`,
    );
  }
  return parseDecision({
    ...previous,
    id: revision.id,
    createdAt: revision.createdAt,
    status,
    supersedes: previous.id,
  });
}
