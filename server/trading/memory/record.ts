import { assertNoSecretFields, recordIdSchema, seal, utcTimestampSchema } from "../../../shared/trading/ids.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { contentHash } from "../replay/hash.ts";

/** Trading memory is separate from chat history. Version `xauusd-memory-1`. */
export const TRADING_MEMORY_VERSION = "xauusd-memory-1" as const;

export const MEMORY_KINDS = ["FACT", "INTERPRETATION", "USER_FEEDBACK"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const LEARNING_TARGETS = ["prompt", "context", "retrieval", "routing", "specialist", "explanation"] as const;
export type LearningTarget = (typeof LEARNING_TARGETS)[number];

const SAFETY_FIELDS = new Set([
  "maxriskpercent",
  "maxpositionquantity",
  "killswitch",
  "approval",
  "firetime",
  "broker",
  "policy",
  "instrument",
  "autonomy",
  "permissions",
]);

export interface TradingMemoryRecord {
  readonly schemaVersion: typeof TRADING_MEMORY_VERSION;
  readonly recordId: string;
  readonly occurrenceId: string;
  readonly agentRunId: string;
  readonly environment: TradingEnvironment;
  readonly kind: MemoryKind;
  readonly revision: number;
  readonly supersedes: string | null;
  readonly recordedAt: string;
  readonly body: string;
}

export function tradingMemoryRecord(input: {
  readonly occurrenceId: string;
  readonly agentRunId: string;
  readonly environment: TradingEnvironment;
  readonly kind: MemoryKind;
  readonly revision: number;
  readonly supersedes: string | null;
  readonly recordedAt: string;
  readonly body: string;
}): TradingMemoryRecord {
  if (!recordIdSchema.safeParse(input.occurrenceId).success || !recordIdSchema.safeParse(input.agentRunId).success) {
    throw new TradingDomainError("trading_store_rejected", "Trading memory identity was rejected. Failing closed.");
  }
  if (!(MEMORY_KINDS as readonly string[]).includes(input.kind)) {
    throw new TradingDomainError("trading_store_rejected", "Trading memory kind was rejected. Failing closed.");
  }
  if (!Number.isInteger(input.revision) || input.revision < 1) {
    throw new TradingDomainError("trading_store_rejected", "Trading memory revision was rejected. Failing closed.");
  }
  if (!utcTimestampSchema.safeParse(input.recordedAt).success || input.body.trim().length === 0) {
    throw new TradingDomainError("trading_store_rejected", "Trading memory body was rejected. Failing closed.");
  }
  const record = seal({
    schemaVersion: TRADING_MEMORY_VERSION,
    recordId: `mem.${contentHash({
      schema: TRADING_MEMORY_VERSION,
      occurrenceId: input.occurrenceId,
      kind: input.kind,
      revision: input.revision,
      body: input.body,
    }).slice(0, 40)}`,
    occurrenceId: input.occurrenceId,
    agentRunId: input.agentRunId,
    environment: input.environment,
    kind: input.kind,
    revision: input.revision,
    supersedes: input.supersedes,
    recordedAt: input.recordedAt,
    body: input.body.trim().slice(0, 2000),
  });
  assertNoSecretFields(record, "trading memory");
  return record;
}

/** Learning may name a prompt or retrieval change. Safety configuration is
 * rejected and is not rewritten. */
export function proposeLearningChange(input: {
  readonly target: string;
  readonly fields: readonly string[];
  readonly note: string;
  readonly recordedAt: string;
}): { readonly accepted: true; readonly revisionId: string; readonly target: LearningTarget } | { readonly accepted: false; readonly reason: "SAFETY_IMMUTABLE" | "TARGET_REJECTED" } {
  const fields = input.fields.map((field) => field.toLowerCase().replace(/[^a-z]/g, ""));
  if (fields.some((field) => SAFETY_FIELDS.has(field))) return { accepted: false, reason: "SAFETY_IMMUTABLE" };
  if (!(LEARNING_TARGETS as readonly string[]).includes(input.target)) return { accepted: false, reason: "TARGET_REJECTED" };
  if (!utcTimestampSchema.safeParse(input.recordedAt).success) return { accepted: false, reason: "TARGET_REJECTED" };
  return {
    accepted: true,
    target: input.target as LearningTarget,
    revisionId: `learn.${contentHash({
      schema: TRADING_MEMORY_VERSION,
      target: input.target,
      fields,
      note: input.note,
      recordedAt: input.recordedAt,
    }).slice(0, 40)}`,
  };
}
