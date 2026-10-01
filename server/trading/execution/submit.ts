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
import { parseKillSwitchState } from "../../../shared/trading/kill-switch.ts";
import type { OrderIntent } from "../../../shared/trading/order-intent.ts";
import type { ApprovalDecision } from "../approval/result.ts";
import { proposalBinding } from "../approval/binding.ts";
import { tradingFact } from "../audit.ts";
import type { GateDecision } from "../gate/result.ts";
import { contentHash } from "../replay/hash.ts";
import type { PolicyDecision } from "../policy/result.ts";
import type { RiskDecision } from "../risk/result.ts";
import { parseMetaApiAccountBinding, type MetaApiAccountBinding } from "./binding.ts";
import { pendingAction, type BrokerOrderCommand } from "./command.ts";
import type { ExecutionAttemptRecord, ExecutionLedger } from "./ledger.ts";
import type { XauUsdExecutionProvider } from "./provider.ts";
import {
  EXECUTION_ENGINE_VERSION,
  executionInfrastructureFact,
  type ExecutionDecision,
  type ExecutionFill,
  type ExecutionReason,
  type ExecutionState,
} from "./result.ts";

export interface ExecutionQuote {
  readonly bid: number;
  readonly ask: number;
  readonly snapshotId: string;
}

export interface ExecutionSubmitInput {
  readonly instrument: unknown;
  readonly decision: Decision | null;
  readonly orderIntent: OrderIntent | null;
  readonly risk: RiskDecision;
  readonly policy: PolicyDecision;
  readonly approval: ApprovalDecision;
  readonly gate: GateDecision;
  readonly binding: unknown;
  readonly quote: ExecutionQuote | null;
  readonly killSwitch: unknown;
  readonly environment: unknown;
  readonly provenance: unknown;
  readonly requestedQuantity: number | null;
  readonly provider: XauUsdExecutionProvider;
  readonly ledger: ExecutionLedger;
  readonly submittedAt: string;
  readonly agentRunId: string;
  readonly evaluationRunId?: string | null;
  readonly runtimeThreadId?: string | null;
  readonly runtimeTurnId?: string | null;
}

interface Ready {
  readonly environment: TradingEnvironment;
  readonly provenance: ProvenanceStatus;
  readonly binding: MetaApiAccountBinding;
  readonly direction: "LONG" | "SHORT";
  readonly entry: number;
  readonly stop: number;
  readonly takeProfit: number | null;
  readonly quantity: number;
  readonly identity: string;
  readonly requestId: string;
  readonly command: BrokerOrderCommand;
}

/** Submits one authorized proposal. Anything other than ELIGIBLE_FOR_EXECUTION
 * stops here. This function does not retry and does not fall back to a simulator. */
export async function submitAuthorizedExecution(input: ExecutionSubmitInput): Promise<ExecutionDecision> {
  try {
    assertNoSecretFields(input, "execution input");
    return seal(await decide(input));
  } catch (error) {
    const reason = error instanceof TradingDomainError && error.code === "credentials_forbidden"
      ? "CREDENTIALS_FORBIDDEN"
      : "SYSTEM_ERROR";
    return seal(closed(input, reason));
  }
}

