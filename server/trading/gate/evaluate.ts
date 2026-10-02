import { parseAutonomyState, type AutonomyLevel } from "../../../shared/trading/autonomy.ts";
import type { Decision } from "../../../shared/trading/decision.ts";
import {
  provenanceStatusSchema,
  tradingEnvironmentSchema,
  type ProvenanceStatus,
  type TradingEnvironment,
} from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import type { TradingEvent, TradingEventType } from "../../../shared/trading/events.ts";
import { assertNoSecretFields, recordIdSchema, utcTimestampSchema } from "../../../shared/trading/ids.ts";
import { XAUUSD_INSTRUMENT } from "../../../shared/trading/instrument.ts";
import { isAuthoritativeKillSwitchRepository, type KillSwitchRepository } from "../persistence/kill-switch.ts";
import type { OrderIntent } from "../../../shared/trading/order-intent.ts";
import { MARKET_FRESHNESS_STATES, type MarketFreshness } from "../../../shared/trading/snapshot.ts";
import { TRADING_PERMISSIONS, type TradingPermission } from "../agent/catalog.ts";
import { proposalBinding } from "../approval/binding.ts";
import { parseApprovalConfig } from "../approval/config.ts";
import { readApprovalFact } from "../approval/assess.ts";
import type { ApprovalDecision } from "../approval/result.ts";
import { ageMillis } from "../approval/time.ts";
import { tradingFact } from "../audit.ts";
import { parsePolicyConfig } from "../policy/config.ts";
import type { PolicyDecision } from "../policy/result.ts";
import { contentHash } from "../replay/hash.ts";
import { parseRiskConfig } from "../risk/config.ts";
import type { RiskDecision } from "../risk/result.ts";
import { parseGateConfig, GATE_ENGINE_VERSION } from "./config.ts";
import { gateInfrastructureFact, type GateDecision, type GateReason, type GateState } from "./result.ts";

export interface GateMarketFact {
  readonly snapshotId: string;
  readonly provenance: unknown;
  readonly freshness: unknown;
  readonly marketTimestamp: string;
}

export interface FireTimeGateInput {
  readonly instrument: unknown;
  readonly decision: Decision | null;
  readonly orderIntent: OrderIntent | null;
  readonly risk: RiskDecision;
  readonly policy: PolicyDecision;
  readonly approval: ApprovalDecision;
  readonly market: GateMarketFact | null;
  readonly accountEquity: number | null;
  readonly exposureLots: number | null;
  readonly environment: unknown;
  readonly provenance: unknown;
  readonly autonomy: unknown;
  readonly permissions: unknown;
  /** Ignored. `killSwitches` is the only kill-switch source for this gate. */
  readonly killSwitch: unknown;
  readonly killSwitches?: KillSwitchRepository;
  readonly approvalFact: unknown;
  readonly requestedQuantity: number | null;
  readonly riskConfig: unknown;
  readonly policyConfig: unknown;
  readonly approvalConfig: unknown;
  readonly gateConfig: unknown;
  readonly evaluatedAt: string;
  readonly agentRunId: string;
  readonly evaluationRunId?: string | null;
  readonly runtimeThreadId?: string | null;
  readonly runtimeTurnId?: string | null;
  readonly simulateInternalFailure?: boolean;
}

type Outcome = {
  readonly state: GateState;
  readonly reason: GateReason;
  readonly binding: string | null;
  readonly environment: TradingEnvironment | null;
  readonly provenance: ProvenanceStatus | null;
  readonly gateConfigVersion: string | null;
  readonly approvalId: string | null;
};

/** Final authorization check. ELIGIBLE_FOR_EXECUTION is not a broker submit. */
export function evaluateFireTimeGate(input: FireTimeGateInput): GateDecision {
  try {
    if (input.simulateInternalFailure === true) throw new Error("simulated gate failure");
    assertNoSecretFields(input, "execution gate input");
    return seal(decide(input));
  } catch (error) {
    const reason = error instanceof TradingDomainError && error.code === "credentials_forbidden"
      ? "CREDENTIALS_FORBIDDEN"
      : "SYSTEM_ERROR";
    return seal(closed(input, reason));
  }
}

