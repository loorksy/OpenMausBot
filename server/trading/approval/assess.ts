import { parseAutonomyState, type AutonomyLevel } from "../../../shared/trading/autonomy.ts";
import type { Decision } from "../../../shared/trading/decision.ts";
import { provenanceStatusSchema, tradingEnvironmentSchema, type ProvenanceStatus, type TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import type { TradingEvent, TradingEventType } from "../../../shared/trading/events.ts";
import { assertNoSecretFields, recordIdSchema, utcTimestampSchema } from "../../../shared/trading/ids.ts";
import { XAUUSD_INSTRUMENT } from "../../../shared/trading/instrument.ts";
import { parseKillSwitchState } from "../../../shared/trading/kill-switch.ts";
import type { OrderIntent } from "../../../shared/trading/order-intent.ts";
import { TRADING_PERMISSIONS, type TradingPermission } from "../agent/catalog.ts";
import { tradingFact } from "../audit.ts";
import type { PolicyDecision } from "../policy/result.ts";
import { contentHash } from "../replay/hash.ts";
import type { RiskDecision } from "../risk/result.ts";
import { proposalBinding, type ProposalBindingFacts } from "./binding.ts";
import { parseApprovalConfig, APPROVAL_ENGINE_VERSION, type ApprovalConfig } from "./config.ts";
import { approvalInfrastructureFact, type ApprovalDecision, type ApprovalReason, type ApprovalState } from "./result.ts";
import { ageMillis } from "./time.ts";

const FACT_KEYS = new Set([
  "approvalId",
  "approvalRequestId",
  "approved",
  "approvedBy",
  "approvedAt",
  "decisionId",
  "orderIntentId",
  "riskDecisionId",
  "policyDecisionId",
  "environment",
  "instrument",
  "approvalPolicyVersion",
  "proposalBinding",
]);

export interface ApprovalFact {
  readonly approvalId: string;
  readonly approvalRequestId: string;
  readonly approved: boolean;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly decisionId: string;
  readonly orderIntentId: string;
  readonly riskDecisionId: string;
  readonly policyDecisionId: string;
  readonly environment: TradingEnvironment;
  readonly instrument: "XAUUSD";
  readonly approvalPolicyVersion: string;
  readonly proposalBinding: string;
}

export interface ApprovalAssessmentInput {
  readonly instrument: unknown;
  readonly decision: Decision | null;
  readonly orderIntent: OrderIntent | null;
  readonly risk: RiskDecision;
  readonly policy: PolicyDecision;
  readonly environment: unknown;
  readonly provenance: unknown;
  readonly autonomy: unknown;
  readonly permissions: unknown;
  readonly killSwitch: unknown;
  readonly approval: unknown;
  readonly config: unknown;
  readonly evaluatedAt: string;
  readonly agentRunId: string;
  readonly approvalRequestId: string;
  readonly requestedQuantity: number | null;
  readonly evaluationRunId?: string | null;
  readonly runtimeThreadId?: string | null;
  readonly runtimeTurnId?: string | null;
  readonly simulateInternalFailure?: boolean;
}

type Outcome = {
  readonly state: ApprovalState;
  readonly reason: ApprovalReason;
  readonly binding: string | null;
  readonly humanApprovalId: string | null;
  readonly level: AutonomyLevel | null;
  readonly environment: TradingEnvironment | null;
  readonly provenance: ProvenanceStatus | null;
  readonly configId: string | null;
  readonly configVersion: string | null;
};

export function assessApproval(input: ApprovalAssessmentInput): ApprovalDecision {
  try {
    if (input.simulateInternalFailure === true) throw new Error("simulated approval failure");
    assertNoSecretFields(input, "approval input");
    return seal(decide(input));
  } catch (error) {
    const reason = error instanceof TradingDomainError && error.code === "credentials_forbidden"
      ? "CREDENTIALS_FORBIDDEN"
      : "SYSTEM_ERROR";
    return seal(closed(input, reason));
  }
}

export function bindingFromProposal(
  input: ApprovalAssessmentInput,
  riskConfigId: string,
  policyConfigId: string,
): ProposalBindingFacts | null {
  const decision = input.decision;
  const intent = input.orderIntent;
  const provenance = provenanceStatusSchema.safeParse(input.provenance);
  if (decision === null || intent === null || !provenance.success) return null;
  if (intent.entry === undefined || intent.stop === undefined) return null;
  if (input.risk.configId === null || input.policy.configId === null) return null;
  return {
    instrument: "XAUUSD",
    agentRunId: input.agentRunId,
    decisionId: decision.id,
    orderIntentId: intent.id,
    riskDecisionId: input.risk.id,
    policyDecisionId: input.policy.id,
    environment: decision.environment,
    provenance: provenance.data,
    direction: intent.direction,
    entry: intent.entry,
    stop: intent.stop,
    targets: intent.targets,
    requestedQuantity: input.requestedQuantity,
    acceptedQuantity: input.risk.trace.acceptedQuantity,
    riskConfigId,
    policyConfigId,
  };
}

function decide(input: ApprovalAssessmentInput): ApprovalDecision {
  const blank = emptyOutcome();
  if (!recordIdSchema.safeParse(input.agentRunId).success || !utcTimestampSchema.safeParse(input.evaluatedAt).success) {
    return finish(input, blank);
  }
  if (!recordIdSchema.safeParse(input.approvalRequestId).success) return finish(input, blank);
  if (input.instrument !== XAUUSD_INSTRUMENT) return finish(input, { ...blank, reason: "INVALID_INSTRUMENT" });
  const environment = tradingEnvironmentSchema.safeParse(input.environment);
  const provenance = provenanceStatusSchema.safeParse(input.provenance);
  if (!environment.success || !provenance.success) return finish(input, { ...blank, reason: "INVALID_INPUT" });
  const located: Outcome = { ...blank, environment: environment.data, provenance: provenance.data };
  const configRead = parseApprovalConfig(input.config);
  if (!configRead.ok) {
    return finish(input, {
      ...located,
      state: "BLOCKED",
      reason: configRead.missingFreshness ? "APPROVAL_FRESHNESS_UNCONFIGURED" : "APPROVAL_CONFIG_INVALID",
    });
  }
  const configured: Outcome = {
    ...located,
    configId: configRead.configId,
    configVersion: configRead.config.version,
  };
  const kill = readSwitch(input.killSwitch, environment.data, input.agentRunId);
  if (kill !== "open") return finish(input, { ...configured, state: "BLOCKED", reason: kill });
  if (input.risk.state !== "ACCEPT") {
    return finish(input, { ...configured, state: "REJECTED", reason: "RISK_NOT_ACCEPTED" });
  }
  if (input.policy.state !== "ALLOW" || input.policy.progression !== "ELIGIBLE_FOR_FUTURE_EXECUTION") {
    return finish(input, { ...configured, state: "REJECTED", reason: "POLICY_NOT_ELIGIBLE" });
  }
  const autonomy = readAutonomy(input.autonomy, environment.data, input.agentRunId);
  if (autonomy.ok === false) return finish(input, { ...configured, state: autonomy.state, reason: autonomy.reason });
  const withLevel: Outcome = { ...configured, level: autonomy.level };
  if (input.policy.autonomyLevel !== autonomy.level) {
    return finish(input, { ...withLevel, state: "REJECTED", reason: "AUTONOMY_MISMATCH" });
  }
  if (autonomy.level < 3) return finish(input, { ...withLevel, state: "REJECTED", reason: "AUTONOMY_INSUFFICIENT" });
  const permissions = readPermissions(input.permissions);
  if (permissions === "bad" || !permissions.includes("decision.propose") || !permissions.includes("intent.propose")) {
    return finish(input, { ...withLevel, state: "REJECTED", reason: "PERMISSION_MISSING" });
  }
  const decision = input.decision;
  const intent = input.orderIntent;
  if (
    decision === null
    || intent === null
    || decision.instrument !== XAUUSD_INSTRUMENT
    || intent.instrument !== XAUUSD_INSTRUMENT
    || decision.environment !== environment.data
    || intent.environment !== environment.data
    || intent.entry === undefined
    || intent.stop === undefined
    || input.risk.configId === null
    || input.policy.configId === null
  ) {
    return finish(input, { ...withLevel, reason: "INVALID_INPUT" });
  }
  const facts = bindingFromProposal(input, input.risk.configId, input.policy.configId);
  if (facts === null) return finish(input, { ...withLevel, reason: "INVALID_INPUT" });
  const binding = proposalBinding(facts);
  if (autonomy.level >= 4 && input.approval == null) {
    return finish(input, { ...withLevel, state: "APPROVED", reason: "APPROVAL_NOT_REQUIRED", binding });
  }
  const fact = readFact(input.approval);
  if (fact === "bad") return finish(input, { ...withLevel, binding, reason: "INVALID_INPUT" });
  if (fact === null) return finish(input, { ...withLevel, state: "REJECTED", reason: "APPROVAL_REQUIRED", binding });
  const matched = factMatches(fact, input, binding, configRead.config);
  if (matched !== null) return finish(input, { ...withLevel, binding, state: matched.state, reason: matched.reason, humanApprovalId: fact.approvalId });
  return finish(input, {
    ...withLevel,
    state: "APPROVED",
    reason: "APPROVAL_GRANTED",
    binding,
    humanApprovalId: fact.approvalId,
  });
}

function factMatches(
  fact: ApprovalFact,
  input: ApprovalAssessmentInput,
  binding: string,
  config: ApprovalConfig,
): { state: ApprovalState; reason: ApprovalReason } | null {
  if (fact.approved !== true) return { state: "REJECTED", reason: "APPROVAL_DENIED" };
  if (fact.approvalPolicyVersion !== config.version) return { state: "REJECTED", reason: "APPROVAL_MISMATCH" };
  if (fact.proposalBinding !== binding) return { state: "REJECTED", reason: "APPROVAL_MISMATCH" };
  if (fact.instrument !== XAUUSD_INSTRUMENT) return { state: "INVALID", reason: "INVALID_INSTRUMENT" };
  if (
    fact.decisionId !== input.decision?.id
    || fact.orderIntentId !== input.orderIntent?.id
    || fact.riskDecisionId !== input.risk.id
    || fact.policyDecisionId !== input.policy.id
    || fact.environment !== input.environment
    || fact.approvalRequestId !== input.approvalRequestId
  ) {
    return { state: "REJECTED", reason: "APPROVAL_MISMATCH" };
  }
  const age = ageMillis(fact.approvedAt, input.evaluatedAt);
  if (age === "bad") return { state: "INVALID", reason: "INVALID_INPUT" };
  if (age < 0) return { state: "INVALID", reason: "APPROVAL_FUTURE" };
  if (age > config.maxAgeMs) return { state: "BLOCKED", reason: "APPROVAL_STALE" };
  return null;
}

/** Structural read of a caller-supplied approval fact. Null means absent.
 * "bad" means the object is not a fact. This does not grant approval. */
export function readApprovalFact(value: unknown): ApprovalFact | null | "bad" {
  return readFact(value);
}

function readFact(value: unknown): ApprovalFact | null | "bad" {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "bad";
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!FACT_KEYS.has(key)) return "bad";
  }
  if (record.approved !== true && record.approved !== false) return "bad";
  if (record.instrument !== XAUUSD_INSTRUMENT) return "bad";
  const environment = tradingEnvironmentSchema.safeParse(record.environment);
  if (!environment.success) return "bad";
  const ids = [
    record.approvalId,
    record.approvalRequestId,
    record.approvedBy,
    record.decisionId,
    record.orderIntentId,
    record.riskDecisionId,
    record.policyDecisionId,
    record.proposalBinding,
  ];
  if (ids.some((id) => !recordIdSchema.safeParse(id).success)) return "bad";
  if (typeof record.approvalPolicyVersion !== "string" || record.approvalPolicyVersion.trim().length < 1) return "bad";
  if (!utcTimestampSchema.safeParse(record.approvedAt).success) return "bad";
  return {
    approvalId: record.approvalId as string,
    approvalRequestId: record.approvalRequestId as string,
    approved: record.approved,
    approvedBy: record.approvedBy as string,
    approvedAt: record.approvedAt as string,
    decisionId: record.decisionId as string,
    orderIntentId: record.orderIntentId as string,
    riskDecisionId: record.riskDecisionId as string,
    policyDecisionId: record.policyDecisionId as string,
    environment: environment.data,
    instrument: "XAUUSD",
    approvalPolicyVersion: record.approvalPolicyVersion.trim(),
    proposalBinding: record.proposalBinding as string,
  };
}

