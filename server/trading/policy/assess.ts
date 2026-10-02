import { AUTONOMY_NAMES, parseAutonomyState, type AutonomyLevel } from "../../../shared/trading/autonomy.ts";
import type { Decision } from "../../../shared/trading/decision.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { provenanceStatusSchema, tradingEnvironmentSchema, type ProvenanceStatus, type TradingEnvironment } from "../../../shared/trading/environment.ts";
import type { TradingEvent, TradingEventType } from "../../../shared/trading/events.ts";
import { assertNoSecretFields, recordIdSchema, utcTimestampSchema } from "../../../shared/trading/ids.ts";
import { XAUUSD_INSTRUMENT } from "../../../shared/trading/instrument.ts";
import { parseKillSwitchState } from "../../../shared/trading/kill-switch.ts";
import type { OrderIntent } from "../../../shared/trading/order-intent.ts";
import { parsePolicyCheck } from "../../../shared/trading/policy.ts";
import type { CheckStatus } from "../../../shared/trading/risk.ts";
import { MARKET_FRESHNESS_STATES, type MarketFreshness } from "../../../shared/trading/snapshot.ts";
import { TRADING_PERMISSIONS, type TradingPermission } from "../agent/catalog.ts";
import { tradingFact } from "../audit.ts";
import { contentHash } from "../replay/hash.ts";
import type { RiskDecision } from "../risk/result.ts";
import { parsePolicyConfig, POLICY_ENGINE_VERSION } from "./config.ts";
import {
  policyInfrastructureFact,
  type PolicyDecision,
  type PolicyProgression,
  type PolicyReason,
  type PolicyState,
} from "./result.ts";

const APPROVALS = ["absent", "pending", "granted", "denied"] as const;

type ApprovalFact = (typeof APPROVALS)[number];

export interface PolicyAssessmentInput {
  readonly instrument: unknown;
  readonly decision: Decision | null;
  readonly orderIntent: OrderIntent | null;
  readonly risk: RiskDecision;
  readonly environment: unknown;
  readonly provenance: unknown;
  readonly marketFreshness: unknown;
  readonly autonomy: unknown;
  readonly permissions: unknown;
  readonly approval: unknown;
  readonly killSwitch: unknown;
  readonly config: unknown;
  readonly assessedAt: string;
  readonly agentRunId: string;
  readonly evaluationRunId?: string | null;
  readonly runtimeThreadId?: string | null;
  readonly runtimeTurnId?: string | null;
  /** When set, the assessment is discarded and the result is INVALID. */
  readonly simulateInternalFailure?: boolean;
}

type Gate = {
  readonly state: PolicyState;
  readonly reason: PolicyReason;
  readonly progression: PolicyProgression;
  readonly level: AutonomyLevel | null;
  readonly configId: string | null;
  readonly environment: TradingEnvironment;
  readonly eventsEnabled: boolean;
};

export function assessXauUsdPolicy(input: PolicyAssessmentInput): PolicyDecision {
  try {
    if (input.simulateInternalFailure === true) throw new Error("simulated policy failure");
    assertNoSecretFields(input, "policy input");
    return sealDecision(calculate(input));
  } catch (error) {
    const reason = error instanceof TradingDomainError && error.code === "credentials_forbidden"
      ? "CREDENTIALS_FORBIDDEN"
      : "SYSTEM_ERROR";
    return sealDecision(closed(input, reason));
  }
}

function sealDecision(decision: PolicyDecision): PolicyDecision {
  return Object.freeze({
    ...decision,
    reasons: Object.freeze([...decision.reasons]) as PolicyDecision["reasons"],
    events: Object.freeze([...decision.events]),
  });
}

function closed(input: PolicyAssessmentInput, reason: "SYSTEM_ERROR" | "CREDENTIALS_FORBIDDEN"): PolicyDecision {
  const agentRunId = typeof input.agentRunId === "string" && recordIdSchema.safeParse(input.agentRunId).success
    ? input.agentRunId
    : "run.unknown";
  const assessedAt = typeof input.assessedAt === "string" ? input.assessedAt : "";
  return {
    schemaVersion: POLICY_ENGINE_VERSION,
    id: `policy.${contentHash({ kind: "policy-closed", reason, agentRunId, assessedAt }).slice(0, 40)}`,
    state: "INVALID",
    progression: "NONE",
    reasons: [reason],
    check: null,
    agentRunId,
    evaluationRunId: null,
    configId: null,
    riskDecisionId: null,
    autonomyLevel: null,
    liveExecutionEnabled: false,
    brokerSubmit: false,
    events: [],
  };
}

