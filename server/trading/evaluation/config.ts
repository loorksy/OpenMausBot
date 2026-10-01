import { AUTONOMY_LEVELS, type AutonomyLevel } from "../../../shared/trading/autonomy.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { seal } from "../../../shared/trading/ids.ts";
import { XAUUSD_TIMEFRAMES, type XauUsdTimeframe } from "../../../shared/trading/snapshot.ts";
import { assertClockLimits } from "../infrastructure/market_data/clock.ts";
import type { MarketClockLimits } from "../infrastructure/market_data/model.ts";
import { normalizeTimeframe } from "../infrastructure/market_data/timeframe.ts";
import { XAUUSD_TOOL_CATALOG_VERSION, TRADING_PERMISSIONS, type TradingPermission } from "../agent/catalog.ts";
import type { ModelRoutingPolicy } from "../agent/routing.ts";
import { contentHash } from "../replay/hash.ts";
import { replayInstant } from "../replay/clock.ts";
import type { ReplayDataset } from "../replay/dataset.ts";
import { REPLAY_FORMING_POLICY } from "../replay/session.ts";
import { createObservationSchedule, type ObservationPoint } from "./schedule.ts";

export const EVALUATION_RULES_VERSION = "xauusd-eval-1" as const;

export interface EvaluationRoutingConfig {
  readonly policy: ModelRoutingPolicy;
  readonly taskClass: string;
  readonly requestedModelId: string;
  readonly availableModelIds: readonly string[];
}

export interface EvaluationConfigurationInput {
  readonly dataset: ReplayDataset;
  readonly instrument?: "XAUUSD";
  readonly environment?: "SIMULATOR" | "PAPER" | "LIVE";
  readonly startAt: unknown;
  readonly endAt: unknown;
  readonly timeframes: readonly string[];
  readonly limits: MarketClockLimits;
  readonly schedule: readonly unknown[];
  readonly modelProvider: string;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly autonomyLevel: number;
  readonly permissions: readonly string[];
  readonly specialistAttached?: boolean;
  readonly routing?: EvaluationRoutingConfig | null;
}

/** Immutable identity of one evaluation. Attempt number is not part of it. */
export interface EvaluationConfiguration {
  readonly rulesVersion: typeof EVALUATION_RULES_VERSION;
  readonly configurationId: string;
  readonly comparisonKey: string;
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly datasetFingerprint: string;
  readonly instrument: "XAUUSD";
  readonly environment: "SIMULATOR";
  readonly startAt: string;
  readonly endAt: string;
  readonly schedule: readonly ObservationPoint[];
  readonly timeframes: readonly XauUsdTimeframe[];
  readonly limits: MarketClockLimits;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly toolCatalogVersion: typeof XAUUSD_TOOL_CATALOG_VERSION;
  readonly autonomyLevel: AutonomyLevel;
  readonly permissions: readonly TradingPermission[];
  readonly specialistAttached: boolean;
  readonly formingPolicy: typeof REPLAY_FORMING_POLICY;
  readonly routing: null | {
    readonly policy: ModelRoutingPolicy;
    readonly policyVersion: string;
    readonly taskClass: string;
    readonly requestedModelId: string;
    readonly availableModelIds: readonly string[];
  };
}

function requireVersion(value: string, label: string): string {
  const text = value.trim();
  if (!text || text.length > 128) {
    throw new TradingDomainError("evaluation_rejected", `${label} is missing`);
  }
  return text;
}

function canonicalTimeframes(values: readonly string[]): XauUsdTimeframe[] {
  if (values.length === 0) {
    throw new TradingDomainError("evaluation_rejected", "evaluation needs at least one timeframe");
  }
  const seen = new Set<XauUsdTimeframe>();
  for (const value of values) {
    const normalized = normalizeTimeframe(value);
    if (normalized.normalization) {
      throw new TradingDomainError("evaluation_rejected", "evaluation timeframes must be canonical");
    }
    seen.add(normalized.timeframe);
  }
  return XAUUSD_TIMEFRAMES.filter((timeframe) => seen.has(timeframe));
}

function canonicalPermissions(values: readonly string[]): TradingPermission[] {
  const unique: TradingPermission[] = [];
  for (const value of values) {
    if (!(TRADING_PERMISSIONS as readonly string[]).includes(value)) {
      throw new TradingDomainError("evaluation_rejected", "unknown trading permission");
    }
    const permission = value as TradingPermission;
    if (!unique.includes(permission)) unique.push(permission);
  }
  return [...unique].sort();
}

/** Seal a configuration. The id changes when any material input changes.
 * Wall-clock time is not an input. */