function readSwitch(
  value: unknown,
  environment: TradingEnvironment,
  agentRunId: string,
): "open" | "KILL_SWITCH_ENGAGED" | "KILL_SWITCH_UNKNOWN" {
  try {
    const state = parseKillSwitchState(value);
    if (state.environment !== environment || state.agentRunId !== agentRunId) return "KILL_SWITCH_UNKNOWN";
    return state.engaged ? "KILL_SWITCH_ENGAGED" : "open";
  } catch {
    return "KILL_SWITCH_UNKNOWN";
  }
}

function readAutonomy(
  value: unknown,
  environment: TradingEnvironment,
  agentRunId: string,
): { ok: true; level: AutonomyLevel } | { ok: false; state: ApprovalState; reason: ApprovalReason } {
  try {
    const state = parseAutonomyState(value);
    if (state.environment !== environment || state.agentRunId !== agentRunId) {
      return { ok: false, state: "INVALID", reason: "INVALID_INPUT" };
    }
    return { ok: true, level: state.level };
  } catch {
    return { ok: false, state: "INVALID", reason: "INVALID_INPUT" };
  }
}

function readPermissions(value: unknown): readonly TradingPermission[] | "bad" {
  if (!Array.isArray(value)) return "bad";
  const permissions: TradingPermission[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !(TRADING_PERMISSIONS as readonly string[]).includes(entry)) return "bad";
    permissions.push(entry as TradingPermission);
  }
  return permissions;
}