function calculate(input: PolicyAssessmentInput): PolicyDecision {
  const agentRunId = input.agentRunId;
  const blank: Gate = {
    state: "INVALID",
    reason: "INVALID_INPUT",
    progression: "NONE",
    level: null,
    configId: null,
    environment: "SIMULATOR",
    eventsEnabled: false,
  };
  if (!recordIdSchema.safeParse(agentRunId).success || !utcTimestampSchema.safeParse(input.assessedAt).success) {
    return finish(input, blank);
  }
  if (input.evaluationRunId != null && !recordIdSchema.safeParse(input.evaluationRunId).success) {
    return finish(input, blank);
  }
  if (input.instrument !== XAUUSD_INSTRUMENT) return finish(input, { ...blank, reason: "INVALID_INSTRUMENT" });
  const environment = tradingEnvironmentSchema.safeParse(input.environment);
  if (!environment.success) return finish(input, { ...blank, reason: "ENVIRONMENT_REJECTED" });
  const provenance = provenanceStatusSchema.safeParse(input.provenance);
  if (!provenance.success) {
    return finish(input, { ...blank, environment: environment.data, eventsEnabled: true, reason: "INVALID_INPUT" });
  }
  if (typeof input.marketFreshness !== "string" || !(MARKET_FRESHNESS_STATES as readonly string[]).includes(input.marketFreshness)) {
    return finish(input, { ...blank, environment: environment.data, eventsEnabled: true, reason: "INVALID_INPUT" });
  }
  const freshness = input.marketFreshness as MarketFreshness;
  const configRead = parsePolicyConfig(input.config);
  if (!configRead.ok) {
    return finish(input, { ...blank, environment: environment.data, eventsEnabled: true, reason: "POLICY_CONFIG_INVALID" });
  }
  const located: Gate = {
    ...blank,
    environment: environment.data,
    configId: configRead.configId,
    eventsEnabled: true,
  };
  const decision = input.decision;
  if (decision === null || decision.instrument !== XAUUSD_INSTRUMENT || decision.agentRunId !== agentRunId) {
    return finish(input, { ...located, reason: decision?.instrument !== XAUUSD_INSTRUMENT && decision !== null ? "INVALID_INSTRUMENT" : "INVALID_INPUT" });
  }
  if (decision.environment !== environment.data) return finish(input, { ...located, reason: "ENVIRONMENT_REJECTED" });
  const kill = readSwitch(input.killSwitch, environment.data, agentRunId);
  if (kill !== "open") return finish(input, { ...located, state: "BLOCKED", reason: kill });
  if (input.risk.state !== "ACCEPT") return finish(input, { ...located, state: "REJECT", reason: "RISK_NOT_ACCEPTED" });
  const intent = input.orderIntent;
  if (intent !== null) {
    if (intent.executable !== false || intent.brokerSubmit !== false) {
      return finish(input, { ...located, reason: "INTENT_FLAGS_INVALID" });
    }
    if (intent.environment !== environment.data || intent.agentRunId !== agentRunId || intent.instrument !== XAUUSD_INSTRUMENT) {
      return finish(input, { ...located, reason: "ENVIRONMENT_REJECTED" });
    }
  }
  const autonomy = readAutonomy(input.autonomy, environment.data, agentRunId);
  if (autonomy.ok === false) return finish(input, { ...located, state: autonomy.state, reason: autonomy.reason });
  const approval = readApproval(input.approval);
  if (approval === "bad") return finish(input, { ...located, level: autonomy.level, reason: "APPROVAL_INVALID" });
  const permissions = readPermissions(input.permissions);
  if (permissions === "bad") return finish(input, { ...located, level: autonomy.level, reason: "INVALID_INPUT" });
  const capability = capabilityFor(autonomy.level, decision, intent);
  if (capability.ok === false) {
    return finish(input, { ...located, state: "REJECT", level: autonomy.level, reason: capability.reason });
  }
  if (!permissions.includes("decision.propose")) {
    return finish(input, { ...located, state: "REJECT", level: autonomy.level, reason: "PERMISSION_MISSING" });
  }
  if (intent !== null && !permissions.includes("intent.propose")) {
    return finish(input, { ...located, state: "REJECT", level: autonomy.level, reason: "PERMISSION_MISSING" });
  }
  const provenanceGate = provenanceAllows(environment.data, provenance.data);
  if (provenanceGate !== null) return finish(input, { ...located, state: "REJECT", level: autonomy.level, reason: provenanceGate });
  if (freshness === "unavailable" || freshness === "invalid" || freshness === "future_dated" || provenance.data === "UNAVAILABLE") {
    return finish(input, { ...located, state: "BLOCKED", level: autonomy.level, reason: "MARKET_DATA_UNAVAILABLE" });
  }
  let progression = capability.progression;
  if (progression === "ELIGIBLE_FOR_FUTURE_EXECUTION" && provenance.data === "REPLAY") {
    return finish(input, { ...located, state: "REJECT", level: autonomy.level, reason: "REPLAY_RESEARCH_ONLY" });
  }
  if (progression === "ELIGIBLE_FOR_FUTURE_EXECUTION" && (freshness !== "fresh" || provenance.data === "STALE")) {
    return finish(input, { ...located, state: "BLOCKED", level: autonomy.level, reason: "MARKET_DATA_STALE" });
  }
  if (progression === "ELIGIBLE_FOR_FUTURE_EXECUTION" && autonomy.level === 3 && approval !== "granted") {
    return finish(input, { ...located, state: "REJECT", level: autonomy.level, reason: "APPROVAL_REQUIRED" });
  }
  const reason: PolicyReason = progression === "ELIGIBLE_FOR_FUTURE_EXECUTION"
    ? "POLICY_ALLOWED"
    : progression === "ANALYSIS_ONLY"
      ? "POLICY_ANALYSIS_ONLY"
      : "POLICY_RECOMMENDATION_ONLY";
  return finish(input, { ...located, state: "ALLOW", level: autonomy.level, progression, reason });
}