function decide(input: FireTimeGateInput): GateDecision {
  const blank = empty();
  if (!recordIdSchema.safeParse(input.agentRunId).success || !utcTimestampSchema.safeParse(input.evaluatedAt).success) {
    return finish(input, blank);
  }
  if (input.instrument !== XAUUSD_INSTRUMENT) return finish(input, { ...blank, reason: "INVALID_INSTRUMENT" });
  const environment = tradingEnvironmentSchema.safeParse(input.environment);
  const provenance = provenanceStatusSchema.safeParse(input.provenance);
  if (!environment.success || !provenance.success) return finish(input, { ...blank, reason: "INVALID_INPUT" });
  const located: Outcome = { ...blank, environment: environment.data, provenance: provenance.data };
  const gateConfig = parseGateConfig(input.gateConfig);
  if (!gateConfig.ok) {
    return finish(input, {
      ...located,
      state: "BLOCKED",
      reason: gateConfig.missingFreshness ? "GATE_FRESHNESS_UNCONFIGURED" : "GATE_CONFIG_INVALID",
    });
  }
  const configured: Outcome = { ...located, gateConfigVersion: gateConfig.config.version };
  const kill = readStoredSwitch(input.killSwitches, environment.data, input.agentRunId);
  if (kill !== "open") return finish(input, { ...configured, state: "BLOCKED", reason: kill });
  const provenanceFailure = provenanceBlocks(environment.data, provenance.data);
  if (provenanceFailure !== null) return finish(input, { ...configured, state: "BLOCKED", reason: provenanceFailure });
  const marketFailure = marketBlocks(input, gateConfig.config.maxMarketAgeMs);
  if (marketFailure !== null) return finish(input, { ...configured, state: marketFailure.state, reason: marketFailure.reason });
  const structure = structureBlocks(input, environment.data);
  if (structure !== null) return finish(input, { ...configured, state: structure.state, reason: structure.reason });
  const decision = input.decision;
  const intent = input.orderIntent;
  if (decision === null || intent === null || intent.entry === undefined || intent.stop === undefined) {
    return finish(input, { ...configured, reason: "INVALID_INPUT" });
  }
  const proposalFailure = proposalChanged(input, decision, intent, environment.data);
  if (proposalFailure !== null) return finish(input, { ...configured, state: "BLOCKED", reason: proposalFailure });
  if (input.risk.state !== "ACCEPT") {
    return finish(input, { ...configured, state: riskState(input.risk.state), reason: "RISK_NOT_ACCEPTED" });
  }
  const riskFacts = riskFactsChanged(input);
  if (riskFacts !== null) return finish(input, { ...configured, state: riskFacts, reason: riskFacts === "BLOCKED" ? "RISK_FACTS_UNAVAILABLE" : "REQUIRES_RISK_REASSESSMENT" });
  if (
    input.risk.trace.requestedQuantity !== null
    && input.risk.trace.acceptedQuantity !== input.risk.trace.requestedQuantity
  ) {
    return finish(input, { ...configured, state: "BLOCKED", reason: "SILENT_REPAIR_REJECTED" });
  }
  if (input.policy.state !== "ALLOW") {
    const state: GateState = input.policy.state === "BLOCKED" ? "BLOCKED" : input.policy.state === "INVALID" ? "INVALID" : "REJECTED";
    return finish(input, { ...configured, state, reason: "POLICY_NOT_ELIGIBLE" });
  }
  const policyFacts = policyFactsChanged(input);
  if (policyFacts !== null) return finish(input, { ...configured, state: "REQUIRES_POLICY_REASSESSMENT", reason: "REQUIRES_POLICY_REASSESSMENT" });
  const autonomy = readAutonomy(input.autonomy, environment.data, input.agentRunId);
  if (autonomy.ok === false) return finish(input, { ...configured, state: "INVALID", reason: "INVALID_INPUT" });
  if (autonomy.level < 3) return finish(input, { ...configured, state: "REJECTED", reason: "AUTONOMY_INSUFFICIENT" });
  if (input.policy.progression !== "ELIGIBLE_FOR_FUTURE_EXECUTION") {
    return finish(input, { ...configured, state: "REJECTED", reason: "POLICY_NOT_ELIGIBLE" });
  }
  const permissions = readPermissions(input.permissions);
  if (permissions === "bad" || !permissions.includes("decision.propose") || !permissions.includes("intent.propose")) {
    return finish(input, { ...configured, state: "REJECTED", reason: "PERMISSION_MISSING" });
  }
  const approvalFailure = approvalBlocks(input, decision, intent, environment.data, provenance.data);
  if (approvalFailure !== null) {
    return finish(input, { ...configured, state: approvalFailure.state, reason: approvalFailure.reason, approvalId: input.approval.humanApprovalId });
  }
  const binding = proposalBinding({
    instrument: "XAUUSD",
    agentRunId: input.agentRunId,
    decisionId: decision.id,
    orderIntentId: intent.id,
    riskDecisionId: input.risk.id,
    policyDecisionId: input.policy.id,
    environment: environment.data,
    provenance: provenance.data,
    direction: intent.direction,
    entry: intent.entry,
    stop: intent.stop,
    targets: intent.targets,
    requestedQuantity: input.requestedQuantity,
    acceptedQuantity: input.risk.trace.acceptedQuantity,
    riskConfigId: input.risk.configId ?? "",
    policyConfigId: input.policy.configId ?? "",
  });
  return finish(input, {
    ...configured,
    state: "ELIGIBLE_FOR_EXECUTION",
    reason: "ELIGIBLE",
    binding,
    approvalId: input.approval.humanApprovalId,
  });
}