export function createEvaluationConfiguration(input: EvaluationConfigurationInput): EvaluationConfiguration {
  if ((input.instrument ?? "XAUUSD") !== "XAUUSD" || input.dataset.instrument !== "XAUUSD") {
    throw new TradingDomainError("instrument_rejected", "evaluation instrument must be XAUUSD");
  }
  if ((input.environment ?? "SIMULATOR") !== "SIMULATOR") {
    throw new TradingDomainError("environment_isolation", "evaluation runs only in the simulator replay environment");
  }
  if (!(AUTONOMY_LEVELS as readonly number[]).includes(input.autonomyLevel)) {
    throw new TradingDomainError("autonomy_rejected", "autonomy level is not 0 through 5");
  }
  const autonomyLevel = input.autonomyLevel as AutonomyLevel;
  const startAt = replayInstant(input.startAt);
  const endAt = replayInstant(input.endAt);
  if (Date.parse(endAt) <= Date.parse(startAt)) {
    throw new TradingDomainError("evaluation_rejected", "evaluation end must be after the start");
  }
  assertClockLimits(input.limits);
  const limits: MarketClockLimits = {
    staleAfterMs: input.limits.staleAfterMs,
    futureSkewMs: input.limits.futureSkewMs,
    abnormalLatencyMs: input.limits.abnormalLatencyMs,
  };
  const timeframes = canonicalTimeframes(input.timeframes);
  const schedule = createObservationSchedule(input.schedule, startAt, endAt);
  const permissions = canonicalPermissions(input.permissions);
  const modelProvider = requireVersion(input.modelProvider, "modelProvider");
  const modelId = requireVersion(input.modelId, "modelId");
  const promptVersion = requireVersion(input.promptVersion, "promptVersion");
  const specialistAttached = input.specialistAttached === true;
  let routing: EvaluationConfiguration["routing"] = null;
  if (input.routing) {
    const requestedModelId = requireVersion(input.routing.requestedModelId, "requestedModelId");
    if (requestedModelId !== modelId) {
      throw new TradingDomainError("evaluation_rejected", "routing requested model must match the evaluation model");
    }
    const policyVersion = requireVersion(input.routing.policy.version, "routing policy version");
    const taskClass = requireVersion(input.routing.taskClass, "taskClass");
    const availableModelIds = [...input.routing.availableModelIds].map((id) => requireVersion(id, "availableModelId")).sort();
    routing = {
      policy: input.routing.policy,
      policyVersion,
      taskClass,
      requestedModelId,
      availableModelIds,
    };
  }
  const identity = {
    rulesVersion: EVALUATION_RULES_VERSION,
    datasetId: input.dataset.datasetId,
    datasetVersion: input.dataset.datasetVersion,
    datasetFingerprint: input.dataset.fingerprint,
    instrument: "XAUUSD" as const,
    environment: "SIMULATOR" as const,
    startAt,
    endAt,
    schedule: schedule.map((point) => point.at),
    timeframes,
    limits,
    modelProvider,
    modelId,
    promptVersion,
    toolCatalogVersion: XAUUSD_TOOL_CATALOG_VERSION,
    autonomyLevel,
    permissions,
    specialistAttached,
    formingPolicy: REPLAY_FORMING_POLICY,
    routing: routing === null ? null : {
      policyVersion: routing.policyVersion,
      taskClass: routing.taskClass,
      requestedModelId: routing.requestedModelId,
      availableModelIds: routing.availableModelIds,
      policy: routing.policy,
    },
  };
  const comparisonIdentity = {
    ...identity,
    modelProvider: undefined,
    modelId: undefined,
    promptVersion: undefined,
    routing: routing === null ? null : {
      policyVersion: routing.policyVersion,
      taskClass: routing.taskClass,
    },
  };
  return seal({
    rulesVersion: EVALUATION_RULES_VERSION,
    configurationId: `cfg-${contentHash(identity)}`,
    comparisonKey: `cmp-${contentHash(comparisonIdentity)}`,
    datasetId: input.dataset.datasetId,
    datasetVersion: input.dataset.datasetVersion,
    datasetFingerprint: input.dataset.fingerprint,
    instrument: "XAUUSD" as const,
    environment: "SIMULATOR" as const,
    startAt,
    endAt,
    schedule,
    timeframes,
    limits,
    modelProvider,
    modelId,
    promptVersion,
    toolCatalogVersion: XAUUSD_TOOL_CATALOG_VERSION,
    autonomyLevel,
    permissions,
    specialistAttached,
    formingPolicy: REPLAY_FORMING_POLICY,
    routing,
  });
}