async function decide(input: ExecutionSubmitInput): Promise<ExecutionDecision> {
  if (!recordIdSchema.safeParse(input.agentRunId).success || !utcTimestampSchema.safeParse(input.submittedAt).success) {
    return finish(input, null, "NOT_SUBMITTED", "INVALID_INPUT", false, null, null, null);
  }
  if (input.instrument !== XAUUSD_INSTRUMENT) {
    return finish(input, null, "NOT_SUBMITTED", "INVALID_INSTRUMENT", false, null, null, null);
  }
  if (input.gate.state !== "ELIGIBLE_FOR_EXECUTION") {
    return finish(input, located(input), "NOT_SUBMITTED", "GATE_NOT_ELIGIBLE", false, null, null, null);
  }
  const provenanceFailure = provenanceBlocks(input.gate.provenance);
  if (provenanceFailure !== null) {
    return finish(input, located(input), "NOT_SUBMITTED", provenanceFailure, false, null, null, null);
  }
  if (input.gate.environment === "SIMULATOR") {
    return finish(input, located(input), "NOT_SUBMITTED", "ENVIRONMENT_NOT_EXECUTABLE", false, null, null, null);
  }
  const ready = authorize(input);
  if (ready.ok === false) {
    return finish(input, located(input), "NOT_SUBMITTED", ready.reason, false, null, null, null);
  }
  const prior = input.ledger.find(ready.ready.identity);
  if (prior !== null) {
    const reason = prior.state === "SUBMISSION_UNKNOWN" ? "RECONCILIATION_REQUIRED" : "DUPLICATE_EXECUTION";
    const duplicateId = `exr.${contentHash({
      schema: EXECUTION_ENGINE_VERSION,
      identity: ready.ready.identity,
      role: "duplicate",
      prior: prior.executionRequestId,
      priorState: prior.state,
    }).slice(0, 40)}`;
    return finish(input, ready.ready, "NOT_SUBMITTED", reason, false, prior.brokerRequestId, null, null, duplicateId);
  }
  const pending = attemptRecord(input, ready.ready, "SUBMISSION_UNKNOWN", null, null);
  if (!input.ledger.reserve(pending)) {
    return finish(input, ready.ready, "NOT_SUBMITTED", "RECONCILIATION_REQUIRED", false, null, null, null);
  }
  let broker;
  try {
    broker = await input.provider.submit(ready.ready.command);
  } catch {
    input.ledger.complete(attemptRecord(input, ready.ready, "SUBMISSION_UNKNOWN", null, null));
    return finish(input, ready.ready, "SUBMISSION_UNKNOWN", "BROKER_UNKNOWN", true, null, null, null);
  }
  return settle(input, ready.ready, broker);
}

function settle(
  input: ExecutionSubmitInput,
  ready: Ready,
  broker: Awaited<ReturnType<XauUsdExecutionProvider["submit"]>>,
): ExecutionDecision {
  if (broker.kind === "credentials_missing") {
    input.ledger.complete(attemptRecord(input, ready, "NOT_SUBMITTED", null, null));
    return finish(input, ready, "NOT_SUBMITTED", "CREDENTIALS_MISSING", false, null, null, null);
  }
  if (broker.kind === "unknown") {
    input.ledger.complete(attemptRecord(input, ready, "SUBMISSION_UNKNOWN", broker.brokerRequestId, null));
    return finish(input, ready, "SUBMISSION_UNKNOWN", "BROKER_UNKNOWN", true, broker.brokerRequestId, broker.brokerCode, null);
  }
  if (broker.kind === "rejected") {
    input.ledger.complete(attemptRecord(input, ready, "SUBMISSION_REJECTED", broker.brokerRequestId, null));
    return finish(input, ready, "SUBMISSION_REJECTED", "BROKER_REJECTED", true, broker.brokerRequestId, broker.brokerCode, null);
  }
  if (broker.kind === "filled") {
    if (
      broker.fillPrice === null
      || broker.fillVolume !== ready.quantity
      || broker.brokerFillId === null
      || broker.brokerRequestId === null
    ) {
      input.ledger.complete(attemptRecord(input, ready, "SUBMISSION_UNKNOWN", broker.brokerRequestId, null));
      return finish(input, ready, "SUBMISSION_UNKNOWN", "BROKER_TERMS_MISMATCH", true, broker.brokerRequestId, broker.brokerCode, null);
    }
    const fill = { brokerFillId: broker.brokerFillId, price: broker.fillPrice, volume: broker.fillVolume };
    input.ledger.complete(attemptRecord(input, ready, "FILL_REPORTED", broker.brokerRequestId, fill));
    return finish(input, ready, "FILL_REPORTED", "FILL_EXPLICIT", true, broker.brokerRequestId, broker.brokerCode, fill);
  }
  input.ledger.complete(attemptRecord(input, ready, "SUBMISSION_ACCEPTED", broker.brokerRequestId, null));
  return finish(input, ready, "SUBMISSION_ACCEPTED", "ACKNOWLEDGED", true, broker.brokerRequestId, broker.brokerCode, null);
}