function provenanceBlocks(environment: TradingEnvironment, provenance: ProvenanceStatus): GateReason | null {
  if (provenance === "REPLAY") return "REPLAY_RESEARCH_ONLY";
  if (provenance === "UNAVAILABLE") return "MARKET_DATA_UNAVAILABLE";
  if (provenance === "STALE") return "MARKET_DATA_STALE";
  if (provenance === "SIMULATOR" && environment !== "SIMULATOR") return "PROVENANCE_REJECTED";
  if (environment === "SIMULATOR" && provenance === "LIVE") return "PROVENANCE_REJECTED";
  if (environment === "LIVE" && provenance !== "LIVE") return "PROVENANCE_REJECTED";
  if (environment === "PAPER" && provenance !== "LIVE") return "PROVENANCE_REJECTED";
  return null;
}

function marketBlocks(input: FireTimeGateInput, maxAgeMs: number): { state: GateState; reason: GateReason } | null {
  const market = input.market;
  if (market === null) return { state: "BLOCKED", reason: "MARKET_DATA_UNAVAILABLE" };
  if (typeof market.freshness !== "string" || !(MARKET_FRESHNESS_STATES as readonly string[]).includes(market.freshness)) {
    return { state: "INVALID", reason: "INVALID_INPUT" };
  }
  const freshness = market.freshness as MarketFreshness;
  if (freshness === "unavailable" || freshness === "invalid" || freshness === "future_dated") {
    return { state: "BLOCKED", reason: "MARKET_DATA_UNAVAILABLE" };
  }
  if (freshness === "stale") return { state: "BLOCKED", reason: "MARKET_DATA_STALE" };
  const age = ageMillis(market.marketTimestamp, input.evaluatedAt);
  if (age === "bad") return { state: "INVALID", reason: "INVALID_INPUT" };
  if (age < 0) return { state: "INVALID", reason: "MARKET_TIMESTAMP_FUTURE" };
  if (age > maxAgeMs) return { state: "BLOCKED", reason: "MARKET_DATA_STALE" };
  return null;
}

