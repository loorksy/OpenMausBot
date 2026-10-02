import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { assertNoSecretFields, recordIdSchema, utcTimestampSchema } from "../../../shared/trading/ids.ts";
import { readXauUsdJobMount } from "../jobs/mount.ts";
import { openTradingStore, type TradingStore } from "../persistence/store.ts";
import { contentHash } from "../replay/hash.ts";
import { assessApproval, bindingFromProposal, type ApprovalAssessmentInput, type ApprovalFact } from "./assess.ts";
import { proposalBinding } from "./binding.ts";
import type { ApprovalDecision } from "./result.ts";

/** Native request.opened / request.resolved are transport. Only assessApproval
 * turns a validated response into a trading approval result. */
export interface OpenTradingApprovalInput {
  readonly requestId: string;
  readonly occurrenceId: string;
  readonly requesterId: string;
  readonly openedAt: string;
  readonly assessment: Omit<ApprovalAssessmentInput, "approval" | "evaluatedAt" | "simulateInternalFailure">;
}

export interface NativeApprovalResolution {
  readonly requestId: string;
  readonly behavior: "allow" | "deny" | "answer";
  readonly message?: string;
  readonly source: "user" | "auto" | "timeout" | "system" | "unavailable" | "peer";
  readonly responderId: string;
  readonly resolvedAt: string;
}

export type NativeApprovalSettlement =
  | { readonly kind: "ordinary" }
  | {
      readonly kind: "trading";
      readonly idempotent: boolean;
      readonly decision: ApprovalDecision;
      readonly fact: ApprovalFact | null;
    };

const ANSWERS = new Set(["approve", "reject"]);

export function openTradingApproval(store: TradingStore, input: OpenTradingApprovalInput): { readonly requestId: string; readonly expiresAt: string; readonly proposalBinding: string } {
  assertNoSecretFields(input, "trading approval");
  const assessment = input.assessment;
  if (assessment.approvalRequestId !== input.requestId) {
    throw new TradingDomainError("trading_store_rejected", "Trading approval request identity was rejected. Failing closed.");
  }
  const row = store.occurrences.readByOccurrenceId(input.occurrenceId);
  if (!row || row.agentRunId !== assessment.agentRunId || row.environment !== store.environment) {
    throw new TradingDomainError("agent_run_mismatch", "Trading approval occurrence was rejected. Failing closed.");
  }
  const config = assessment.config as { version?: unknown; maxAgeMs?: unknown };
  if (typeof config?.version !== "string" || typeof config.maxAgeMs !== "number") {
    throw new TradingDomainError("trading_store_rejected", "Trading approval configuration was rejected. Failing closed.");
  }
  if (!utcTimestampSchema.safeParse(input.openedAt).success) {
    throw new TradingDomainError("trading_store_rejected", "Trading approval timestamp was rejected. Failing closed.");
  }
  const openedMs = Date.parse(input.openedAt);
  if (!Number.isFinite(openedMs)) {
    throw new TradingDomainError("trading_store_rejected", "Trading approval timestamp was rejected. Failing closed.");
  }
  const expiresAt = new Date(openedMs + config.maxAgeMs).toISOString();
  const facts = bindingFromProposal(
    { ...assessment, approval: null, evaluatedAt: input.openedAt },
    assessment.risk.configId ?? "",
    assessment.policy.configId ?? "",
  );
  if (
    facts === null
    || assessment.risk.configId === null
    || assessment.policy.configId === null
    || facts.decisionId !== assessment.decision?.id
    || facts.orderIntentId !== assessment.orderIntent?.id
    || facts.riskDecisionId !== assessment.risk.id
    || facts.policyDecisionId !== assessment.policy.id
  ) {
    throw new TradingDomainError("trading_store_rejected", "Trading approval proposal was rejected. Failing closed.");
  }
  const binding = proposalBinding(facts);
  store.approvals.insertOpen({
    requestId: input.requestId,
    occurrenceId: input.occurrenceId,
    agentRunId: assessment.agentRunId,
    decisionId: facts.decisionId,
    orderIntentId: facts.orderIntentId,
    riskDecisionId: facts.riskDecisionId,
    policyDecisionId: facts.policyDecisionId,
    proposalBinding: binding,
    environment: store.environment,
    requesterId: input.requesterId,
    openedAt: input.openedAt,
    expiresAt,
    maxAgeMs: config.maxAgeMs,
    assessmentJson: JSON.stringify(assessment),
  });
  return { requestId: input.requestId, expiresAt, proposalBinding: binding };
}

