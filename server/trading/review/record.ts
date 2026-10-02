import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { assertNoSecretFields, recordIdSchema, seal, utcTimestampSchema } from "../../../shared/trading/ids.ts";
import { tradingFact } from "../audit.ts";
import type { ExecutionState } from "../execution/result.ts";
import { derivePositionLifecycle, selectBrokerPosition } from "../lifecycle/position.ts";
import type { TradingStore } from "../persistence/store.ts";
import { canonicalJson, contentHash } from "../replay/hash.ts";

/** Post-trade review. Version `xauusd-review-1`.
 * Facts are copied from stored records. Interpretations are copied from
 * trading-memory rows of kind INTERPRETATION. Learnings are copied from
 * stored learning revisions the caller cites. This module does not write
 * risk, policy, approval, the kill switch, or a broker order. */
export const TRADING_REVIEW_VERSION = "xauusd-review-1" as const;

export interface ReviewText {
  readonly recordId: string;
  readonly recordedAt: string;
  readonly body: string;
}

export interface ReviewLearning {
  readonly revisionId: string;
  readonly target: string;
  readonly recordedAt: string;
}

export interface TradingReview {
  readonly schemaVersion: typeof TRADING_REVIEW_VERSION;
  readonly reviewId: string;
  readonly occurrenceId: string;
  readonly agentRunId: string;
  readonly environment: TradingEnvironment;
  readonly revision: number;
  readonly supersedes: string | null;
  readonly recordedAt: string;
  readonly facts: {
    readonly decision: {
      readonly id: string;
      readonly direction: string;
      readonly status: string;
      readonly thesis: string;
      readonly snapshotId: string;
      readonly contextId: string;
      readonly evidenceIds: readonly string[];
      readonly invalidation: string | null;
      readonly stop: number | null;
      readonly targets: readonly number[];
      readonly createdAt: string;
      readonly expiry: string;
    };
    readonly risk: { readonly id: string; readonly state: string; readonly reasons: readonly string[] } | null;
    readonly policy: { readonly id: string; readonly state: string; readonly progression: string; readonly reasons: readonly string[] } | null;
    readonly gate: { readonly id: string; readonly state: string; readonly reasons: readonly string[] } | null;
    readonly approval: { readonly id: string; readonly state: string | null; readonly approved: boolean | null } | null;
    readonly execution: { readonly id: string; readonly state: string; readonly acceptedQuantity: number | null } | null;
    readonly reconciliation: { readonly id: string; readonly state: string; readonly findingCodes: readonly string[] } | null;
    readonly exit: { readonly id: string; readonly state: string; readonly closePositionId: string | null; readonly quantity: number | null } | null;
    readonly position: { readonly state: string; readonly brokerPositionId: string | null; readonly quantity: number | null } | null;
    readonly marketProvenance: string | null;
    readonly validatedFacts: readonly ReviewText[];
    readonly userFeedback: readonly ReviewText[];
    readonly deviations: readonly string[];
  };
  readonly interpretations: readonly ReviewText[];
  readonly learnings: readonly ReviewLearning[];
}

export type ReviewRecordResult =
  | { readonly recorded: true; readonly inserted: boolean; readonly review: TradingReview }
  | { readonly recorded: false; readonly reason: "DECISION_UNAVAILABLE" };

/** Copies the occurrence's stored chain into one immutable review.
 * A missing decision stays unreviewed. A cited record that cannot be read
 * fails closed and does not invent the missing fact. */