function structureBlocks(input: FireTimeGateInput, environment: TradingEnvironment): { state: GateState; reason: GateReason } | null {
  const decision = input.decision;
  const intent = input.orderIntent;
  if (decision === null) return { state: "INVALID", reason: "INVALID_INPUT" };
  if (decision.instrument !== XAUUSD_INSTRUMENT || decision.agentRunId !== input.agentRunId) {
    return { state: "INVALID", reason: "INVALID_INSTRUMENT" };
  }
  if (decision.environment !== environment) return { state: "BLOCKED", reason: "ENVIRONMENT_REJECTED" };
  if (decision.direction === "NO_TRADE" || decision.direction === "WAIT") {
    return { state: "INVALID", reason: intent === null ? "INTENT_NOT_ALLOWED" : "INTENT_NOT_ALLOWED" };
  }
  if (intent === null) return { state: "INVALID", reason: "INVALID_INPUT" };
  if (intent.instrument !== XAUUSD_INSTRUMENT) return { state: "INVALID", reason: "INVALID_INSTRUMENT" };
  if (intent.executable !== false || intent.brokerSubmit !== false) return { state: "INVALID", reason: "INTENT_FLAGS_INVALID" };
  if (intent.direction !== decision.direction) return { state: "INVALID", reason: "DIRECTION_MISMATCH" };
  if (intent.environment !== environment) return { state: "BLOCKED", reason: "ENVIRONMENT_REJECTED" };
  if (intent.entry === undefined) return { state: "INVALID", reason: "MISSING_ENTRY" };
  if (intent.stop === undefined) return { state: "INVALID", reason: "MISSING_STOP" };
  if (decision.targets.length !== intent.targets.length) return { state: "INVALID", reason: "INVALID_INPUT" };
  for (let index = 0; index < intent.targets.length; index += 1) {
    if (decision.targets[index] !== intent.targets[index]) return { state: "INVALID", reason: "INVALID_INPUT" };
  }
  return null;
}

function proposalChanged(
  input: FireTimeGateInput,
  decision: Decision,
  intent: OrderIntent,
  environment: TradingEnvironment,
): GateReason | null {
  const trace = input.risk.trace;
  if (input.risk.decisionId !== decision.id || input.risk.orderIntentId !== intent.id) return "PROPOSAL_CHANGED";
  if (input.policy.riskDecisionId !== input.risk.id) return "PROPOSAL_CHANGED";
  if (trace.entry !== intent.entry || trace.stop !== intent.stop) return "PROPOSAL_CHANGED";
  if (trace.requestedQuantity !== input.requestedQuantity) return "PROPOSAL_CHANGED";
  if (input.risk.check !== null && input.risk.check.environment !== environment) return "PROPOSAL_CHANGED";
  if (input.policy.check !== null && input.policy.check.environment !== environment) return "PROPOSAL_CHANGED";
  return null;
}

function riskFactsChanged(input: FireTimeGateInput): GateState | null {
  if (input.accountEquity === null || input.exposureLots === null || input.market === null) return "BLOCKED";
  if (input.risk.configId === null || input.risk.snapshotId === null) return "BLOCKED";
  const config = parseRiskConfig(input.riskConfig);
  if (!config.ok || config.configId !== input.risk.configId) return "REQUIRES_RISK_REASSESSMENT";
  if (input.market.snapshotId !== input.risk.snapshotId) return "REQUIRES_RISK_REASSESSMENT";
  if (input.accountEquity !== input.risk.trace.equity) return "REQUIRES_RISK_REASSESSMENT";
  if (input.exposureLots !== input.risk.trace.openExposureLots) return "REQUIRES_RISK_REASSESSMENT";
  if (input.market.provenance !== input.risk.trace.marketProvenance) return "REQUIRES_RISK_REASSESSMENT";
  return null;
}

