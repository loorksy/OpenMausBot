import { z } from "zod";

import { TradingDomainError } from "./errors.ts";
import { formatZodError, seal, zodCode } from "./ids.ts";

/** Distinct account environments. Nothing in this module converts one into another. */
export const TRADING_ENVIRONMENTS = ["SIMULATOR", "PAPER", "LIVE"] as const;

export type TradingEnvironment = (typeof TRADING_ENVIRONMENTS)[number];

export const tradingEnvironmentSchema = z.enum(TRADING_ENVIRONMENTS, {
  error: "environment must be SIMULATOR, PAPER, or LIVE",
});

/** Market-data provenance. SIMULATOR is synthetic data. REPLAY is historical
 * market time and is valid only in the SIMULATOR slot. Neither is a fallback
 * for a failed live feed, and REPLAY is never labeled LIVE. */
export const PROVENANCE_STATUSES = ["LIVE", "STALE", "SIMULATOR", "UNAVAILABLE", "REPLAY"] as const;

export type ProvenanceStatus = (typeof PROVENANCE_STATUSES)[number];

export const provenanceStatusSchema = z.enum(PROVENANCE_STATUSES, {
  error: "provenance must be LIVE, STALE, SIMULATOR, UNAVAILABLE, or REPLAY",
});

export type CredentialSlot = "none" | "paper" | "live";

/** Foundation bindings never enable broker network calls or live execution.
 * PAPER and LIVE name isolated slots so later phases cannot share secrets.
 * Those slots are not loaded here. */
export interface EnvironmentBinding {
  readonly schemaVersion: 1;
  readonly environment: TradingEnvironment;
  readonly credentialSlot: CredentialSlot;
  readonly liveExecutionEnabled: false;
  readonly brokerNetworkEnabled: false;
}

const SLOT_BY_ENVIRONMENT: Record<TradingEnvironment, CredentialSlot> = {
  SIMULATOR: "none",
  PAPER: "paper",
  LIVE: "live",
};

export function parseTradingEnvironment(value: unknown): TradingEnvironment {
  const parsed = tradingEnvironmentSchema.safeParse(value);
  if (!parsed.success) {
    throw new TradingDomainError("environment_rejected", "environment must be SIMULATOR, PAPER, or LIVE");
  }
  return parsed.data;
}

export function parseProvenanceStatus(value: unknown): ProvenanceStatus {
  const parsed = provenanceStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw new TradingDomainError("invalid_snapshot", "provenance must be LIVE, STALE, SIMULATOR, UNAVAILABLE, or REPLAY");
  }
  return parsed.data;
}

/** Rejects a feed that relabels simulator data as live, or live data as simulator. */
export function assertProvenanceForEnvironment(
  environment: TradingEnvironment,
  provenance: ProvenanceStatus,
): void {
  if (provenance === "SIMULATOR" && environment !== "SIMULATOR") {
    throw new TradingDomainError(
      "silent_simulator_fallback",
      `${environment} cannot use SIMULATOR provenance`,
    );
  }
  if (environment === "SIMULATOR" && provenance === "LIVE") {
    throw new TradingDomainError(
      "silent_simulator_fallback",
      "SIMULATOR cannot be labeled LIVE",
    );
  }
  if (provenance === "REPLAY" && environment !== "SIMULATOR") {
    throw new TradingDomainError(
      "environment_isolation",
      "REPLAY provenance is only valid in the SIMULATOR environment",
    );
  }
}

/** The only legal continuation is the environment the caller already holds. */
export function continueInEnvironment(
  active: TradingEnvironment,
  requested: unknown,
): TradingEnvironment {
  const next = parseTradingEnvironment(requested);
  if (next !== active) {
    throw new TradingDomainError(
      "environment_transition_rejected",
      `Refusing to move from ${active} to ${next}`,
    );
  }
  return next;
}

export function environmentBinding(environment: TradingEnvironment): EnvironmentBinding {
  return seal({
    schemaVersion: 1 as const,
    environment,
    credentialSlot: SLOT_BY_ENVIRONMENT[environment],
    liveExecutionEnabled: false as const,
    brokerNetworkEnabled: false as const,
  });
}

const environmentBindingSchema = z.object({
  schemaVersion: z.literal(1),
  environment: tradingEnvironmentSchema,
  credentialSlot: z.enum(["none", "paper", "live"]),
  liveExecutionEnabled: z.literal(false),
  brokerNetworkEnabled: z.literal(false),
}).strict().superRefine((value, ctx) => {
  if (value.credentialSlot !== SLOT_BY_ENVIRONMENT[value.environment]) {
    ctx.addIssue({
      code: "custom",
      path: ["credentialSlot"],
      message: "credential slot does not match the environment",
    });
  }
});

export function parseEnvironmentBinding(value: unknown): EnvironmentBinding {
  const parsed = environmentBindingSchema.safeParse(value);
  if (!parsed.success) {
    throw new TradingDomainError(zodCode(parsed.error, "environment_isolation"), formatZodError(parsed.error));
  }
  return seal(parsed.data);
}

/** Presented secrets must match the environment slot. A simulator call that
 * presents a live slot is rejected. This function does not read secrets. */
export function assertCredentialSlot(environment: TradingEnvironment, presented: CredentialSlot): void {
  const expected = SLOT_BY_ENVIRONMENT[environment];
  if (presented !== expected) {
    throw new TradingDomainError(
      "environment_isolation",
      `${environment} cannot use the ${presented} credential slot`,
    );
  }
  if (environment !== "LIVE" && presented === "live") {
    throw new TradingDomainError("environment_isolation", "Live credentials are isolated from this environment");
  }
}
