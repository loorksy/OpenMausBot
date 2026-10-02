import type { Decision } from "../../../shared/trading/decision.ts";
import type { OrderIntent } from "../../../shared/trading/order-intent.ts";
import type { TradingEvent } from "../../../shared/trading/events.ts";
import type { MarketObservation, ReplayDataQuality } from "../replay/session.ts";
import type { EvaluationConfiguration } from "./config.ts";

/** Run outcome. These are distinct. They are not collapsed into one error. */
export const EVALUATION_STATUSES = ["PASS", "FAIL", "BLOCKED", "INVALID", "UNAVAILABLE"] as const;

export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];

export const SAFETY_FINDING_CODES = [
  "future_data",
  "provenance_mismatch",
  "observation_mismatch",
  "dataset_mismatch",
  "execution_tool",
  "arbitrary_symbol",
  "credentials",
  "grant_bypass",
  "evidence_fence",
  "clock_moved",
  "execution_authority",
] as const;

export type SafetyFindingCode = (typeof SAFETY_FINDING_CODES)[number];

/** A deterministic safety invariant. This is not a trading-quality opinion. */
export interface SafetyFinding {
  readonly code: SafetyFindingCode;
  readonly toolName: string | null;
  readonly sequence: number | null;
  readonly detail: string;
}

/** One recorded tool call. The sequence is the trajectory. It is not a grade. */
export interface ToolFact {
  readonly toolName: string;
  readonly catalogVersion: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly ok: boolean;
  readonly code: string | null;
  /** What the tool boundary did. DENIED means the grant held. It is not a grade. */
  readonly outcome: "OK" | "DENIED" | "FAILED";
  readonly denialReason: string | null;
  readonly autonomyLevel: number;
  readonly permissions: readonly string[];
  readonly replayTimestamp: string;
  readonly agentRunId: string;
  readonly evaluationRunId: string;
  readonly runtimeEventIds: readonly string[];
  readonly freshness: string | null;
}

export interface EvidenceSummary {
  readonly id: string;
  readonly trust: string;
  readonly untrusted: boolean;
  readonly excerpt: string;
  readonly canModify: {
    readonly risk: boolean;
    readonly policy: boolean;
    readonly autonomy: boolean;
    readonly credentials: boolean;
    readonly approval: boolean;
    readonly execution: boolean;
    readonly killSwitch: boolean;
  };
}

/** References for a later outcome phase. Nothing here is a fill or a score. */
export interface FutureOutcomeReference {
  readonly status: "not-evaluated";
  readonly snapshotId: string | null;
  readonly observationAt: string;
  readonly decisionIds: readonly string[];
}

export interface EvaluationStep {
  readonly sequence: number;
  readonly at: string;
  readonly evaluationRunId: string;
  readonly replaySessionId: string;
  readonly agentRunId: string;
  readonly runtimeThreadId: string;
  readonly runtimeTurnId: string;
  readonly observation: MarketObservation;
  readonly trajectory: readonly ToolFact[];
  readonly decisions: readonly Decision[];
  readonly orderIntents: readonly OrderIntent[];
  readonly evidence: readonly EvidenceSummary[];
  readonly safetyFindings: readonly SafetyFinding[];
  readonly tradingEvents: readonly TradingEvent[];
  readonly status: EvaluationStatus;
  readonly quality: ReplayDataQuality;
  readonly futureOutcome: FutureOutcomeReference;
  readonly reportedUsage: null | {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly modelLatencyMs: number;
    readonly source: "model-adapter";
  };
}

export interface EvaluationMetrics {
  readonly marketTruth: {
    readonly futureDataViolations: number;
    readonly staleDataObservations: number;
    readonly provenanceViolations: number;
    readonly observationMismatches: number;
    readonly datasetMismatches: number;
  };
  readonly tools: {
    readonly callCount: number;
    readonly uniqueTools: number;
    readonly unavailableAttempts: number;
    /** Tool requests the grant refused. A count, not a quality score. */
    readonly deniedAttempts: number;
    readonly invalidInputAttempts: number;
    readonly toolFailures: number;
    readonly repeatedCalls: number;
    readonly sequences: readonly (readonly string[])[];
  };
  readonly decisions: {
    readonly attempts: number;
    readonly valid: number;
    readonly malformed: number;
    readonly noTrade: number;
    readonly wait: number;
    readonly long: number;
    readonly short: number;
    readonly manage: number;
    readonly exit: number;
    /** Valid decisions divided by decision attempts. Schema acceptance only. */
    readonly validDecisionRate: number | null;
    /** NO_TRADE count divided by valid decisions. A ratio, not a quality score. */
    readonly noTradeRate: number | null;
    /** WAIT count divided by valid decisions. A ratio, not a quality score. */
    readonly waitRate: number | null;
    readonly rateMeaning: "count-ratio-not-a-quality-score";
    readonly unsupportedClaimsAssessed: false;
  };
  readonly safety: {
    readonly executionAttempts: number;
    /** Calls that succeeded outside the grant. A denial is not counted here. */
    readonly grantBypasses: number;
    readonly arbitrarySymbols: number;
    readonly credentialAttempts: number;
    readonly evidenceFenceViolations: number;
  };
  readonly runtime: {
    readonly turnCount: number;
    readonly turnDurationMs: null;
    readonly toolLatencyMs: null;
    readonly modelLatencyMs: number | null;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly estimatedCost: null;
    readonly measurementSource: "unavailable" | "model-adapter";
  };
  readonly reproducibility: {
    readonly configurationId: string;
    readonly modelProvider: string;
    readonly modelId: string;
    readonly promptVersion: string;
    readonly catalogVersion: string;
    readonly modelDeterminism: "not-guaranteed";
  };
}

export interface EvaluationResult {
  readonly schemaVersion: 1;
  readonly evaluationRunId: string;
  readonly attempt: number;
  readonly configuration: EvaluationConfiguration;
  readonly configurationId: string;
  readonly comparisonKey: string;
  readonly status: EvaluationStatus;
  readonly stopReason: null | "safety" | "player" | "mount" | "routing";
  readonly instrument: "XAUUSD";
  readonly environment: "SIMULATOR";
  readonly replaySessionId: string | null;
  readonly agentRunId: string;
  readonly runtimeThreadId: string;
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly datasetFingerprint: string;
  readonly schedule: readonly {
    readonly sequence: number;
    readonly at: string;
    readonly evaluationRunId: string;
    readonly replaySessionId: string | null;
  }[];
  readonly model: {
    readonly provider: string;
    readonly id: string | null;
    readonly requestedId: string;
    readonly promptVersion: string;
    readonly sessionPromptVersion: string | null;
    readonly catalogVersion: string;
    readonly determinism: "not-guaranteed";
  };
  readonly routing: {
    readonly policyVersion: string | null;
    readonly taskClass: string | null;
    readonly requestedModelId: string;
    readonly selectedModelId: string | null;
    readonly fallbackUsed: boolean;
    readonly failure: string | null;
    readonly executionAuthority: false;
  };
  readonly executionAuthority: false;
  readonly memoryMutated: false;
  readonly brokerContacted: false;
  readonly steps: readonly EvaluationStep[];
  readonly safetyFindings: readonly SafetyFinding[];
  readonly metrics: EvaluationMetrics;
  readonly replayEvents: readonly TradingEvent[];
  readonly futureOutcome: { readonly status: "not-evaluated" };
  /** Research interpretation is not performed in this phase. */
  readonly interpretation: "not-evaluated";
}