function emptyOutcome(): Outcome {
  return {
    state: "INVALID",
    reason: "INVALID_INPUT",
    binding: null,
    humanApprovalId: null,
    level: null,
    environment: null,
    provenance: null,
    configId: null,
    configVersion: null,
  };
}

function finish(input: ApprovalAssessmentInput, outcome: Outcome): ApprovalDecision {
  const evaluationRunId = input.evaluationRunId ?? null;
  const id = `appr.${contentHash({
    schema: APPROVAL_ENGINE_VERSION,
    state: outcome.state,
    reason: outcome.reason,
    binding: outcome.binding,
    humanApprovalId: outcome.humanApprovalId,
    requestId: input.approvalRequestId,
    decisionId: input.decision?.id ?? null,
    orderIntentId: input.orderIntent?.id ?? null,
    riskId: input.risk.id,
    policyId: input.policy.id,
    environment: outcome.environment,
    provenance: outcome.provenance,
    level: outcome.level,
    configId: outcome.configId,
    agentRunId: input.agentRunId,
    evaluationRunId,
    evaluatedAt: input.evaluatedAt,
  }).slice(0, 40)}`;
  const correlationId = evaluationRunId ?? input.decision?.id ?? input.agentRunId;
  const events = outcome.environment === null
    ? []
    : [
      fact(input, outcome, id, "approval.requested", "started", correlationId),
      fact(input, outcome, id, approvalEvent(outcome.state), outcome.state, correlationId),
    ].filter((event): event is TradingEvent => event !== null);
  return {
    schemaVersion: APPROVAL_ENGINE_VERSION,
    id,
    state: outcome.state,
    reasons: [outcome.reason] as ApprovalDecision["reasons"],
    binding: outcome.binding,
    humanApprovalId: outcome.humanApprovalId,
    approvalRequestId: recordIdSchema.safeParse(input.approvalRequestId).success ? input.approvalRequestId : null,
    decisionId: input.decision?.id ?? null,
    orderIntentId: input.orderIntent?.id ?? null,
    riskDecisionId: input.risk.id,
    policyDecisionId: input.policy.id,
    environment: outcome.environment,
    provenance: outcome.provenance,
    autonomyLevel: outcome.level,
    configId: outcome.configId,
    configVersion: outcome.configVersion,
    agentRunId: input.agentRunId,
    evaluationRunId,
    liveExecutionEnabled: false,
    events,
  };
}