export function recordPostTradeReview(
  store: TradingStore,
  input: {
    readonly occurrenceId: string;
    readonly recordedAt: string;
    readonly learningRevisionIds?: readonly string[];
  },
): ReviewRecordResult {
  if (!recordIdSchema.safeParse(input.occurrenceId).success || !utcTimestampSchema.safeParse(input.recordedAt).success) {
    throw new TradingDomainError("trading_store_rejected", "Trading review identity was rejected. Failing closed.");
  }
  const occurrence = store.occurrences.readByOccurrenceId(input.occurrenceId);
  if (occurrence === null || occurrence.environment !== store.environment) {
    throw new TradingDomainError("trading_store_rejected", "Trading review matched no occurrence. Failing closed.");
  }
  if (occurrence.decisionId === null) return { recorded: false, reason: "DECISION_UNAVAILABLE" };
  const decision = store.artifacts.readDecision(occurrence.decisionId);
  if (decision === "missing" || decision === "malformed" || decision.id !== occurrence.decisionId || decision.agentRunId !== occurrence.agentRunId) {
    throw new TradingDomainError("trading_store_rejected", "Trading review decision was unreadable. Failing closed.");
  }
  const risk = occurrence.riskDecisionId === null ? null : citedSummary(occurrence.riskDecisionId, store.artifacts.readRisk(occurrence.riskDecisionId), "Risk");
  const policy = occurrence.policyDecisionId === null ? null : citedPolicy(store.artifacts.readPolicy(occurrence.policyDecisionId));
  const gate = occurrence.gateDecisionId === null ? null : citedSummary(occurrence.gateDecisionId, store.artifacts.readGate(occurrence.gateDecisionId), "Gate");
  const approval = approvalFacts(store, occurrence.occurrenceId, occurrence.approvalId);
  const execution = executionFacts(store, occurrence.executionRequestId, occurrence.executionState);
  const reconciliation = reconciliationFacts(store, execution?.identity ?? null, occurrence.reconciliationRunId, occurrence.reconciliationState);
  const exit = occurrence.exitExecutionRequestId === null || occurrence.exitExecutionState === null
    ? null
    : {
      id: occurrence.exitExecutionRequestId,
      state: occurrence.exitExecutionState,
      closePositionId: occurrence.exitClosePositionId,
      quantity: occurrence.exitQuantity,
    };
  const position = positionFacts(store, occurrence.snapshotId, {
    executionState: occurrence.executionState,
    reconciliationState: occurrence.reconciliationState,
    authorizedQuantity: execution?.acceptedQuantity ?? null,
    exitState: occurrence.exitExecutionState,
  });
  const memory = store.memory.read(occurrence.occurrenceId);
  const validatedFacts = memory.filter((row) => row.kind === "FACT").map(textOf);
  const interpretations = memory.filter((row) => row.kind === "INTERPRETATION").map(textOf);
  const userFeedback = memory.filter((row) => row.kind === "USER_FEEDBACK").map(textOf);
  const learnings = citedLearnings(store, input.learningRevisionIds ?? []);
  const deviations = uniqueCodes([
    occurrence.failureCode,
    occurrence.exitFailureCode,
    ...(risk !== null && risk.state !== "ACCEPT" ? risk.reasons : []),
    ...(policy !== null && policy.state !== "ALLOW" ? policy.reasons : []),
    ...(gate !== null && gate.state !== "ELIGIBLE_FOR_EXECUTION" ? gate.reasons : []),
    ...(reconciliation?.findingCodes ?? []),
  ]);
  const facts = {
    decision: {
      id: decision.id,
      direction: decision.direction,
      status: decision.status,
      thesis: decision.thesis,
      snapshotId: decision.snapshotId,
      contextId: decision.contextId,
      evidenceIds: decision.evidenceIds,
      invalidation: decision.invalidation ?? null,
      stop: decision.stop ?? null,
      targets: decision.targets,
      createdAt: decision.createdAt,
      expiry: decision.expiry,
    },
    risk,
    policy,
    gate,
    approval,
    execution: execution === null ? null : { id: execution.id, state: execution.state, acceptedQuantity: execution.acceptedQuantity },
    reconciliation: reconciliation === null ? null : { id: reconciliation.id, state: reconciliation.state, findingCodes: reconciliation.findingCodes },
    exit,
    position,
    marketProvenance: occurrence.provenance,
    validatedFacts,
    userFeedback,
    deviations,
  };
  const comparable = {
    occurrenceId: occurrence.occurrenceId,
    agentRunId: occurrence.agentRunId,
    environment: occurrence.environment,
    recordedAt: input.recordedAt,
    facts,
    interpretations,
    learnings,
  };
  assertNoSecretFields(comparable, "trading review");
  const previous = store.reviews.readLatest(occurrence.occurrenceId);
  if (previous === "malformed") {
    throw new TradingDomainError("trading_store_rejected", "Trading review history was unreadable. Failing closed.");
  }
  if (previous !== "missing" && sameBody(previous, comparable)) {
    return { recorded: true, inserted: false, review: previous };
  }
  const revision = previous === "missing" ? 1 : previous.revision + 1;
  const supersedes = previous === "missing" ? null : previous.reviewId;
  const review = seal({
    schemaVersion: TRADING_REVIEW_VERSION,
    reviewId: `review.${contentHash({ schema: TRADING_REVIEW_VERSION, occurrenceId: occurrence.occurrenceId, revision, body: comparable }).slice(0, 40)}`,
    occurrenceId: occurrence.occurrenceId,
    agentRunId: occurrence.agentRunId,
    environment: occurrence.environment,
    revision,
    supersedes,
    recordedAt: input.recordedAt,
    facts,
    interpretations,
    learnings,
  });
  const written = store.reviews.append(review);
  const event = tradingFact({
    type: "review.created",
    eventId: `evt.${review.reviewId}`,
    at: input.recordedAt,
    agentRunId: occurrence.agentRunId,
    correlationId: occurrence.occurrenceId,
    environment: occurrence.environment,
    actor: "xauusd-review",
    payload: { reviewId: review.reviewId, occurrenceId: occurrence.occurrenceId, revision },
  });
  if (event === null) {
    throw new TradingDomainError("trading_store_rejected", "Trading review event was rejected. Failing closed.");
  }
  store.appendEvents([event]);
  return { recorded: true, inserted: written.inserted, review };
}