function capabilityFor(
  level: AutonomyLevel,
  decision: Decision,
  intent: OrderIntent | null,
): { ok: true; progression: Exclude<PolicyProgression, "NONE"> } | { ok: false; reason: PolicyReason } {
  const quiet = decision.direction === "NO_TRADE" || decision.direction === "WAIT";
  if (level === 0) return { ok: false, reason: "AUTONOMY_OBSERVE_ONLY" };
  if (level === 1) {
    if (quiet && intent === null) return { ok: true, progression: "ANALYSIS_ONLY" };
    return { ok: false, reason: "AUTONOMY_ANALYSIS_ONLY" };
  }
  if (level === 2) return { ok: true, progression: "RECOMMENDATION_ONLY" };
  if (quiet || intent === null) return { ok: true, progression: "RECOMMENDATION_ONLY" };
  return { ok: true, progression: "ELIGIBLE_FOR_FUTURE_EXECUTION" };
}

function provenanceAllows(environment: TradingEnvironment, provenance: ProvenanceStatus): PolicyReason | null {
  if (provenance === "REPLAY" && environment !== "SIMULATOR") return "REPLAY_RESEARCH_ONLY";
  if (provenance === "SIMULATOR" && environment !== "SIMULATOR") return "PROVENANCE_REJECTED";
  if (environment === "SIMULATOR" && provenance === "LIVE") return "PROVENANCE_REJECTED";
  return null;
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
): { ok: true; level: AutonomyLevel } | { ok: false; state: PolicyState; reason: PolicyReason } {
  try {
    const state = parseAutonomyState(value);
    if (state.environment !== environment) return { ok: false, state: "REJECT", reason: "ENVIRONMENT_REJECTED" };
    if (state.agentRunId !== agentRunId) return { ok: false, state: "INVALID", reason: "INVALID_INPUT" };
    if (AUTONOMY_NAMES[state.level] !== state.name) return { ok: false, state: "INVALID", reason: "AUTONOMY_REJECTED" };
    return { ok: true, level: state.level };
  } catch {
    return { ok: false, state: "INVALID", reason: "AUTONOMY_REJECTED" };
  }
}

