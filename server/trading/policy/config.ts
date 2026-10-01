import { contentHash } from "../replay/hash.ts";

/** Policy schema. The version label is the caller's. The hash also pins this
 * schema so two labels of the same text under different schemas do not match. */
export const POLICY_ENGINE_VERSION = "xauusd-policy-1" as const;

export interface PolicyConfig {
  readonly version: string;
}

export function parsePolicyConfig(value: unknown): { ok: true; config: PolicyConfig; configId: string } | { ok: false } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false };
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "version")) return { ok: false };
  if (typeof record.version !== "string") return { ok: false };
  const version = record.version.trim();
  if (version.length < 1 || version.length > 128) return { ok: false };
  const config = { version };
  const configId = `policy.${contentHash({ schema: POLICY_ENGINE_VERSION, version }).slice(0, 40)}`;
  return { ok: true, config, configId };
}
