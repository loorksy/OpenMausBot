import { parseTradingEnvironment, type TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";

/** Explicit operator settings. Neither value has a default. */
export const XAUUSD_STORE_PATH_ENV = "OMB_XAUUSD_STORE_PATH";
export const XAUUSD_ENVIRONMENT_ENV = "OMB_XAUUSD_ENVIRONMENT";

export type XauUsdJobMount =
  | { readonly mounted: false }
  | { readonly mounted: true; readonly path: string; readonly environment: TradingEnvironment };

/** Reads an explicit store path and environment. It does not open a database,
 * invent a path, or choose LIVE. The process does not call this until a turn
 * can keep the job's runtimeTurnId; see docs/trading/long-running-agent.md. */
export function readXauUsdJobMount(env: Readonly<Record<string, string | undefined>>): XauUsdJobMount {
  const path = env[XAUUSD_STORE_PATH_ENV]?.trim() ?? "";
  const environment = env[XAUUSD_ENVIRONMENT_ENV]?.trim() ?? "";
  if (path === "" && environment === "") return { mounted: false };
  if (path === "" || environment === "") {
    throw new TradingDomainError(
      "trading_store_rejected",
      "XAUUSD job storage needs both an explicit path and an explicit environment. Failing closed.",
    );
  }
  return { mounted: true, path, environment: parseTradingEnvironment(environment) };
}
