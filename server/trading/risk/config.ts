import { contentHash } from "../replay/hash.ts";
import { XAUUSD_CONTRACT_VERSION } from "./contract.ts";

/** Risk calculation schema. Configuration identity hashes this with the
 * contract version and the caller's version label. No clock and no random id. */
export const RISK_ENGINE_VERSION = "xauusd-risk-1" as const;

export interface RiskConfig {
  readonly version: string;
  readonly maxRiskPercent: number;
  readonly maxRiskAmount: number | null;
  readonly maxPositionQuantity: number | null;
  readonly minPositionQuantity: number | null;
  readonly quantityStep: number | null;
  readonly maxOpenExposure: number | null;
  readonly maxConcurrentRisk: number | null;
  readonly requireStop: true;
  readonly maxSpread: number | null;
  readonly rejectStaleMarket: boolean;
}

const CONFIG_KEYS = new Set([
  "version",
  "maxRiskPercent",
  "maxRiskAmount",
  "maxPositionQuantity",
  "minPositionQuantity",
  "quantityStep",
  "maxOpenExposure",
  "maxConcurrentRisk",
  "requireStop",
  "maxSpread",
  "rejectStaleMarket",
]);

function optionalPositive(value: unknown): number | null | "bad" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "bad";
  return value;
}

export function parseRiskConfig(value: unknown): { ok: true; config: RiskConfig; configId: string } | { ok: false } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false };
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!CONFIG_KEYS.has(key)) return { ok: false };
  }
  if (typeof record.version !== "string") return { ok: false };
  const version = record.version.trim();
  if (version.length < 1 || version.length > 128) return { ok: false };
  if (typeof record.maxRiskPercent !== "number" || !Number.isFinite(record.maxRiskPercent)) return { ok: false };
  if (record.maxRiskPercent <= 0 || record.maxRiskPercent > 1) return { ok: false };
  if (record.requireStop !== true) return { ok: false };
  const maxRiskAmount = optionalPositive(record.maxRiskAmount);
  const maxPositionQuantity = optionalPositive(record.maxPositionQuantity);
  const minPositionQuantity = optionalPositive(record.minPositionQuantity);
  const quantityStep = optionalPositive(record.quantityStep);
  const maxOpenExposure = optionalPositive(record.maxOpenExposure);
  const maxConcurrentRisk = optionalPositive(record.maxConcurrentRisk);
  const maxSpread = optionalPositive(record.maxSpread);
  if (
    maxRiskAmount === "bad"
    || maxPositionQuantity === "bad"
    || minPositionQuantity === "bad"
    || quantityStep === "bad"
    || maxOpenExposure === "bad"
    || maxConcurrentRisk === "bad"
    || maxSpread === "bad"
  ) {
    return { ok: false };
  }
  if (record.rejectStaleMarket !== undefined && typeof record.rejectStaleMarket !== "boolean") return { ok: false };
  if (
    minPositionQuantity !== null
    && maxPositionQuantity !== null
    && minPositionQuantity > maxPositionQuantity
  ) {
    return { ok: false };
  }
  const config: RiskConfig = {
    version,
    maxRiskPercent: record.maxRiskPercent,
    maxRiskAmount,
    maxPositionQuantity,
    minPositionQuantity,
    quantityStep,
    maxOpenExposure,
    maxConcurrentRisk,
    requireStop: true,
    maxSpread,
    rejectStaleMarket: record.rejectStaleMarket === true,
  };
  const configId = `cfg.${contentHash({
    schema: RISK_ENGINE_VERSION,
    contract: XAUUSD_CONTRACT_VERSION,
    ...config,
  }).slice(0, 40)}`;
  return { ok: true, config, configId };
}
