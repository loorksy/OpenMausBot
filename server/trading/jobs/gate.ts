import type { ProvenanceStatus, TradingEnvironment } from "../../../shared/trading/environment.ts";
import { parseKillSwitchState } from "../../../shared/trading/kill-switch.ts";
import type { ReconciliationState } from "../../../shared/trading/reconciliation.ts";
import type { ExecutionState } from "../execution/result.ts";
import type { XauUsdJob, XauUsdJobBlockReason } from "./model.ts";

export interface JobExecutionFacts {
  readonly gateState: string | null;
  readonly provenance: ProvenanceStatus | null;
  readonly reconciliationState: ReconciliationState | null;
  readonly executionState: ExecutionState | null;
  readonly killSwitch: unknown;
  readonly proposalBinding: string | null;
  readonly entry: number | null;
  readonly stop: number | null;
  readonly quantity: number | null;
  readonly environment: TradingEnvironment | null;
}

export interface JobExecutionDecision {
  readonly brokerCall: false;
  readonly reason: XauUsdJobBlockReason;
  readonly handoff: "existing-execution-boundary" | "none";
}

/** Says whether the existing execution boundary may be asked. It never calls it. */
export function authorizeJobExecution(job: XauUsdJob, facts: JobExecutionFacts): JobExecutionDecision {
  const kill = readKill(facts.killSwitch, job);
  if (kill !== "open") return blocked("kill_switch");
  if (job.autonomyLevel < 3) return blocked("autonomy");
  if (job.status === "CANCELLED" || job.status === "PAUSED" || job.status === "COMPLETED" || job.status === "FAILED") {
    return blocked("policy");
  }
  if (facts.executionState === "SUBMISSION_UNKNOWN" || job.executionState === "SUBMISSION_UNKNOWN") {
    return blocked("execution_unresolved");
  }
  if (facts.reconciliationState === "DESYNCED" || facts.reconciliationState === "UNKNOWN" || job.reconciliationState === "DESYNCED" || job.reconciliationState === "UNKNOWN") {
    return blocked("reconciliation");
  }
  if (facts.provenance !== "LIVE" || job.environment === "SIMULATOR") return blocked("provenance");
  if (facts.environment !== job.environment) return blocked("policy");
  if (facts.gateState !== "ELIGIBLE_FOR_EXECUTION") return blocked("gate");
  if (job.autonomyLevel === 3 || job.approval !== null) {
    if (job.approval === null || job.status !== "WAITING_FOR_APPROVAL") return blocked("approval");
    if (facts.proposalBinding !== job.approval.proposalBinding) return blocked("approval");
    if (facts.entry !== job.approval.entry || facts.stop !== job.approval.stop || facts.quantity !== job.approval.quantity) {
      return blocked("approval");
    }
    if (facts.environment !== job.approval.environment) return blocked("approval");
  }
  return { brokerCall: false, reason: null, handoff: "existing-execution-boundary" };
}

function blocked(reason: XauUsdJobBlockReason): JobExecutionDecision {
  return { brokerCall: false, reason, handoff: "none" };
}

function readKill(value: unknown, job: XauUsdJob): "open" | "engaged" | "unknown" {
  try {
    const state = parseKillSwitchState(value);
    if (state.environment !== job.environment || state.agentRunId !== job.agentRunId) return "unknown";
    return state.engaged ? "engaged" : "open";
  } catch {
    return "unknown";
  }
}