function textOf(row: { readonly recordId: string; readonly recordedAt: string; readonly body: string }): ReviewText {
  return { recordId: row.recordId, recordedAt: row.recordedAt, body: row.body };
}

function citedSummary(
  id: string | null,
  read: { id: string; state: string; reasons: readonly string[] } | "missing" | "malformed" | null,
  label: string,
): { id: string; state: string; reasons: readonly string[] } | null {
  if (id === null) return null;
  if (read === null || read === "missing" || read === "malformed" || read.id !== id) {
    throw new TradingDomainError("trading_store_rejected", `${label} citation was unreadable. Failing closed.`);
  }
  return { id: read.id, state: read.state, reasons: [...read.reasons] };
}

function citedPolicy(
  read: { id: string; state: string; progression: string; reasons: readonly string[] } | "missing" | "malformed",
): { id: string; state: string; progression: string; reasons: readonly string[] } {
  if (read === "missing" || read === "malformed") {
    throw new TradingDomainError("trading_store_rejected", "Policy citation was unreadable. Failing closed.");
  }
  return { id: read.id, state: read.state, progression: read.progression, reasons: [...read.reasons] };
}

function approvalFacts(store: TradingStore, occurrenceId: string, approvalId: string | null): TradingReview["facts"]["approval"] {
  const rows = store.approvals.readForOccurrence(occurrenceId);
  if (rows.ambiguous) {
    throw new TradingDomainError("trading_store_rejected", "Approval citation was ambiguous. Failing closed.");
  }
  const settled = rows.settled;
  if (settled === null && rows.open === null) {
    if (approvalId !== null) {
      throw new TradingDomainError("trading_store_rejected", "Approval citation did not match the occurrence. Failing closed.");
    }
    return null;
  }
  let approved: boolean | null = null;
  let factApprovalId: string | null = null;
  if (settled?.factJson) {
    let fact: { approved?: unknown; approvalId?: unknown };
    try {
      fact = JSON.parse(settled.factJson) as { approved?: unknown; approvalId?: unknown };
    } catch {
      throw new TradingDomainError("trading_store_rejected", "Approval fact was unreadable. Failing closed.");
    }
    if (typeof fact.approved !== "boolean") {
      throw new TradingDomainError("trading_store_rejected", "Approval fact was unreadable. Failing closed.");
    }
    approved = fact.approved;
    factApprovalId = typeof fact.approvalId === "string" ? fact.approvalId : null;
  }
  const matches = approvalId === null
    || settled?.approvalDecisionId === approvalId
    || rows.open?.requestId === approvalId
    || factApprovalId === approvalId;
  if (!matches) {
    throw new TradingDomainError("trading_store_rejected", "Approval citation did not match the occurrence. Failing closed.");
  }
  const id = factApprovalId ?? settled?.approvalDecisionId ?? rows.open?.requestId ?? approvalId;
  if (id === null) return null;
  return { id, state: settled?.assessmentState ?? null, approved };
}