function authorize(input: ExecutionSubmitInput): { ok: true; ready: Ready } | { ok: false; reason: ExecutionReason } {
  const environment = tradingEnvironmentSchema.safeParse(input.environment);
  const provenance = provenanceStatusSchema.safeParse(input.provenance);
  if (!environment.success || !provenance.success) return { ok: false, reason: "INVALID_INPUT" };
  if (environment.data !== input.gate.environment || provenance.data !== input.gate.provenance) {
    return { ok: false, reason: "AUTHORIZATION_MISMATCH" };
  }
  if (input.gate.agentRunId !== input.agentRunId) return { ok: false, reason: "AUTHORIZATION_MISMATCH" };
  const binding = parseMetaApiAccountBinding(input.binding);
  if (input.binding == null) return { ok: false, reason: "ACCOUNT_BINDING_MISSING" };
  if (binding === null) return { ok: false, reason: "ACCOUNT_BINDING_MISMATCH" };
  if (binding.environment !== environment.data) return { ok: false, reason: "ACCOUNT_BINDING_MISMATCH" };
  if (input.provider.providerId !== "metaapi-cloud" || input.provider.bindingId !== binding.bindingId) {
    return { ok: false, reason: "ACCOUNT_BINDING_MISMATCH" };
  }
  const kill = readSwitch(input.killSwitch, environment.data, input.agentRunId);
  if (kill !== "open") return { ok: false, reason: kill };
  const proposal = matchProposal(input, environment.data, provenance.data);
  if (proposal.ok === false) return proposal;
  const quote = input.quote;
  if (quote === null || quote.snapshotId !== input.risk.snapshotId) return { ok: false, reason: "ORDER_NOT_REPRESENTABLE" };
  const action = pendingAction(proposal.direction, proposal.entry, quote.bid, quote.ask);
  if (action === null) return { ok: false, reason: "ORDER_NOT_REPRESENTABLE" };
  if (!input.provider.configured) return { ok: false, reason: "CREDENTIALS_MISSING" };
  const identity = executionIdentity(input, proposal, binding.bindingId, environment.data, provenance.data);
  const requestId = `exr.${contentHash({ schema: EXECUTION_ENGINE_VERSION, identity, role: "primary" }).slice(0, 40)}`;
  const clientId = contentHash({ schema: EXECUTION_ENGINE_VERSION, identity, role: "client" }).slice(0, 26);
  return {
    ok: true,
    ready: {
      environment: environment.data,
      provenance: provenance.data,
      binding,
      direction: proposal.direction,
      entry: proposal.entry,
      stop: proposal.stop,
      takeProfit: proposal.takeProfit,
      quantity: proposal.quantity,
      identity,
      requestId,
      command: {
        instrument: "XAUUSD",
        symbol: "XAUUSD",
        direction: proposal.direction,
        actionType: action,
        volume: proposal.quantity,
        openPrice: proposal.entry,
        stopLoss: proposal.stop,
        takeProfit: proposal.takeProfit,
        clientId,
        executionRequestId: requestId,
      },
    },
  };
}

