/** Deterministic XAUUSD evaluation. This module records the existing chat tool
 * session at replay times. It does not choose tools, rank agents, or submit orders. */

export { EVALUATION_RULES_VERSION, createEvaluationConfiguration } from "./config.ts";
export type { EvaluationConfiguration, EvaluationConfigurationInput, EvaluationRoutingConfig } from "./config.ts";

export { createObservationSchedule } from "./schedule.ts";
export type { ObservationPoint } from "./schedule.ts";

export { createEvaluationArchive } from "./archive.ts";
export type { EvaluationArchive } from "./archive.ts";

export { createEvaluationRun, executeEvaluationRun } from "./run.ts";
export type { EvaluationPlayInput, EvaluationPlayer, EvaluationRun } from "./run.ts";

export { assessRecordedCalls, compareEvaluationRuns, evaluationMetrics } from "./judge.ts";
export type { EvaluationComparison, RecordedCall, StepAssessment } from "./judge.ts";

export { EVALUATION_STATUSES, SAFETY_FINDING_CODES } from "./result.ts";
export type {
  EvaluationMetrics,
  EvaluationResult,
  EvaluationStatus,
  EvaluationStep,
  EvidenceSummary,
  FutureOutcomeReference,
  SafetyFinding,
  ToolFact,
} from "./result.ts";
