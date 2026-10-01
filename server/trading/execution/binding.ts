import { tradingEnvironmentSchema } from "../../../shared/trading/environment.ts";
import { recordIdSchema } from "../../../shared/trading/ids.ts";
import { XAUUSD_INSTRUMENT } from "../../../shared/trading/instrument.ts";

/** Explicit MetaApi account slot. This object holds no token and no account id. */
export const METAAPI_ACCOUNT_BINDING_VERSION = "xauusd-metaapi-account-1" as const;

export const METAAPI_PROVIDER_ID = "metaapi-cloud" as const;

export interface MetaApiAccountBinding {
  readonly schemaVersion: typeof METAAPI_ACCOUNT_BINDING_VERSION;
  readonly bindingId: string;
  readonly environment: "PAPER" | "LIVE";
  readonly credentialSlot: "paper" | "live";
  readonly brokerSymbol: "XAUUSD";
  readonly provider: typeof METAAPI_PROVIDER_ID;
  readonly region: string;
}

const KEYS = new Set([
  "schemaVersion",
  "bindingId",
  "environment",
  "credentialSlot",
  "brokerSymbol",
  "provider",
  "region",
]);

const REGION = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function parseMetaApiAccountBinding(value: unknown): MetaApiAccountBinding | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KEYS.has(key)) return null;
  }
  if (record.schemaVersion !== METAAPI_ACCOUNT_BINDING_VERSION) return null;
  if (typeof record.bindingId !== "string" || !recordIdSchema.safeParse(record.bindingId).success) return null;
  const environment = tradingEnvironmentSchema.safeParse(record.environment);
  if (!environment.success || (environment.data !== "PAPER" && environment.data !== "LIVE")) return null;
  const slot = environment.data === "PAPER" ? "paper" : "live";
  if (record.credentialSlot !== slot) return null;
  if (record.brokerSymbol !== XAUUSD_INSTRUMENT) return null;
  if (record.provider !== METAAPI_PROVIDER_ID) return null;
  if (typeof record.region !== "string" || !REGION.test(record.region)) return null;
  return {
    schemaVersion: METAAPI_ACCOUNT_BINDING_VERSION,
    bindingId: record.bindingId,
    environment: environment.data,
    credentialSlot: slot,
    brokerSymbol: "XAUUSD",
    provider: METAAPI_PROVIDER_ID,
    region: record.region,
  };
}