function executionFacts(
  store: TradingStore,
  executionRequestId: string | null,
  executionState: ExecutionState | null,
): { id: string; state: ExecutionState; acceptedQuantity: number | null; identity: string } | null {
  if (executionRequestId === null || executionState === null) return null;
  const request = store.readRequestById(executionRequestId);
  if (request === null || request.executionRequestId !== executionRequestId) {
    throw new TradingDomainError("trading_store_rejected", "Execution citation was unreadable. Failing closed.");
  }
  return {
    id: request.executionRequestId,
    state: executionState,
    acceptedQuantity: request.acceptedQuantity,
    identity: request.executionIdentity,
  };
}

function reconciliationFacts(
  store: TradingStore,
  identity: string | null,
  reconciliationRunId: string | null,
  reconciliationState: string | null,
): { id: string; state: string; findingCodes: readonly string[] } | null {
  if (reconciliationRunId === null || reconciliationState === null) return null;
  if (identity === null) {
    throw new TradingDomainError("trading_store_rejected", "Reconciliation citation was unreadable. Failing closed.");
  }
  const run = store.readReconciliations(identity).find((item) => item.reconciliationRunId === reconciliationRunId);
  if (run === undefined || run.state !== reconciliationState) {
    throw new TradingDomainError("trading_store_rejected", "Reconciliation citation was unreadable. Failing closed.");
  }
  return { id: run.reconciliationRunId, state: run.state, findingCodes: run.findings.map((item) => item.code) };
}

function positionFacts(
  store: TradingStore,
  snapshotId: string | null,
  input: {
    readonly executionState: Parameters<typeof derivePositionLifecycle>[0]["executionState"];
    readonly reconciliationState: Parameters<typeof derivePositionLifecycle>[0]["reconciliationState"];
    readonly authorizedQuantity: number | null;
    readonly exitState: Parameters<typeof derivePositionLifecycle>[0]["exitState"];
  },
): TradingReview["facts"]["position"] {
  if (snapshotId === null) return null;
  const snapshot = store.readSnapshot(snapshotId);
  if (snapshot === null) {
    throw new TradingDomainError("trading_store_rejected", "Position snapshot was unreadable. Failing closed.");
  }
  if (snapshot.unavailable || snapshot.brokerCallSkipped || snapshot.channels.positions !== "read") {
    return { state: "POSITION_UNKNOWN", brokerPositionId: null, quantity: null };
  }
  const selected = selectBrokerPosition(snapshot.positions.map((position) => ({
    positionId: position.positionId,
    symbol: position.symbol,
    direction: position.direction,
    volume: position.volume,
  })));
  return {
    state: derivePositionLifecycle({
      executionState: input.executionState,
      reconciliationState: input.reconciliationState,
      brokerPositionId: selected.ambiguous ? null : selected.positionId,
      brokerQuantity: selected.ambiguous ? null : selected.quantity,
      authorizedQuantity: input.authorizedQuantity,
      exitState: input.exitState,
      ambiguous: selected.ambiguous,
    }),
    brokerPositionId: selected.ambiguous ? null : selected.positionId,
    quantity: selected.ambiguous ? null : selected.quantity,
  };
}

function citedLearnings(store: TradingStore, revisionIds: readonly string[]): readonly ReviewLearning[] {
  const listed = store.memory.listLearning();
  return revisionIds.map((revisionId) => {
    const found = listed.find((row) => row.revisionId === revisionId);
    if (found === undefined) {
      throw new TradingDomainError("trading_store_rejected", "Learning citation was unreadable. Failing closed.");
    }
    return { revisionId: found.revisionId, target: found.target, recordedAt: found.recordedAt };
  });
}

function uniqueCodes(values: readonly (string | null | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))].sort();
}

function sameBody(previous: TradingReview, next: {
  readonly occurrenceId: string;
  readonly agentRunId: string;
  readonly environment: TradingEnvironment;
  readonly recordedAt: string;
  readonly facts: TradingReview["facts"];
  readonly interpretations: readonly ReviewText[];
  readonly learnings: readonly ReviewLearning[];
}): boolean {
  return previous.occurrenceId === next.occurrenceId
    && previous.agentRunId === next.agentRunId
    && previous.environment === next.environment
    && previous.recordedAt === next.recordedAt
    && canonicalJson({ facts: previous.facts, interpretations: previous.interpretations, learnings: previous.learnings })
      === canonicalJson({ facts: next.facts, interpretations: next.interpretations, learnings: next.learnings });
}