function closed(input: ApprovalAssessmentInput, reason: "SYSTEM_ERROR" | "CREDENTIALS_FORBIDDEN"): ApprovalDecision {
  const agentRunId = typeof input.agentRunId === "string" && recordIdSchema.safeParse(input.agentRunId).success
    ? input.agentRunId
    : "run.unknown";
  const evaluatedAt = typeof input.evaluatedAt === "string" ? input.evaluatedAt : "";
  return {
    schemaVersion: APPROVAL_ENGINE_VERSION,
    id: `appr.${contentHash({ kind: "approval-closed", reason, agentRunId, evaluatedAt }).slice(0, 40)}`,
    state: "INVALID",
    reasons: [reason] as ApprovalDecision["reasons"],
    binding: null,
    humanApprovalId: null,
    approvalRequestId: null,
    decisionId: null,
    orderIntentId: null,
    riskDecisionId: null,
    policyDecisionId: null,
    environment: null,
    provenance: null,
    autonomyLevel: null,
    configId: null,
    configVersion: null,
    agentRunId,
    evaluationRunId: null,
    liveExecutionEnabled: false,
    events: [],
  };
}

function approvalEvent(state: ApprovalState): TradingEventType {
  if (state === "APPROVED") return "approval.approved";
  if (state === "REJECTED") return "approval.rejected";
  if (state === "BLOCKED") return "approval.blocked";
  return "approval.invalid";
}