function policyFactsChanged(input: FireTimeGateInput): true | null {
  if (input.policy.configId === null) return true;
  const config = parsePolicyConfig(input.policyConfig);
  if (!config.ok || config.configId !== input.policy.configId) return true;
  const autonomy = readAutonomy(input.autonomy, input.environment as TradingEnvironment, input.agentRunId);
  if (autonomy.ok === false || autonomy.level !== input.policy.autonomyLevel) return true;
  if (input.approval.provenance !== null && input.approval.provenance !== input.provenance) return true;
  return null;
}

function approvalBlocks(
  input: FireTimeGateInput,
  decision: Decision,
  intent: OrderIntent,
  environment: TradingEnvironment,
  provenance: ProvenanceStatus,
): { state: GateState; reason: GateReason } | null {
  const approval = input.approval;
  if (approval.state === "REJECTED" && approval.reasons[0] === "APPROVAL_REQUIRED") {
    return { state: "REQUIRES_APPROVAL", reason: "REQUIRES_APPROVAL" };
  }
  if (approval.state === "REJECTED") return { state: "REJECTED", reason: "APPROVAL_REJECTED" };
  if (approval.state === "BLOCKED") return { state: "BLOCKED", reason: "APPROVAL_REJECTED" };
  if (approval.state === "INVALID") return { state: "BLOCKED", reason: "APPROVAL_MISMATCH" };
  if (approval.binding === null) return { state: "BLOCKED", reason: "APPROVAL_MISMATCH" };
  if (approval.reasons[0] === "APPROVAL_NOT_REQUIRED") {
    const level = input.policy.autonomyLevel;
    if (level !== 4 && level !== 5) return { state: "REQUIRES_APPROVAL", reason: "REQUIRES_APPROVAL" };
  }
  const binding = proposalBinding({
    instrument: "XAUUSD",
    agentRunId: input.agentRunId,
    decisionId: decision.id,
    orderIntentId: intent.id,
    riskDecisionId: input.risk.id,
    policyDecisionId: input.policy.id,
    environment,
    provenance,
    direction: intent.direction,
    entry: intent.entry ?? 0,
    stop: intent.stop ?? 0,
    targets: intent.targets,
    requestedQuantity: input.requestedQuantity,
    acceptedQuantity: input.risk.trace.acceptedQuantity,
    riskConfigId: input.risk.configId ?? "",
    policyConfigId: input.policy.configId ?? "",
  });
  if (approval.binding !== binding) return { state: "BLOCKED", reason: "PROPOSAL_CHANGED" };
  if (
    approval.decisionId !== decision.id
    || approval.orderIntentId !== intent.id
    || approval.riskDecisionId !== input.risk.id
    || approval.policyDecisionId !== input.policy.id
    || approval.environment !== environment
  ) {
    return { state: "BLOCKED", reason: "APPROVAL_MISMATCH" };
  }
  return humanFactBlocks(input, binding, approval.reasons[0] === "APPROVAL_NOT_REQUIRED");
}

function humanFactBlocks(
  input: FireTimeGateInput,
  binding: string,
  notRequired: boolean,
): { state: GateState; reason: GateReason } | null {
  if (notRequired && input.approvalFact == null) return null;
  const config = parseApprovalConfig(input.approvalConfig);
  if (!config.ok) {
    return {
      state: "BLOCKED",
      reason: config.missingFreshness ? "APPROVAL_FRESHNESS_UNCONFIGURED" : "APPROVAL_CONFIG_INVALID",
    };
  }
  const fact = readApprovalFact(input.approvalFact);
  if (fact === "bad") return { state: "BLOCKED", reason: "APPROVAL_MISMATCH" };
  if (fact === null) return { state: "REQUIRES_APPROVAL", reason: "REQUIRES_APPROVAL" };
  if (fact.approved !== true) return { state: "REJECTED", reason: "APPROVAL_REJECTED" };
  if (fact.approvalPolicyVersion !== config.config.version) return { state: "BLOCKED", reason: "APPROVAL_MISMATCH" };
  if (fact.proposalBinding !== binding) return { state: "BLOCKED", reason: "PROPOSAL_CHANGED" };
  if (
    fact.decisionId !== input.decision?.id
    || fact.orderIntentId !== input.orderIntent?.id
    || fact.riskDecisionId !== input.risk.id
    || fact.policyDecisionId !== input.policy.id
    || fact.environment !== input.environment
    || fact.instrument !== "XAUUSD"
  ) {
    return { state: "BLOCKED", reason: "APPROVAL_MISMATCH" };
  }
  if (input.approval.humanApprovalId !== null && input.approval.humanApprovalId !== fact.approvalId) {
    return { state: "BLOCKED", reason: "APPROVAL_MISMATCH" };
  }
  const age = ageMillis(fact.approvedAt, input.evaluatedAt);
  if (age === "bad") return { state: "INVALID", reason: "INVALID_INPUT" };
  if (age < 0) return { state: "INVALID", reason: "APPROVAL_FUTURE" };
  if (age > config.config.maxAgeMs) return { state: "BLOCKED", reason: "APPROVAL_STALE" };
  return null;
}

