import { contentHash } from "../replay/hash.ts";

/** Fire-time schema. maxMarketAgeMs is required. There is no hidden age. */
export const GATE_ENGINE_VERSION = "xauusd-gate-1" as const;

export interface GateConfig {
  readonly version: string;
  readonly maxMarketAgeMs: number;
}

const KEYS = new Set(["version", "maxMarketAgeMs"]);

export function parseGateConfig(
  value: unknown,
): { ok: true; config: GateConfig; configId: string } | { ok: false; missingFreshness: boolean } {
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
  if (record.maxMarketAgeMs === undefined) return { ok: false, missingFreshness: true };
  if (
    typeof record.maxMarketAgeMs !== "number"
    || !Number.isSafeInteger(record.maxMarketAgeMs)
    || record.maxMarketAgeMs <= 0
  ) {
    return { ok: false, missingFreshness: false };
  }
  const config: GateConfig = { version, maxMarketAgeMs: record.maxMarketAgeMs };
  const configId = `gtcfg.${contentHash({ schema: GATE_ENGINE_VERSION, ...config }).slice(0, 40)}`;
  return { ok: true, config, configId };
}
