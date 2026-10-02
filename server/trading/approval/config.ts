import { contentHash } from "../replay/hash.ts";

/** Approval schema. maxAgeMs is required. There is no hidden timeout. */
export const APPROVAL_ENGINE_VERSION = "xauusd-approval-1" as const;

export interface ApprovalConfig {
  readonly version: string;
  readonly maxAgeMs: number;
}

const KEYS = new Set(["version", "maxAgeMs"]);

export function parseApprovalConfig(
  value: unknown,
): { ok: true; config: ApprovalConfig; configId: string } | { ok: false; missingFreshness: boolean } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, missingFreshness: false };
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KEYS.has(key)) return { ok: false, missingFreshness: false };
  }
  if (typeof record.version !== "string") return { ok: false, missingFreshness: false };
  const version = record.version.trim();
  if (version.length < 1 || version.length > 128) return { ok: false, missingFreshness: false };
  if (record.maxAgeMs === undefined) return { ok: false, missingFreshness: true };
  if (typeof record.maxAgeMs !== "number" || !Number.isSafeInteger(record.maxAgeMs) || record.maxAgeMs <= 0) {
    return { ok: false, missingFreshness: false };
  }
  const config: ApprovalConfig = { version, maxAgeMs: record.maxAgeMs };
  const configId = `apcfg.${contentHash({ schema: APPROVAL_ENGINE_VERSION, ...config }).slice(0, 40)}`;
  return { ok: true, config, configId };
}