function matchProposal(
  input: ExecutionSubmitInput,
  environment: TradingEnvironment,
  provenance: ProvenanceStatus,
): { ok: true; direction: "LONG" | "SHORT"; entry: number; stop: number; takeProfit: number | null; quantity: number } | { ok: false; reason: ExecutionReason } {
  const decision = input.decision;
  const intent = input.orderIntent;
  const risk = input.risk;
  const policy = input.policy;
  const approval = input.approval;
  const gate = input.gate;
  if (decision === null || intent === null) return { ok: false, reason: "INVALID_INPUT" };
  if (intent.executable !== false || intent.brokerSubmit !== false) return { ok: false, reason: "INTENT_FLAGS_INVALID" };
  if (decision.instrument !== XAUUSD_INSTRUMENT || intent.instrument !== XAUUSD_INSTRUMENT) {
    return { ok: false, reason: "INVALID_INSTRUMENT" };
  }
  if (decision.direction !== "LONG" && decision.direction !== "SHORT") return { ok: false, reason: "ORDER_NOT_REPRESENTABLE" };
  if (intent.direction !== decision.direction) return { ok: false, reason: "PROPOSAL_MISMATCH" };
  if (intent.entry === undefined || intent.stop === undefined) return { ok: false, reason: "ORDER_NOT_REPRESENTABLE" };
  if (intent.targets.length > 1 || decision.targets.length !== intent.targets.length) {
    return { ok: false, reason: "ORDER_NOT_REPRESENTABLE" };
  }
  for (let index = 0; index < intent.targets.length; index += 1) {
    if (decision.targets[index] !== intent.targets[index]) return { ok: false, reason: "PROPOSAL_MISMATCH" };
  }
  if (risk.state !== "ACCEPT" || policy.state !== "ALLOW" || policy.progression !== "ELIGIBLE_FOR_FUTURE_EXECUTION" || approval.state !== "APPROVED") {
    return { ok: false, reason: "AUTHORIZATION_MISMATCH" };
  }
  if (
    gate.decisionId !== decision.id
    || gate.orderIntentId !== intent.id
    || gate.riskDecisionId !== risk.id
    || gate.policyDecisionId !== policy.id
    || gate.agentRunId !== decision.agentRunId
    || approval.decisionId !== decision.id
    || approval.orderIntentId !== intent.id
    || approval.riskDecisionId !== risk.id
    || approval.policyDecisionId !== policy.id
    || approval.id.length < 1
    || risk.decisionId !== decision.id
    || risk.orderIntentId !== intent.id
    || policy.riskDecisionId !== risk.id
    || gate.approvalId !== approval.humanApprovalId
    || gate.binding === null
    || approval.binding !== gate.binding
    || risk.configId === null
    || policy.configId === null
  ) {
    return { ok: false, reason: "AUTHORIZATION_MISMATCH" };
  }
  if (risk.trace.entry !== intent.entry || risk.trace.stop !== intent.stop) return { ok: false, reason: "PROPOSAL_MISMATCH" };
  if (risk.trace.requestedQuantity !== input.requestedQuantity) return { ok: false, reason: "PROPOSAL_MISMATCH" };
  if (risk.trace.acceptedQuantity === null) return { ok: false, reason: "ORDER_NOT_REPRESENTABLE" };
  if (input.requestedQuantity !== null && risk.trace.acceptedQuantity !== input.requestedQuantity) {
    return { ok: false, reason: "SILENT_REPAIR_REJECTED" };
  }
  const binding = proposalBinding({
    instrument: "XAUUSD",
    agentRunId: input.agentRunId,
    decisionId: decision.id,
    orderIntentId: intent.id,
    riskDecisionId: risk.id,
    policyDecisionId: policy.id,
    environment,
    provenance,
    direction: intent.direction,
    entry: intent.entry,
    stop: intent.stop,
    targets: intent.targets,
    requestedQuantity: input.requestedQuantity,
    acceptedQuantity: risk.trace.acceptedQuantity,
    riskConfigId: risk.configId,
    policyConfigId: policy.configId,
  });
  if (binding !== gate.binding) return { ok: false, reason: "PROPOSAL_MISMATCH" };
  return {
    ok: true,
    direction: decision.direction,
    entry: intent.entry,
    stop: intent.stop,
    takeProfit: intent.targets.length === 1 ? intent.targets[0] ?? null : null,
    quantity: risk.trace.acceptedQuantity,
  };
}

function provenanceBlocks(provenance: ProvenanceStatus | null): ExecutionReason | null {
  if (provenance === "REPLAY") return "REPLAY_RESEARCH_ONLY";
  if (provenance === "SIMULATOR") return "PROVENANCE_REJECTED";
  if (provenance === "STALE") return "PROVENANCE_REJECTED";
  if (provenance === "UNAVAILABLE") return "PROVENANCE_REJECTED";
  if (provenance !== "LIVE") return "PROVENANCE_REJECTED";
  return null;
}

function executionIdentity(
  input: ExecutionSubmitInput,
  proposal: { direction: "LONG" | "SHORT"; entry: number; stop: number; takeProfit: number | null; quantity: number },
  bindingId: string,
  environment: TradingEnvironment,
  provenance: ProvenanceStatus,
): string {
  return `exn.${contentHash({
    schema: EXECUTION_ENGINE_VERSION,
    gateId: input.gate.id,
    approvalId: input.approval.id,
    riskId: input.risk.id,
    policyId: input.policy.id,
    decisionId: input.decision?.id ?? null,
    orderIntentId: input.orderIntent?.id ?? null,
    agentRunId: input.agentRunId,
    bindingId,
    environment,
    provenance,
    direction: proposal.direction,
    entry: proposal.entry,
    stop: proposal.stop,
    takeProfit: proposal.takeProfit,
    quantity: proposal.quantity,
    requestedQuantity: input.requestedQuantity,
  }).slice(0, 40)}`;
}

function attemptRecord(
  input: ExecutionSubmitInput,
  ready: Ready,
  state: ExecutionState,
  brokerRequestId: string | null,
  fill: ExecutionFill | null,
): ExecutionAttemptRecord {
  return {
    schemaVersion: EXECUTION_ENGINE_VERSION,
    executionRequestId: ready.requestId,
    executionIdentity: ready.identity,
    agentRunId: input.agentRunId,
    decisionId: input.decision?.id ?? "",
    orderIntentId: input.orderIntent?.id ?? "",
    riskDecisionId: input.risk.id,
    policyDecisionId: input.policy.id,
    approvalDecisionId: input.approval.id,
    gateId: input.gate.id,
    bindingId: ready.binding.bindingId,
    environment: ready.environment,
    provenance: ready.provenance,
    direction: ready.direction,
    entry: ready.entry,
    stop: ready.stop,
    takeProfit: ready.takeProfit,
    quantity: ready.quantity,
    state,
    brokerRequestId,
    fill,
    submittedAt: input.submittedAt,
  };
}

