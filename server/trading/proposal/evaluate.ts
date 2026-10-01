import type { Decision } from "../../../shared/trading/decision.ts";
import type { TradingEvent } from "../../../shared/trading/events.ts";
import type { OrderIntent } from "../../../shared/trading/order-intent.ts";
import { recordIdSchema } from "../../../shared/trading/ids.ts";
import { tradingFact } from "../audit.ts";
import { assessXauUsdPolicy, type PolicyAssessmentInput } from "../policy/assess.ts";
import type { PolicyDecision } from "../policy/result.ts";
import { contentHash } from "../replay/hash.ts";
import { assessXauUsdRisk, type RiskAssessmentInput } from "../risk/assess.ts";
import type { RiskDecision } from "../risk/result.ts";

export const PROPOSAL_ENGINE_VERSION = "xauusd-proposal-1" as const;

export const PROPOSAL_OUTCOMES = [
  "ELIGIBLE_FOR_FUTURE_EXECUTION",
  "RECOMMENDATION_ONLY",
  "ANALYSIS_ONLY",
  "REJECTED",
  "BLOCKED",
  "INVALID",
] as const;

export type ProposalOutcome = (typeof PROPOSAL_OUTCOMES)[number];

export interface ProposalInput {
  readonly instrument: unknown;
  readonly decision: Decision | null;
  readonly orderIntent: OrderIntent | null;
  readonly market: unknown;
  readonly account: unknown;
  readonly riskConfig: unknown;
  readonly policyConfig: unknown;
  readonly environment: unknown;
  readonly provenance: unknown;
  readonly assessedAt: string;
  readonly agentRunId: string;
  readonly evaluationRunId?: string | null;
  readonly runtimeThreadId?: string | null;
  readonly runtimeTurnId?: string | null;
  readonly requestedQuantity?: number | null;
  readonly autonomy: unknown;
  readonly permissions: unknown;
  readonly approval: unknown;
  readonly killSwitch: unknown;
  readonly simulateRiskFailure?: boolean;
  readonly simulatePolicyFailure?: boolean;
}

/** Risk then policy. ELIGIBLE_FOR_FUTURE_EXECUTION is not an execution. */
export interface ProposalEvaluation {
  readonly schemaVersion: typeof PROPOSAL_ENGINE_VERSION;
  readonly id: string;
  readonly outcome: ProposalOutcome;
  readonly reasons: readonly string[];
  readonly risk: RiskDecision;
  readonly policy: PolicyDecision | null;
  readonly orderIntentExecutable: false;
  readonly orderIntentBrokerSubmit: false;
  readonly liveExecutionEnabled: false;
  readonly agentRunId: string;
  readonly evaluationRunId: string | null;
  readonly events: readonly TradingEvent[];
}

export function evaluateXauUsdProposal(input: ProposalInput): ProposalEvaluation {
  const riskInput: RiskAssessmentInput = {
    instrument: input.instrument,
    decision: input.decision,
    orderIntent: input.orderIntent,
    market: input.market,
    account: input.account,
    config: input.riskConfig,
    environment: input.environment,
    provenance: input.provenance,
    assessedAt: input.assessedAt,
    agentRunId: input.agentRunId,
    evaluationRunId: input.evaluationRunId,
    runtimeThreadId: input.runtimeThreadId,
    runtimeTurnId: input.runtimeTurnId,
    requestedQuantity: input.requestedQuantity,
    simulateInternalFailure: input.simulateRiskFailure,
  };
  const risk = assessXauUsdRisk(riskInput);
  if (risk.state !== "ACCEPT") {
    return compose(input, risk, null, outcomeFromRisk(risk.state), risk.reasons);
  }
  const policyInput: PolicyAssessmentInput = {
    instrument: input.instrument,
    decision: input.decision,
    orderIntent: input.orderIntent,
    risk,
    environment: input.environment,
    provenance: input.provenance,
    marketFreshness: risk.trace.marketFreshness ?? "unavailable",
    autonomy: input.autonomy,
    permissions: input.permissions,
    approval: input.approval,
    killSwitch: input.killSwitch,
    config: input.policyConfig,
    assessedAt: input.assessedAt,
    agentRunId: input.agentRunId,
    evaluationRunId: input.evaluationRunId,
    runtimeThreadId: input.runtimeThreadId,
    runtimeTurnId: input.runtimeTurnId,
    simulateInternalFailure: input.simulatePolicyFailure,
  };
  const policy = assessXauUsdPolicy(policyInput);
  if (policy.state === "ALLOW" && policy.progression !== "NONE") {
    return compose(input, risk, policy, policy.progression, policy.reasons);
  }
  const outcome: ProposalOutcome = policy.state === "BLOCKED"
    ? "BLOCKED"
    : policy.state === "REJECT"
      ? "REJECTED"
      : "INVALID";
  return compose(input, risk, policy, outcome, policy.reasons);
}

function outcomeFromRisk(state: RiskDecision["state"]): ProposalOutcome {
  if (state === "REJECT") return "REJECTED";
  if (state === "BLOCKED") return "BLOCKED";
  return "INVALID";
}

function compose(
  input: ProposalInput,
  risk: RiskDecision,
  policy: PolicyDecision | null,
  outcome: ProposalOutcome,
  reasons: readonly string[],
): ProposalEvaluation {
  const evaluationRunId = input.evaluationRunId ?? null;
  const agentRunId = recordIdSchema.safeParse(input.agentRunId).success ? input.agentRunId : risk.agentRunId;
  const id = `proposal.${contentHash({
    schema: PROPOSAL_ENGINE_VERSION,
    outcome,
    reasons,
    riskId: risk.id,
    policyId: policy?.id ?? null,
    agentRunId,
    evaluationRunId,
    assessedAt: input.assessedAt,
  }).slice(0, 40)}`;
  const events = [...risk.events, ...(policy?.events ?? [])];
  if (outcome === "ELIGIBLE_FOR_FUTURE_EXECUTION" && policy !== null) {
    const eligible = tradingFact({
      type: "proposal.eligible",
      eventId: `pe.${id}`,
      at: input.assessedAt,
      agentRunId,
      correlationId: evaluationRunId ?? risk.decisionId ?? agentRunId,
      environment: input.environment === "PAPER" || input.environment === "LIVE" ? input.environment : "SIMULATOR",
      actor: "xauusd-proposal",
      nextState: outcome,
      runtimeThreadId: input.runtimeThreadId,
      runtimeTurnId: input.runtimeTurnId,
      payload: {
        outcome,
        riskDecisionId: risk.id,
        policyDecisionId: policy.id,
        liveExecutionEnabled: false,
        executable: false,
        brokerSubmit: false,
      },
    });
    if (eligible) events.push(eligible);
  }
  return Object.freeze({
    schemaVersion: PROPOSAL_ENGINE_VERSION,
    id,
    outcome,
    reasons: Object.freeze([...reasons]),
    risk,
    policy,
    orderIntentExecutable: false,
    orderIntentBrokerSubmit: false,
    liveExecutionEnabled: false,
    agentRunId,
    evaluationRunId,
    events: Object.freeze(events),
  });
}