function readApproval(value: unknown): ApprovalFact | "bad" {
  return typeof value === "string" && (APPROVALS as readonly string[]).includes(value) ? value as ApprovalFact : "bad";
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

function finish(input: PolicyAssessmentInput, gate: Gate): PolicyDecision {
  const evaluationRunId = input.evaluationRunId ?? null;
  const decisionId = input.decision?.id ?? null;
  const snapshotId = input.risk.snapshotId;
  const versionManifestId = input.decision?.versionManifestId ?? null;
  const id = `policy.${contentHash({
    schema: POLICY_ENGINE_VERSION,
    state: gate.state,
    reason: gate.reason,
    progression: gate.progression,
    level: gate.level,
    configId: gate.configId,
    riskId: input.risk.id,
    decisionId,
    agentRunId: input.agentRunId,
    evaluationRunId,
    assessedAt: input.assessedAt,
    environment: gate.environment,
  }).slice(0, 40)}`;
  const check = decisionId && snapshotId && versionManifestId && input.instrument === XAUUSD_INSTRUMENT
    ? buildCheck(input, gate, id, decisionId, snapshotId, versionManifestId)
    : null;
  const correlationId = evaluationRunId ?? decisionId ?? input.agentRunId;
  const events = gate.eventsEnabled
    ? [
      fact(input, gate, id, "policy.check.started", "started", correlationId),
      fact(input, gate, id, eventType(gate.state), gate.state, correlationId),
    ].filter((event): event is TradingEvent => event !== null)
    : [];
  return {
    schemaVersion: POLICY_ENGINE_VERSION,
    id,
    state: gate.state,
    progression: gate.progression,
    reasons: [gate.reason],
    check,
    agentRunId: input.agentRunId,
    evaluationRunId,
    configId: gate.configId,
    riskDecisionId: input.risk.id,
    autonomyLevel: gate.level,
    liveExecutionEnabled: false,
    brokerSubmit: false,
    events,
  };
}

function buildCheck(
  input: PolicyAssessmentInput,
  gate: Gate,
  id: string,
  decisionId: string,
  snapshotId: string,
  versionManifestId: string,
): PolicyDecision["check"] {
  const status: CheckStatus = gate.state === "ALLOW" ? "PASSED" : gate.state === "BLOCKED" ? "UNAVAILABLE" : "FAILED";
  try {
    return parsePolicyCheck({
      schemaVersion: 1,
      id,
      agentRunId: input.agentRunId,
      environment: gate.environment,
      instrument: XAUUSD_INSTRUMENT,
      decisionId,
      snapshotId,
      versionManifestId,
      status,
      failClosed: status !== "PASSED",
      reasons: [gate.reason],
      createdAt: input.assessedAt,
    });
  } catch {
    return null;
  }
}

function eventType(state: PolicyState): TradingEventType {
  if (state === "ALLOW") return "policy.check.passed";
  if (state === "BLOCKED") return "policy.check.blocked";
  return "policy.check.failed";
}

function fact(
  input: PolicyAssessmentInput,
  gate: Gate,
  id: string,
  type: TradingEventType,
  nextState: string,
  correlationId: string,
): TradingEvent | null {
  const prefix = type === "policy.check.started" ? "ps" : "pc";
  return tradingFact({
    type,
    eventId: `${prefix}.${id}`,
    at: input.assessedAt,
    agentRunId: input.agentRunId,
    correlationId,
    environment: gate.environment,
    actor: "xauusd-policy",
    nextState,
    runtimeThreadId: input.runtimeThreadId,
    runtimeTurnId: input.runtimeTurnId,
    payload: {
      state: gate.state,
      reasons: [gate.reason],
      progression: gate.progression,
      policyDecisionId: id,
      riskDecisionId: input.risk.id,
      configId: gate.configId,
      fact: policyInfrastructureFact(gate.state),
      liveExecutionEnabled: false,
    },
  });
}
