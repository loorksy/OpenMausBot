import { z } from "zod";

import { TradingDomainError } from "./errors.ts";
import type { TradingEnvironment } from "./environment.ts";
import { tradingEnvironmentSchema } from "./environment.ts";
import { assertNoSecretFields, formatZodError, recordIdSchema, seal, TRADING_SCHEMA_VERSION, utcTimestampSchema, zodCode } from "./ids.ts";

/** External content is data. The only legal trust value is `external`. */
export const EVIDENCE_KINDS = [
  "news",
  "website",
  "pdf",
  "calendar",
  "social",
  "broker_message",
  "tool_output",
  "memory",
  "other",
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface Evidence {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly agentRunId: string;
  readonly environment: TradingEnvironment;
  readonly createdAt: string;
  readonly supersedes?: string;
  readonly trust: "external";
  readonly untrusted: true;
  readonly kind: EvidenceKind;
  readonly sourceUrl?: string;
  readonly provider?: string;
  readonly providerTimestamp?: string;
  readonly receivedAt: string;
  readonly contentHash: string;
  readonly excerpt: string;
}

const evidenceSchema = z.object({
  schemaVersion: z.literal(TRADING_SCHEMA_VERSION),
  id: recordIdSchema,
  agentRunId: recordIdSchema,
  environment: tradingEnvironmentSchema,
  createdAt: utcTimestampSchema,
  supersedes: recordIdSchema.optional(),
  trust: z.literal("external", { error: "evidence trust must be external" }),
  untrusted: z.literal(true, { error: "evidence must be marked untrusted" }),
  kind: z.enum(EVIDENCE_KINDS),
  sourceUrl: z.string().trim().min(1).max(2_000).optional(),
  provider: z.string().trim().min(1).max(200).optional(),
  providerTimestamp: utcTimestampSchema.optional(),
  receivedAt: utcTimestampSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/, "contentHash must be a sha256 hex digest"),
  excerpt: z.string().trim().min(1).max(8_000),
}).strict();

export function parseEvidence(value: unknown): Evidence {
  assertNoSecretFields(value, "evidence");
  const parsed = evidenceSchema.safeParse(value);
  if (!parsed.success) {
    throw new TradingDomainError(zodCode(parsed.error, "invalid_evidence"), formatZodError(parsed.error));
  }
  return seal(parsed.data);
}