function located(input: ExecutionSubmitInput): Ready | null {
  const environment = tradingEnvironmentSchema.safeParse(input.gate.environment ?? input.environment);
  const provenance = provenanceStatusSchema.safeParse(input.gate.provenance ?? input.provenance);
  if (!environment.success || !provenance.success) return null;
  return {
    environment: environment.data,
    provenance: provenance.data,
    binding: {
      schemaVersion: "xauusd-metaapi-account-1",
      bindingId: "unbound",
      environment: environment.data === "LIVE" ? "LIVE" : "PAPER",
      credentialSlot: environment.data === "LIVE" ? "live" : "paper",
      brokerSymbol: "XAUUSD",
      provider: "metaapi-cloud",
      region: "unbound",
    },
    direction: "LONG",
    entry: input.orderIntent?.entry ?? 0,
    stop: input.orderIntent?.stop ?? 0,
    takeProfit: null,
    quantity: input.risk.trace.acceptedQuantity ?? 0,
    identity: "",
    requestId: "",
    command: {
      instrument: "XAUUSD",
      symbol: "XAUUSD",
      direction: "LONG",
      actionType: "ORDER_TYPE_BUY_LIMIT",
      volume: 0,
      openPrice: 0,
      stopLoss: 0,
      takeProfit: null,
      clientId: "00000000000000000000000000",
      executionRequestId: "",
    },
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

function finish(
  input: ExecutionSubmitInput,
  ready: Ready | null,
  state: ExecutionState,
  reason: ExecutionReason,
  brokerCalled: boolean,
  brokerRequestId: string | null,
  brokerCode: string | null,
  fill: ExecutionFill | null,
  idOverride: string | null = null,
): ExecutionDecision {
  const environment = ready?.environment ?? null;
  const identity = ready !== null && ready.identity.length > 0 ? ready.identity : null;
  const requestId = idOverride
    ?? (ready !== null && ready.requestId.length > 0
      ? ready.requestId
      : `exr.${contentHash({
        schema: EXECUTION_ENGINE_VERSION,
        kind: "refused",
        state,
        reason,
        gateId: input.gate.id,
        agentRunId: input.agentRunId,
        submittedAt: input.submittedAt,
      }).slice(0, 40)}`);
  const id = requestId;
  const code = brokerCode !== null && /^[A-Z0-9_]+$/.test(brokerCode) && brokerCode.length <= 64 ? brokerCode : null;
  const events = environment === null ? [] : eventsFor(input, ready, id, state, reason, environment, code, fill);
  return {
    schemaVersion: EXECUTION_ENGINE_VERSION,
    id,
    executionIdentity: identity,
    state,
    reasons: [reason] as ExecutionDecision["reasons"],
    agentRunId: recordIdSchema.safeParse(input.agentRunId).success ? input.agentRunId : "run.unknown",
    decisionId: input.decision?.id ?? input.gate.decisionId,
    orderIntentId: input.orderIntent?.id ?? input.gate.orderIntentId,
    riskDecisionId: input.risk.id,
    policyDecisionId: input.policy.id,
    approvalDecisionId: input.approval.id,
    humanApprovalId: input.approval.humanApprovalId,
    gateId: input.gate.id,
    bindingId: ready !== null && ready.binding.bindingId !== "unbound" ? ready.binding.bindingId : null,
    environment,
    provenance: ready?.provenance ?? null,
    direction: ready !== null && ready.identity.length > 0 ? ready.direction : null,
    entry: ready !== null && ready.identity.length > 0 ? ready.entry : null,
    stop: ready !== null && ready.identity.length > 0 ? ready.stop : null,
    takeProfit: ready !== null && ready.identity.length > 0 ? ready.takeProfit : null,
    quantity: ready !== null && ready.identity.length > 0 ? ready.quantity : null,
    brokerRequestId,
    brokerCode: code,
    fill,
    submittedAt: utcTimestampSchema.safeParse(input.submittedAt).success ? input.submittedAt : null,
    brokerCalled,
    simulatorFallback: false,
    retried: false,
    events,
  };
}

function eventsFor(
  input: ExecutionSubmitInput,
  ready: Ready | null,
  id: string,
  state: ExecutionState,
  reason: ExecutionReason,
  environment: TradingEnvironment,
  brokerCode: string | null,
  fill: ExecutionFill | null,
): TradingEvent[] {
  const types: TradingEventType[] = [];
  if (state !== "NOT_SUBMITTED") types.push("execution.requested");
  types.push(outcomeEvent(state));
  const correlationId = input.evaluationRunId ?? input.decision?.id ?? input.agentRunId;
  return types.map((type) => fact(input, ready, id, type, state, reason, environment, correlationId, brokerCode, fill))
    .filter((event): event is TradingEvent => event !== null);
}

function outcomeEvent(state: ExecutionState): TradingEventType {
  switch (state) {
    case "NOT_SUBMITTED":
      return "execution.rejected";
    case "SUBMISSION_REJECTED":
      return "execution.failed";
    case "SUBMISSION_ACCEPTED":
      return "execution.accepted";
    case "SUBMISSION_UNKNOWN":
      return "execution.unknown";
    case "FILL_REPORTED":
      return "execution.filled";
  }
}

function fact(
  input: ExecutionSubmitInput,
  ready: Ready | null,
  id: string,
  type: TradingEventType,
  state: ExecutionState,
  reason: ExecutionReason,
  environment: TradingEnvironment,
  correlationId: string,
  brokerCode: string | null,
  fill: ExecutionFill | null,
): TradingEvent | null {
  const prefix = type === "execution.requested" ? "eq" : "eo";
  return tradingFact({
    type,
    eventId: `${prefix}.${id}.${type.split(".")[1] ?? "event"}`,
    at: input.submittedAt,
    agentRunId: input.agentRunId,
    correlationId,
    environment,
    actor: "xauusd-execution",
    nextState: state,
    runtimeThreadId: input.runtimeThreadId,
    runtimeTurnId: input.runtimeTurnId,
    payload: {
      state,
      reasons: [reason],
      executionRequestId: id,
      executionIdentity: ready?.identity || null,
      decisionId: input.decision?.id ?? null,
      orderIntentId: input.orderIntent?.id ?? null,
      riskDecisionId: input.risk.id,
      policyDecisionId: input.policy.id,
      approvalDecisionId: input.approval.id,
      humanApprovalId: input.approval.humanApprovalId,
      gateId: input.gate.id,
      bindingId: ready !== null && ready.binding.bindingId !== "unbound" ? ready.binding.bindingId : null,
      provenance: ready?.provenance ?? input.gate.provenance,
      brokerCode,
      fact: executionInfrastructureFact(state),
      fill,
      simulatorFallback: false,
      retried: false,
    },
  });
}

function closed(input: ExecutionSubmitInput, reason: "SYSTEM_ERROR" | "CREDENTIALS_FORBIDDEN"): ExecutionDecision {
  const agentRunId = typeof input.agentRunId === "string" && recordIdSchema.safeParse(input.agentRunId).success
    ? input.agentRunId
    : "run.unknown";
  const submittedAt = typeof input.submittedAt === "string" && utcTimestampSchema.safeParse(input.submittedAt).success
    ? input.submittedAt
    : null;
  return {
    schemaVersion: EXECUTION_ENGINE_VERSION,
    id: `exr.${contentHash({ kind: "execution-closed", reason, agentRunId, submittedAt }).slice(0, 40)}`,
    executionIdentity: null,
    state: "NOT_SUBMITTED",
    reasons: [reason] as ExecutionDecision["reasons"],
    agentRunId,
    decisionId: null,
    orderIntentId: null,
    riskDecisionId: null,
    policyDecisionId: null,
    approvalDecisionId: null,
    humanApprovalId: null,
    gateId: null,
    bindingId: null,
    environment: null,
    provenance: null,
    direction: null,
    entry: null,
    stop: null,
    takeProfit: null,
    quantity: null,
    brokerRequestId: null,
    brokerCode: null,
    fill: null,
    submittedAt,
    brokerCalled: false,
    simulatorFallback: false,
    retried: false,
    events: [],
  };
}

function seal(decision: ExecutionDecision): ExecutionDecision {
  return Object.freeze({
    ...decision,
    reasons: Object.freeze([...decision.reasons]) as ExecutionDecision["reasons"],
    fill: decision.fill === null ? null : Object.freeze({ ...decision.fill }),
    events: Object.freeze([...decision.events]),
  });
}
