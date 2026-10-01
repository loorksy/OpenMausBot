import { z } from "zod";

import { TradingDomainError, type TradingErrorCode } from "./errors.ts";

/** Contract generation. The trading-store schema version is separate. */
export const TRADING_SCHEMA_VERSION = 1 as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export const recordIdSchema = z.string().trim().min(1).max(128).regex(ID_PATTERN, "id is empty or uses unsupported characters");

export const utcTimestampSchema = z.string().regex(UTC_PATTERN, "timestamp must be an ISO-8601 UTC instant ending in Z").refine(
  (value) => !Number.isNaN(Date.parse(value)),
  "timestamp is not a real instant",
);

export type RecordId = string;
export type AgentRunId = string;
export type UtcTimestamp = string;

/** Object keys that must never appear on a trading record. Matched by
 * normalized key, not by scanning free-text evidence. */
const SECRET_KEYS = new Set([
  "apikey",
  "apisecret",
  "authorization",
  "brokercredentials",
  "credential",
  "credentials",
  "password",
  "secret",
  "token",
]);

export function assertNoSecretFields(value: unknown, label = "trading record"): void {
  walk(value, label, 0);
}

function walk(value: unknown, label: string, depth: number): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, label, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(key.toLowerCase().replace(/[_-]/g, ""))) {
      throw new TradingDomainError(
        "credentials_forbidden",
        `${label} cannot carry broker credentials or secret fields`,
      );
    }
    walk(child, label, depth + 1);
  }
}

export function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "value";
    return `${path}: ${issue.message}`;
  }).join("; ");
}

export function zodCode(error: z.ZodError, fallback: TradingErrorCode): TradingErrorCode {
  const paths = new Set(error.issues.flatMap((issue) => issue.path.map(String)));
  if (paths.has("instrument")) return "instrument_rejected";
  if (paths.has("executable") || paths.has("brokerSubmit") || paths.has("kind")) return "order_intent_not_executable";
  if (paths.has("agentRunId")) return "agent_run_required";
  if (paths.has("liveExecutionEnabled") || paths.has("brokerNetworkEnabled")) return "live_execution_disabled";
  if (paths.has("credentialSlot")) return "environment_isolation";
  if (paths.has("trust") || paths.has("untrusted")) return "invalid_evidence";
  return fallback;
}

export function seal<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) seal(child);
    Object.freeze(value);
  }
  return value;
}