export function settleNativeTradingApproval(store: TradingStore, resolution: NativeApprovalResolution): NativeApprovalSettlement {
  assertNoSecretFields(resolution, "trading approval");
  const transport = store.approvals.read(resolution.requestId);
  if (!transport) return { kind: "ordinary" };
  const fingerprint = resolutionFingerprint(resolution);
  if (transport.resolvedFingerprint === fingerprint && transport.decisionJson) {
    return storedSettlement(transport.decisionJson, transport.factJson, true);
  }
  if (transport.resolvedFingerprint !== null) {
    throw new TradingDomainError("immutable_revision", "Trading approval was already resolved. Failing closed.");
  }
  const assessment = JSON.parse(transport.assessmentJson) as OpenTradingApprovalInput["assessment"];
  const fact = transportFact(transport, resolution, assessment);
  const decision = assessApproval({
    ...assessment,
    approval: fact ?? { approved: "malformed" },
    evaluatedAt: resolution.resolvedAt,
  });
  if (decision.state === "APPROVED" && fact?.approved !== true) {
    throw new TradingDomainError("trading_store_rejected", "Trading approval was not produced by an approval fact. Failing closed.");
  }
  const committed = store.approvals.commitResolution({
    requestId: resolution.requestId,
    fingerprint,
    decision,
    fact,
    proposalBinding: transport.proposalBinding,
  });
  if (!committed.decisionJson) {
    throw new TradingDomainError("trading_store_rejected", "Trading approval resolution was rejected. Failing closed.");
  }
  return storedSettlement(committed.decisionJson, committed.factJson, false);
}

export function settleNativeTradingApprovalFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  resolution: NativeApprovalResolution,
): NativeApprovalSettlement {
  const mount = readXauUsdJobMount(env);
  if (!mount.mounted) return { kind: "ordinary" };
  const store = openTradingStore({ path: mount.path, environment: mount.environment });
  try {
    return settleNativeTradingApproval(store, resolution);
  } finally {
    store.close();
  }
}

/** The person allowed to approve. A service worker and an unknown session
 * are not that person. */
export function tradingResponderId(auth: {
  readonly kind: string;
  readonly trust?: string;
  readonly session?: { readonly id?: string };
}): string {
  if (auth.kind === "loopback" && auth.trust !== "service") return "owner";
  if (auth.kind === "session" && typeof auth.session?.id === "string" && recordIdSchema.safeParse(auth.session.id).success) {
    return auth.session.id;
  }
  return "unauthorized";
}

function transportFact(
  transport: {
    readonly requestId: string;
    readonly requesterId: string;
    readonly openedAt: string;
    readonly expiresAt: string;
    readonly proposalBinding: string;
    readonly environment: TradingEnvironment;
    readonly decisionId: string;
    readonly orderIntentId: string;
    readonly riskDecisionId: string;
    readonly policyDecisionId: string;
    readonly approvalPolicyVersion: string;
    readonly agentRunId: string;
  },
  resolution: NativeApprovalResolution,
  assessment: OpenTradingApprovalInput["assessment"],
): ApprovalFact | null {
  const answer = resolution.message;
  const fresh = resolution.resolvedAt >= transport.openedAt && resolution.resolvedAt <= transport.expiresAt;
  const explicit = resolution.behavior === "answer" && resolution.source === "user" && typeof answer === "string" && ANSWERS.has(answer);
  if (!explicit || !fresh || resolution.responderId !== transport.requesterId) return null;
  if (assessment.agentRunId !== transport.agentRunId) return null;
  const approvalId = `apr.${contentHash({
    schema: "xauusd-native-approval-1",
    requestId: transport.requestId,
    proposalBinding: transport.proposalBinding,
    answer,
    responderId: resolution.responderId,
  }).slice(0, 40)}`;
  return {
    approvalId,
    approvalRequestId: transport.requestId,
    approved: answer === "approve",
    approvedBy: resolution.responderId,
    approvedAt: resolution.resolvedAt,
    decisionId: transport.decisionId,
    orderIntentId: transport.orderIntentId,
    riskDecisionId: transport.riskDecisionId,
    policyDecisionId: transport.policyDecisionId,
    environment: transport.environment,
    instrument: "XAUUSD",
    approvalPolicyVersion: transport.approvalPolicyVersion,
    proposalBinding: transport.proposalBinding,
  };
}

function resolutionFingerprint(resolution: NativeApprovalResolution): string {
  return `res.${contentHash({
    schema: "xauusd-native-approval-resolution-1",
    requestId: resolution.requestId,
    behavior: resolution.behavior,
    message: resolution.message ?? null,
    source: resolution.source,
    responderId: resolution.responderId,
    resolvedAt: resolution.resolvedAt,
  }).slice(0, 40)}`;
}

function storedSettlement(decisionJson: string, factJson: string | null, idempotent: boolean): NativeApprovalSettlement {
  return {
    kind: "trading",
    idempotent,
    decision: JSON.parse(decisionJson) as ApprovalDecision,
    fact: factJson === null ? null : JSON.parse(factJson) as ApprovalFact,
  };
}