function fact(
  input: ApprovalAssessmentInput,
  outcome: Outcome,
  id: string,
  type: TradingEventType,
  nextState: string,
  correlationId: string,
): TradingEvent | null {
  if (outcome.environment === null) return null;
  const prefix = type === "approval.requested" ? "aq" : "ae";
  return tradingFact({
    type,
    eventId: `${prefix}.${id}`,
    at: input.evaluatedAt,
    agentRunId: input.agentRunId,
    correlationId,
    environment: outcome.environment,
    actor: "xauusd-approval",
    nextState,
    runtimeThreadId: input.runtimeThreadId,
    runtimeTurnId: input.runtimeTurnId,
    payload: {
      state: outcome.state,
      reasons: [outcome.reason],
      approvalDecisionId: id,
      humanApprovalId: outcome.humanApprovalId,
      decisionId: input.decision?.id ?? null,
      orderIntentId: input.orderIntent?.id ?? null,
      riskDecisionId: input.risk.id,
      policyDecisionId: input.policy.id,
      provenance: outcome.provenance,
      configVersion: outcome.configVersion,
      fact: approvalInfrastructureFact(outcome.state),
      liveExecutionEnabled: false,
    },
  });
}

function seal(decision: ApprovalDecision): ApprovalDecision {
  return Object.freeze({
    ...decision,
    reasons: Object.freeze([...decision.reasons]) as ApprovalDecision["reasons"],
    events: Object.freeze([...decision.events]),
  });
}
