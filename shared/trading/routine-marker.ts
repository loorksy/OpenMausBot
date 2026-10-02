import { AUTONOMY_LEVELS, type AutonomyLevel } from "./autonomy.ts";
import { parseTradingEnvironment, type TradingEnvironment } from "./environment.ts";
import { TradingDomainError } from "./errors.ts";
import { assertNoSecretFields, seal } from "./ids.ts";
import { TRADING_PERMISSIONS, type TradingPermission } from "./permissions.ts";

/** Optional declaration on a native Routine. It is not an execution grant,
 * a broker credential, a market-data provider, or an approval. */
export interface XauUsdRoutineMarker {
  readonly environment: TradingEnvironment;
  readonly autonomyLevel: AutonomyLevel;
  readonly permissions: readonly TradingPermission[];
}

const MARKER_KEYS = new Set(["environment", "autonomyLevel", "permissions"]);

/** Keys the shared secret walk does not already name. Normalized by
 * lower-casing and removing `_` and `-`. */
const MARKER_SECRET_KEYS = new Set([
  "account",
  "accountid",
  "brokeraccount",
  "brokeraccountid",
  "brokertoken",
  "metaapitoken",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

function rejectMarkerSecrets(value: unknown, depth: number): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) rejectMarkerSecrets(item, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (MARKER_SECRET_KEYS.has(normalizedKey(key))) {
      throw new TradingDomainError(
        "credentials_forbidden",
        "XAUUSD routine marker cannot carry broker credentials or secret fields",
      );
    }
    rejectMarkerSecrets(child, depth + 1);
  }
}

/** Fail closed. Absent is not a marker; a present marker that is incomplete,
 * names another instrument, or carries a secret is rejected whole. */
export function parseXauUsdRoutineMarker(value: unknown): XauUsdRoutineMarker {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TradingDomainError("tool_rejected", "XAUUSD routine marker was rejected. Failing closed.");
  }
  assertNoSecretFields(value, "XAUUSD routine marker");
  rejectMarkerSecrets(value, 0);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === "symbol" || key === "instrument") {
      throw new TradingDomainError(
        "instrument_rejected",
        "XAUUSD routine marker cannot name another instrument",
      );
    }
    if (!MARKER_KEYS.has(key)) {
      throw new TradingDomainError(
        "tool_rejected",
        "XAUUSD routine marker contains an unsupported field. Failing closed.",
      );
    }
  }
  if (!Object.hasOwn(record, "environment") || !Object.hasOwn(record, "autonomyLevel") || !Object.hasOwn(record, "permissions")) {
    throw new TradingDomainError("tool_rejected", "XAUUSD routine marker is incomplete. Failing closed.");
  }
  const environment = parseTradingEnvironment(record.environment);
  const autonomyLevel = AUTONOMY_LEVELS.find((level) => level === record.autonomyLevel);
  if (autonomyLevel === undefined) {
    throw new TradingDomainError("autonomy_rejected", "autonomy level is not 0 through 5");
  }
  if (!Array.isArray(record.permissions)) {
    throw new TradingDomainError("tool_rejected", "XAUUSD permissions were rejected. Failing closed.");
  }
  const permissions: TradingPermission[] = [];
  for (const permission of record.permissions) {
    if (typeof permission !== "string" || !(TRADING_PERMISSIONS as readonly string[]).includes(permission)) {
      throw new TradingDomainError("tool_rejected", "unknown trading permission");
    }
    if (permissions.includes(permission as TradingPermission)) {
      throw new TradingDomainError("tool_rejected", "duplicate trading permission");
    }
    permissions.push(permission as TradingPermission);
  }
  return seal({ environment, autonomyLevel, permissions });
}