function riskState(state: RiskDecision["state"]): GateState {
  if (state === "BLOCKED") return "BLOCKED";
  if (state === "INVALID") return "INVALID";
  return "REJECTED";
}

function readStoredSwitch(
  repository: KillSwitchRepository | undefined,
  environment: TradingEnvironment,
  agentRunId: string,
): "open" | "KILL_SWITCH_ENGAGED" | "KILL_SWITCH_UNKNOWN" {
  if (!isAuthoritativeKillSwitchRepository(repository)) return "KILL_SWITCH_UNKNOWN";
  try {
    const read = repository.authority().read(environment, agentRunId);
    if (read.status === "open") return "open";
    if (read.status === "engaged") return "KILL_SWITCH_ENGAGED";
    return "KILL_SWITCH_UNKNOWN";
  } catch {
    return "KILL_SWITCH_UNKNOWN";
  }
}

function readAutonomy(
  value: unknown,
  environment: TradingEnvironment,
  agentRunId: string,
): { ok: true; level: AutonomyLevel } | { ok: false } {
  try {
    const state = parseAutonomyState(value);
    if (state.environment !== environment || state.agentRunId !== agentRunId) return { ok: false };
    return { ok: true, level: state.level };
  } catch {
    return { ok: false };
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

function empty(): Outcome {
  return {
    state: "INVALID",
    reason: "INVALID_INPUT",
    binding: null,
    environment: null,
    provenance: null,
    gateConfigVersion: null,
    approvalId: null,
  };
}

function finish(input: FireTimeGateInput, outcome: Outcome): GateDecision {
  const evaluationRunId = input.evaluationRunId ?? null;
  const id = `gate.${contentHash({
    schema: GATE_ENGINE_VERSION,
    state: outcome.state,
    reason: outcome.reason,
    binding: outcome.binding,
    decisionId: input.decision?.id ?? null,
    orderIntentId: input.orderIntent?.id ?? null,
    riskId: input.risk.id,
    policyId: input.policy.id,
    approvalId: input.approval.id,
    environment: outcome.environment,
    provenance: outcome.provenance,
    gateConfigVersion: outcome.gateConfigVersion,
    agentRunId: input.agentRunId,
    evaluationRunId,
    evaluatedAt: input.evaluatedAt,
  }).slice(0, 40)}`;
  const correlationId = evaluationRunId ?? input.decision?.id ?? input.agentRunId;
  const events = outcome.environment === null
    ? []
    : [
      fact(input, outcome, id, "execution_gate.evaluated", "started", correlationId),
      fact(input, outcome, id, gateEvent(outcome.state), outcome.state, correlationId),
    ].filter((event): event is TradingEvent => event !== null);
  return {
    schemaVersion: GATE_ENGINE_VERSION,
    id,
    state: outcome.state,
    reasons: [outcome.reason] as GateDecision["reasons"],
    binding: outcome.binding,
    decisionId: input.decision?.id ?? null,
    orderIntentId: input.orderIntent?.id ?? null,
    riskDecisionId: input.risk.id,
    policyDecisionId: input.policy.id,
    approvalId: outcome.approvalId,
    environment: outcome.environment,
    provenance: outcome.provenance,
    gateConfigVersion: outcome.gateConfigVersion,
    evaluatedAt: input.evaluatedAt,
    agentRunId: input.agentRunId,
    evaluationRunId,
    liveExecutionEnabled: false,
    orderIntentExecutable: false,
    orderIntentBrokerSubmit: false,
    events,
  };
}

function closed(input: FireTimeGateInput, reason: "SYSTEM_ERROR" | "CREDENTIALS_FORBIDDEN"): GateDecision {
  const agentRunId = typeof input.agentRunId === "string" && recordIdSchema.safeParse(input.agentRunId).success
    ? input.agentRunId
    : "run.unknown";
  const evaluatedAt = typeof input.evaluatedAt === "string" ? input.evaluatedAt : "";
  return {
    schemaVersion: GATE_ENGINE_VERSION,
    id: `gate.${contentHash({ kind: "gate-closed", reason, agentRunId, evaluatedAt }).slice(0, 40)}`,
    state: "INVALID",
    reasons: [reason] as GateDecision["reasons"],
    binding: null,
    decisionId: null,
    orderIntentId: null,
    riskDecisionId: null,
    policyDecisionId: null,
    approvalId: null,
    environment: null,
    provenance: null,
    gateConfigVersion: null,
    evaluatedAt: null,
    agentRunId,
    evaluationRunId: null,
    liveExecutionEnabled: false,
    orderIntentExecutable: false,
    orderIntentBrokerSubmit: false,
    events: [],
  };
}

function gateEvent(state: GateState): TradingEventType {
  switch (state) {
    case "ELIGIBLE_FOR_EXECUTION":
      return "execution_gate.eligible";
    case "REJECTED":
      return "execution_gate.rejected";
    case "BLOCKED":
      return "execution_gate.blocked";
    case "INVALID":
      return "execution_gate.invalid";
    case "REQUIRES_RISK_REASSESSMENT":
      return "execution_gate.requires_risk_reassessment";
    case "REQUIRES_POLICY_REASSESSMENT":
      return "execution_gate.requires_policy_reassessment";
    case "REQUIRES_APPROVAL":
      return "execution_gate.requires_approval";
  }
}

function fact(
  input: FireTimeGateInput,
  outcome: Outcome,
  id: string,
  type: TradingEventType,
  nextState: string,
  correlationId: string,
): TradingEvent | null {
  if (outcome.environment === null) return null;
  const prefix = type === "execution_gate.evaluated" ? "gs" : "ge";
  return tradingFact({
    type,
    eventId: `${prefix}.${id}`,
    at: input.evaluatedAt,
    agentRunId: input.agentRunId,
    correlationId,
    environment: outcome.environment,
    actor: "xauusd-gate",
    nextState,
    runtimeThreadId: input.runtimeThreadId,
    runtimeTurnId: input.runtimeTurnId,
    payload: {
      state: outcome.state,
      reasons: [outcome.reason],
      gateDecisionId: id,
      decisionId: input.decision?.id ?? null,
      orderIntentId: input.orderIntent?.id ?? null,
      riskDecisionId: input.risk.id,
      policyDecisionId: input.policy.id,
      approvalId: outcome.approvalId,
      provenance: outcome.provenance,
      configVersion: outcome.gateConfigVersion,
      fact: gateInfrastructureFact(outcome.state),
      liveExecutionEnabled: false,
      executable: false,
      brokerSubmit: false,
    },
  });
}

function seal(decision: GateDecision): GateDecision {
  return Object.freeze({
    ...decision,
    reasons: Object.freeze([...decision.reasons]) as GateDecision["reasons"],
    events: Object.freeze([...decision.events]),
  });
}
