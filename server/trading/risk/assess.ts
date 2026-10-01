import { DECISION_DIRECTIONS, type Decision } from "../../../shared/trading/decision.ts";
import { tradingEnvironmentSchema, provenanceStatusSchema, type TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { assertNoSecretFields, recordIdSchema, utcTimestampSchema } from "../../../shared/trading/ids.ts";
import { XAUUSD_INSTRUMENT } from "../../../shared/trading/instrument.ts";
import type { OrderIntent } from "../../../shared/trading/order-intent.ts";
import { parseRiskCheck, type CheckStatus } from "../../../shared/trading/risk.ts";
import type { TradingEvent, TradingEventType } from "../../../shared/trading/events.ts";
import { contentHash } from "../replay/hash.ts";
import { tradingFact } from "../audit.ts";
import { readAccountRiskState, readMarketRiskFacts, type AccountRiskState, type MarketRiskFacts } from "./account.ts";
import { XAUUSD_CONTRACT_VERSION, XAUUSD_OUNCES_PER_LOT } from "./contract.ts";
import { parseRiskConfig, RISK_ENGINE_VERSION, type RiskConfig } from "./config.ts";
import { floorToStep, mul, onStep, scale, unscale } from "./math.ts";
import { riskInfrastructureFact, type RiskDecision, type RiskReason, type RiskState, type RiskTrace } from "./result.ts";

export interface RiskAssessmentInput {
  readonly instrument: unknown;
  readonly decision: Decision | null;
  readonly orderIntent: OrderIntent | null;
  readonly market: unknown;
  readonly account: unknown;
  readonly config: unknown;
  readonly environment: unknown;
  readonly provenance: unknown;
  readonly assessedAt: string;
  readonly agentRunId: string;
  readonly evaluationRunId?: string | null;
  readonly runtimeThreadId?: string | null;
  readonly runtimeTurnId?: string | null;
  readonly requestedQuantity?: number | null;
  /** When set, the calculation is discarded and the result is INVALID.
   * It cannot produce ACCEPT. */
  readonly simulateInternalFailure?: boolean;
}

const ORDER_DIRECTIONS = ["LONG", "SHORT", "MANAGE_EXISTING_POSITION", "EXIT_EXISTING_POSITION"] as const;

type Draft = { -readonly [K in keyof RiskTrace]: RiskTrace[K] };

type Sized = {
  readonly state: RiskState;
  readonly reason: RiskReason;
  readonly trace: Draft;
};

export function assessXauUsdRisk(input: RiskAssessmentInput): RiskDecision {
  try {
    if (input.simulateInternalFailure === true) {
      throw new Error("simulated risk failure");
    }
    assertNoSecretFields(input, "risk input");
    return sealDecision(calculate(input));
  } catch (error) {
    if (error instanceof TradingDomainError && error.code === "credentials_forbidden") {
      return sealDecision(closedFailure(input, "CREDENTIALS_FORBIDDEN"));
    }
    return sealDecision(closedFailure(input, "SYSTEM_ERROR"));
  }
}

function sealDecision(decision: RiskDecision): RiskDecision {
  return Object.freeze({
    ...decision,
    reasons: Object.freeze([...decision.reasons]) as RiskDecision["reasons"],
    trace: Object.freeze({ ...decision.trace }),
    events: Object.freeze([...decision.events]),
  });
}

function closedFailure(input: RiskAssessmentInput, reason: "SYSTEM_ERROR" | "CREDENTIALS_FORBIDDEN"): RiskDecision {
  const agentRunId = typeof input.agentRunId === "string" && recordIdSchema.safeParse(input.agentRunId).success
    ? input.agentRunId
    : "run.unknown";
  const assessedAt = typeof input.assessedAt === "string" ? input.assessedAt : "";
  return {
    schemaVersion: RISK_ENGINE_VERSION,
    id: `risk.${contentHash({ kind: "risk-closed", reason, agentRunId, assessedAt }).slice(0, 40)}`,
    state: "INVALID",
    reasons: [reason],
    check: null,
    trace: blankTrace(null),
    agentRunId,
    evaluationRunId: null,
    configId: null,
    decisionId: null,
    orderIntentId: null,
    snapshotId: null,
    liveExecutionEnabled: false,
    events: [],
  };
}

function calculate(input: RiskAssessmentInput): RiskDecision {
  const agentRunId = input.agentRunId;
  const base = {
    input,
    agentRunId,
    configId: null as string | null,
    environment: "SIMULATOR" as TradingEnvironment,
    decisionId: null as string | null,
    orderIntentId: null as string | null,
    snapshotId: null as string | null,
    versionManifestId: null as string | null,
  };
  if (!recordIdSchema.safeParse(agentRunId).success || !utcTimestampSchema.safeParse(input.assessedAt).success) {
    return fail(base, "INVALID", "INVALID_INPUT", blankTrace(null));
  }
  if (input.evaluationRunId != null && !recordIdSchema.safeParse(input.evaluationRunId).success) {
    return fail(base, "INVALID", "INVALID_INPUT", blankTrace(null));
  }
  if (input.instrument !== XAUUSD_INSTRUMENT) {
    return fail(base, "INVALID", "INVALID_INSTRUMENT", blankTrace(null));
  }
  const environment = tradingEnvironmentSchema.safeParse(input.environment);
  if (!environment.success) return fail(base, "INVALID", "INVALID_INPUT", blankTrace(null));
  const provenance = provenanceStatusSchema.safeParse(input.provenance);
  if (!provenance.success) return fail(base, "INVALID", "INVALID_INPUT", blankTrace(null));
  const configRead = parseRiskConfig(input.config);
  if (!configRead.ok) return fail({ ...base, environment: environment.data }, "INVALID", "RISK_CONFIG_INVALID", blankTrace(null));
  const config = configRead.config;
  const trace = blankTrace(config.version);
  trace.quantityStep = config.quantityStep;
  const located = { ...base, environment: environment.data, configId: configRead.configId };
  const decision = input.decision;
  if (decision === null || typeof decision !== "object") {
    return fail(located, "INVALID", "INVALID_INPUT", trace);
  }
  if (decision.instrument !== XAUUSD_INSTRUMENT) return fail(located, "INVALID", "INVALID_INSTRUMENT", trace);
  if (decision.agentRunId !== agentRunId) return fail(located, "INVALID", "INVALID_INPUT", trace);
  if (decision.environment !== environment.data) {
    return fail({ ...located, decisionId: decision.id, versionManifestId: decision.versionManifestId }, "INVALID", "ENVIRONMENT_MISMATCH", trace);
  }
  if (!(DECISION_DIRECTIONS as readonly string[]).includes(decision.direction)) {
    return fail(located, "INVALID", "INVALID_DIRECTION", trace);
  }
  const withDecision = {
    ...located,
    decisionId: decision.id,
    versionManifestId: decision.versionManifestId,
  };
  const marketRead = readMarketRiskFacts(input.market, config.rejectStaleMarket);
  if (!marketRead.ok) {
    return fail(
      { ...withDecision, snapshotId: marketRead.snapshotId },
      marketRead.reason === "INVALID_INPUT" ? "INVALID" : "BLOCKED",
      marketRead.reason,
      trace,
    );
  }
  const market = marketRead.market;
  trace.marketProvenance = market.provenance;
  trace.marketFreshness = market.freshness;
  if (market.provenance !== provenance.data) {
    return fail({ ...withDecision, snapshotId: market.snapshotId }, "INVALID", "INVALID_INPUT", trace);
  }
  if (market.snapshotId !== decision.snapshotId) {
    return fail({ ...withDecision, snapshotId: market.snapshotId }, "INVALID", "INVALID_INPUT", trace);
  }
  const spread = spreadCheck(config, market);
  if (spread !== null) {
    return fail({ ...withDecision, snapshotId: market.snapshotId }, spread.state, spread.reason, trace);
  }
  const accountRead = readAccountRiskState(input.account);
  if (!accountRead.ok) {
    const state = accountRead.reason === "INVALID_EQUITY" || accountRead.reason === "INVALID_INPUT" ? "INVALID" : "BLOCKED";
    return fail({ ...withDecision, snapshotId: market.snapshotId }, state, accountRead.reason, trace);
  }
  const account = accountRead.account;
  trace.equity = account.equity;
  trace.maxRiskPercent = config.maxRiskPercent;
  trace.accountProvenance = account.provenance;
  trace.openExposureLots = account.exposureSide === "unknown" ? null : account.exposureLots;
  const withFacts = { ...withDecision, snapshotId: market.snapshotId };
  if (decision.direction === "NO_TRADE" || decision.direction === "WAIT") {
    if (input.orderIntent !== null) return fail(withFacts, "INVALID", "INTENT_NOT_ALLOWED", trace);
    trace.resultingRiskAmount = 0;
    trace.resultingRiskPercent = 0;
    return fail(withFacts, "ACCEPT", "RISK_WITHIN_LIMITS", trace);
  }
  if (!(ORDER_DIRECTIONS as readonly string[]).includes(decision.direction)) {
    return fail(withFacts, "INVALID", "INVALID_DIRECTION", trace);
  }
  const intent = input.orderIntent;
  if (intent === null) return fail(withFacts, "INVALID", "MISSING_ORDER_INTENT", trace);
  const withIntent = { ...withFacts, orderIntentId: intent.id };
  if (intent.instrument !== XAUUSD_INSTRUMENT) return fail(withIntent, "INVALID", "INVALID_INSTRUMENT", trace);
  if (intent.agentRunId !== agentRunId || intent.decisionId !== decision.id || intent.environment !== environment.data) {
    return fail(withIntent, "INVALID", "INVALID_INPUT", trace);
  }
  if (intent.direction !== decision.direction) return fail(withIntent, "INVALID", "DIRECTION_MISMATCH", trace);
  if (intent.executable !== false || intent.brokerSubmit !== false) {
    return fail(withIntent, "INVALID", "INTENT_FLAGS_INVALID", trace);
  }
  const sized = sizeProposal(config, account, decision, intent, input.requestedQuantity ?? null, trace);
  return fail(withIntent, sized.state, sized.reason, sized.trace);
}

function spreadCheck(config: RiskConfig, market: MarketRiskFacts): { state: RiskState; reason: RiskReason } | null {
  if (config.maxSpread === null) return null;
  const spread = market.spread ?? (market.bid !== null && market.ask !== null ? unscale(scale(market.ask) - scale(market.bid)) : null);
  if (spread === null) return { state: "BLOCKED", reason: "MARKET_DATA_UNAVAILABLE" };
  if (scale(spread) > scale(config.maxSpread)) return { state: "REJECT", reason: "SPREAD_LIMIT_EXCEEDED" };
  return null;
}

function sizeProposal(
  config: RiskConfig,
  account: AccountRiskState,
  decision: Decision,
  intent: OrderIntent,
  requested: number | null,
  trace: Draft,
): Sized {
  const next: Draft = { ...trace, requestedQuantity: requested };
  if (requested !== null && (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0)) {
    return { state: "INVALID", reason: "QUANTITY_INVALID", trace: next };
  }
  const prices = readPrices(decision, intent, next);
  if (prices.done) return prices.done;
  const { entry, stop, distance, perLot } = prices;
  next.entry = entry;
  next.stop = stop;
  next.stopDistance = distance;
  next.riskPerLot = perLot;
  const side = stopSide(decision.direction, account);
  if (side.done) return { ...side.done, trace: next };
  if (side.exposure === "long" && scale(stop) >= scale(entry)) {
    return { state: "REJECT", reason: scale(stop) === scale(entry) ? "ZERO_RISK_DISTANCE" : "STOP_WRONG_SIDE", trace: next };
  }
  if (side.exposure === "short" && scale(stop) <= scale(entry)) {
    return { state: "REJECT", reason: scale(stop) === scale(entry) ? "ZERO_RISK_DISTANCE" : "STOP_WRONG_SIDE", trace: next };
  }
  const target = targetsOk(decision, intent, entry, side.exposure);
  if (target !== null) {
    return { state: target === "INCONSISTENT_TARGET" ? "INVALID" : "REJECT", reason: target, trace: next };
  }
  if (needsKnownExposure(config, decision.direction) && account.exposureSide === "unknown") {
    return { state: "BLOCKED", reason: "UNKNOWN_EXISTING_EXPOSURE", trace: next };
  }
  if (
    (decision.direction === "MANAGE_EXISTING_POSITION" || decision.direction === "EXIT_EXISTING_POSITION")
    && account.exposureSide === "none"
  ) {
    return { state: "REJECT", reason: "NO_OPEN_POSITION", trace: next };
  }
  const budget = riskBudget(config, account);
  if (budget.done) return { ...budget.done, trace: { ...next, riskBudget: budget.riskBudget } };
  next.riskBudget = budget.riskBudget;
  const perLotScaled = scale(perLot);
  const maxFromBudget = perLotScaled === 0n ? 0n : (budget.sizingScaled * scale(1)) / perLotScaled;
  next.calculatedMaximumQuantity = unscale(maxFromBudget);
  const ceiling = positionCeiling(config, account, decision.direction);
  if (ceiling === "blocked") return { state: "BLOCKED", reason: "UNKNOWN_EXISTING_EXPOSURE", trace: next };
  const allowed = maximumAllowed(maxFromBudget, config, ceiling);
  next.maximumAllowedQuantity = unscale(allowed);
  if (requested === null) {
    return deriveQuantity(config, budget.sizingScaled, budget.equityScaled, maxFromBudget, perLotScaled, ceiling, next);
  }
  return validateRequested(config, account, budget.sizingScaled, budget.equityScaled, requested, perLotScaled, ceiling, next);
}

function readPrices(
  decision: Decision,
  intent: OrderIntent,
  trace: RiskTrace,
): { done: Sized } | { done: null; entry: number; stop: number; distance: number; perLot: number } {
  if (intent.entry === undefined) return { done: { state: "INVALID", reason: "MISSING_ENTRY", trace } };
  if (typeof intent.entry !== "number" || !Number.isFinite(intent.entry) || intent.entry <= 0) {
    return { done: { state: "INVALID", reason: "INVALID_ENTRY", trace } };
  }
  if (intent.stop === undefined) return { done: { state: "INVALID", reason: "MISSING_STOP", trace } };
  if (typeof intent.stop !== "number" || !Number.isFinite(intent.stop) || intent.stop <= 0) {
    return { done: { state: "INVALID", reason: "INVALID_STOP", trace } };
  }
  if (decision.stop !== undefined && scale(decision.stop) !== scale(intent.stop)) {
    return { done: { state: "INVALID", reason: "INCONSISTENT_STOP", trace } };
  }
  const distance = unscale(scale(intent.entry) > scale(intent.stop)
    ? scale(intent.entry) - scale(intent.stop)
    : scale(intent.stop) - scale(intent.entry));
  if (scale(distance) === 0n) return { done: { state: "REJECT", reason: "ZERO_RISK_DISTANCE", trace } };
  const perLot = unscale(scale(distance) * BigInt(XAUUSD_OUNCES_PER_LOT));
  return { done: null, entry: intent.entry, stop: intent.stop, distance, perLot };
}

function stopSide(
  direction: Decision["direction"],
  account: AccountRiskState,
): { done: Sized | null; exposure: "long" | "short" } {
  if (direction === "LONG") return { done: null, exposure: "long" };
  if (direction === "SHORT") return { done: null, exposure: "short" };
  if (account.exposureSide === "long" || account.exposureSide === "short") {
    return { done: null, exposure: account.exposureSide };
  }
  if (account.exposureSide === "unknown") {
    return { done: { state: "BLOCKED", reason: "UNKNOWN_EXISTING_EXPOSURE", trace: blankTrace(null) }, exposure: "long" };
  }
  return { done: { state: "REJECT", reason: "NO_OPEN_POSITION", trace: blankTrace(null) }, exposure: "long" };
}

function targetsOk(
  decision: Decision,
  intent: OrderIntent,
  entry: number,
  exposure: "long" | "short",
): RiskReason | null {
  const decisionTargets = decision.targets;
  const intentTargets = intent.targets;
  if (decisionTargets.length !== intentTargets.length) return "INCONSISTENT_TARGET";
  for (let index = 0; index < intentTargets.length; index += 1) {
    const target = intentTargets[index];
    const other = decisionTargets[index];
    if (target === undefined || other === undefined || scale(target) !== scale(other)) return "INCONSISTENT_TARGET";
    if (typeof target !== "number" || !Number.isFinite(target) || target <= 0) return "TARGET_WRONG_SIDE";
    if (exposure === "long" && scale(target) <= scale(entry)) return "TARGET_WRONG_SIDE";
    if (exposure === "short" && scale(target) >= scale(entry)) return "TARGET_WRONG_SIDE";
  }
  return null;
}

function needsKnownExposure(config: RiskConfig, direction: Decision["direction"]): boolean {
  if (direction === "MANAGE_EXISTING_POSITION" || direction === "EXIT_EXISTING_POSITION") return true;
  return config.maxOpenExposure !== null;
}

function riskBudget(
  config: RiskConfig,
  account: AccountRiskState,
): { done: Sized | null; equityScaled: bigint; sizingScaled: bigint; riskBudget: number } {
  let equity = mul(scale(account.equity), scale(config.maxRiskPercent));
  if (config.maxRiskAmount !== null && scale(config.maxRiskAmount) < equity) equity = scale(config.maxRiskAmount);
  let sizing = equity;
  if (config.maxConcurrentRisk !== null) {
    if (account.openRiskAmount === null) {
      return {
        done: { state: "BLOCKED", reason: "ACCOUNT_STATE_UNAVAILABLE", trace: blankTrace(null) },
        equityScaled: equity,
        sizingScaled: equity,
        riskBudget: unscale(equity),
      };
    }
    const remaining = scale(config.maxConcurrentRisk) - scale(account.openRiskAmount);
    if (remaining <= 0n) {
      return {
        done: { state: "REJECT", reason: "RISK_BUDGET_EXCEEDED", trace: blankTrace(null) },
        equityScaled: equity,
        sizingScaled: 0n,
        riskBudget: unscale(equity),
      };
    }
    if (remaining < sizing) sizing = remaining;
  }
  return { done: null, equityScaled: equity, sizingScaled: sizing, riskBudget: unscale(equity) };
}

type QuantityCeiling = {
  readonly kind: "open-lots" | "exposure";
  readonly lots: bigint;
};

function positionCeiling(
  config: RiskConfig,
  account: AccountRiskState,
  direction: Decision["direction"],
): QuantityCeiling | null | "blocked" {
  if (direction === "MANAGE_EXISTING_POSITION" || direction === "EXIT_EXISTING_POSITION") {
    if (account.exposureLots === null) return "blocked";
    return { kind: "open-lots", lots: scale(account.exposureLots) };
  }
  if (config.maxOpenExposure === null) return null;
  if (account.exposureSide === "unknown") return "blocked";
  const existing = account.exposureLots === null ? 0n : scale(account.exposureLots);
  const room = scale(config.maxOpenExposure) - existing;
  return { kind: "exposure", lots: room > 0n ? room : 0n };
}

function maximumAllowed(maxFromBudget: bigint, config: RiskConfig, ceiling: QuantityCeiling | null): bigint {
  let allowed = maxFromBudget;
  if (config.maxPositionQuantity !== null) {
    const cap = scale(config.maxPositionQuantity);
    if (cap < allowed) allowed = cap;
  }
  if (ceiling !== null && ceiling.lots < allowed) allowed = ceiling.lots;
  return allowed > 0n ? allowed : 0n;
}

function deriveQuantity(
  config: RiskConfig,
  sizingScaled: bigint,
  equityScaled: bigint,
  maxFromBudget: bigint,
  perLotScaled: bigint,
  ceiling: QuantityCeiling | null,
  trace: Draft,
): Sized {
  let quantity = maxFromBudget;
  let limitedBy: "budget" | "position" | "open-lots" | "exposure" = "budget";
  if (config.maxPositionQuantity !== null && quantity > scale(config.maxPositionQuantity)) {
    quantity = scale(config.maxPositionQuantity);
    limitedBy = "position";
  }
  if (ceiling !== null && quantity > ceiling.lots) {
    quantity = ceiling.lots;
    limitedBy = ceiling.kind;
  }
  const rounding = config.quantityStep === null ? "none" : "floor";
  if (config.quantityStep !== null) quantity = floorToStep(quantity, scale(config.quantityStep));
  const stepped = fitBudget(quantity, config.quantityStep, sizingScaled, perLotScaled);
  const next: RiskTrace = { ...trace, roundingMode: rounding, acceptedQuantity: null, rejectedQuantity: null };
  if (stepped <= 0n) {
    const reason = limitedBy === "exposure"
      ? "EXPOSURE_LIMIT_EXCEEDED"
      : limitedBy === "position" || limitedBy === "open-lots"
        ? "POSITION_SIZE_EXCEEDED"
        : "RISK_BUDGET_EXCEEDED";
    return { state: "REJECT", reason, trace: next };
  }
  if (config.minPositionQuantity !== null && stepped < scale(config.minPositionQuantity)) {
    return { state: "REJECT", reason: "QUANTITY_INVALID", trace: next };
  }
  return acceptQuantity(stepped, perLotScaled, equityScaled, next);
}

function validateRequested(
  config: RiskConfig,
  account: AccountRiskState,
  sizingScaled: bigint,
  equityScaled: bigint,
  requested: number,
  perLotScaled: bigint,
  ceiling: QuantityCeiling | null,
  trace: Draft,
): Sized {
  const requestedScaled = scale(requested);
  const next: Draft = {
    ...trace,
    roundingMode: "none",
    rejectedQuantity: requested,
    acceptedQuantity: null,
  };
  if (config.quantityStep !== null && !onStep(requestedScaled, scale(config.quantityStep))) {
    return { state: "REJECT", reason: "QUANTITY_STEP_INVALID", trace: next };
  }
  if (config.minPositionQuantity !== null && requestedScaled < scale(config.minPositionQuantity)) {
    return { state: "REJECT", reason: "QUANTITY_INVALID", trace: next };
  }
  if (config.maxPositionQuantity !== null && requestedScaled > scale(config.maxPositionQuantity)) {
    return { state: "REJECT", reason: "POSITION_SIZE_EXCEEDED", trace: next };
  }
  if (ceiling !== null && requestedScaled > ceiling.lots) {
    const reason = ceiling.kind === "open-lots" ? "POSITION_SIZE_EXCEEDED" : "EXPOSURE_LIMIT_EXCEEDED";
    return { state: "REJECT", reason, trace: next };
  }
  const resulting = (requestedScaled * perLotScaled) / scale(1);
  next.resultingRiskAmount = unscale(resulting);
  next.resultingRiskPercent = unscale((resulting * scale(1)) / scale(account.equity));
  if (resulting > sizingScaled || resulting > equityScaled) return { state: "REJECT", reason: "RISK_BUDGET_EXCEEDED", trace: next };
  return acceptQuantity(requestedScaled, perLotScaled, equityScaled, next);
}

function acceptQuantity(quantity: bigint, perLotScaled: bigint, equityScaled: bigint, trace: RiskTrace): Sized {
  const resulting = (quantity * perLotScaled) / scale(1);
  const next: RiskTrace = {
    ...trace,
    acceptedQuantity: unscale(quantity),
    rejectedQuantity: null,
    resultingRiskAmount: unscale(resulting),
    resultingRiskPercent: trace.equity === null ? null : unscale((resulting * scale(1)) / scale(trace.equity)),
  };
  if (quantity <= 0n) return { state: "REJECT", reason: "QUANTITY_INVALID", trace: next };
  if (trace.requestedQuantity !== null && quantity !== scale(trace.requestedQuantity)) {
    return {
      state: "REJECT",
      reason: "POSITION_SIZE_EXCEEDED",
      trace: { ...next, acceptedQuantity: null, rejectedQuantity: trace.requestedQuantity },
    };
  }
  if (resulting > equityScaled) return { state: "REJECT", reason: "RISK_BUDGET_EXCEEDED", trace: next };
  return { state: "ACCEPT", reason: "RISK_WITHIN_LIMITS", trace: next };
}

function fitBudget(quantity: bigint, step: number | null, budget: bigint, perLot: bigint): bigint {
  let next = quantity;
  const quantum = step === null ? 1n : scale(step);
  for (let guard = 0; guard < 100_000 && next > 0n; guard += 1) {
    const risk = (next * perLot) / scale(1);
    if (risk <= budget) return next;
    next -= quantum;
  }
  return next > 0n ? 0n : next;
}

function blankTrace(configVersion: string | null): Draft {
  return {
    equity: null,
    maxRiskPercent: null,
    riskBudget: null,
    entry: null,
    stop: null,
    stopDistance: null,
    contractSize: XAUUSD_OUNCES_PER_LOT,
    riskPerLot: null,
    requestedQuantity: null,
    calculatedMaximumQuantity: null,
    maximumAllowedQuantity: null,
    acceptedQuantity: null,
    rejectedQuantity: null,
    resultingRiskAmount: null,
    resultingRiskPercent: null,
    openExposureLots: null,
    configVersion,
    contractVersion: XAUUSD_CONTRACT_VERSION,
    roundingMode: null,
    quantityStep: null,
    accountProvenance: null,
    marketProvenance: null,
    marketFreshness: null,
  };
}

function fail(
  located: {
    readonly input: RiskAssessmentInput;
    readonly agentRunId: string;
    readonly configId: string | null;
    readonly environment: TradingEnvironment;
    readonly decisionId: string | null;
    readonly orderIntentId: string | null;
    readonly snapshotId: string | null;
    readonly versionManifestId: string | null;
  },
  state: RiskState,
  reason: RiskReason,
  trace: RiskTrace,
): RiskDecision {
  return decide({
    ...located,
    state,
    reasons: [reason],
    trace,
    includeCheck: located.decisionId !== null && located.snapshotId !== null && located.versionManifestId !== null,
  });
}

function decide(input: {
  readonly input: RiskAssessmentInput;
  readonly state: RiskState;
  readonly reasons: [RiskReason, ...RiskReason[]];
  readonly trace: RiskTrace;
  readonly configId: string | null;
  readonly environment: TradingEnvironment;
  readonly decisionId: string | null;
  readonly orderIntentId: string | null;
  readonly snapshotId: string | null;
  readonly versionManifestId: string | null;
  readonly agentRunId: string;
  readonly includeCheck: boolean;
}): RiskDecision {
  const evaluationRunId = input.input.evaluationRunId ?? null;
  const id = `risk.${contentHash({
    schema: RISK_ENGINE_VERSION,
    state: input.state,
    reasons: input.reasons,
    trace: input.trace,
    configId: input.configId,
    decisionId: input.decisionId,
    orderIntentId: input.orderIntentId,
    snapshotId: input.snapshotId,
    agentRunId: input.agentRunId,
    evaluationRunId,
    assessedAt: input.input.assessedAt,
    environment: input.environment,
  }).slice(0, 40)}`;
  const check = input.includeCheck && input.decisionId && input.snapshotId && input.versionManifestId
    ? buildCheck(input, id)
    : null;
  const correlationId = evaluationRunId ?? input.decisionId ?? input.agentRunId;
  const events = [
    fact(input, id, "risk.check.started", "started", correlationId),
    fact(input, id, eventType(input.state), input.state, correlationId),
  ].filter((event): event is TradingEvent => event !== null);
  return {
    schemaVersion: RISK_ENGINE_VERSION,
    id,
    state: input.state,
    reasons: input.reasons,
    check,
    trace: input.trace,
    agentRunId: input.agentRunId,
    evaluationRunId,
    configId: input.configId,
    decisionId: input.decisionId,
    orderIntentId: input.orderIntentId,
    snapshotId: input.snapshotId,
    liveExecutionEnabled: false,
    events,
  };
}

function buildCheck(
  input: {
    readonly input: RiskAssessmentInput;
    readonly state: RiskState;
    readonly reasons: readonly RiskReason[];
    readonly environment: TradingEnvironment;
    readonly decisionId: string | null;
    readonly snapshotId: string | null;
    readonly versionManifestId: string | null;
    readonly agentRunId: string;
  },
  id: string,
): RiskDecision["check"] {
  const status: CheckStatus = input.state === "ACCEPT" ? "PASSED" : input.state === "BLOCKED" ? "UNAVAILABLE" : "FAILED";
  try {
    return parseRiskCheck({
      schemaVersion: 1,
      id,
      agentRunId: input.agentRunId,
      environment: input.environment,
      instrument: XAUUSD_INSTRUMENT,
      decisionId: input.decisionId,
      snapshotId: input.snapshotId,
      versionManifestId: input.versionManifestId,
      status,
      failClosed: status !== "PASSED",
      reasons: input.reasons,
      createdAt: input.input.assessedAt,
    });
  } catch {
    return null;
  }
}

function eventType(state: RiskState): TradingEventType {
  if (state === "ACCEPT") return "risk.check.passed";
  if (state === "BLOCKED") return "risk.check.blocked";
  return "risk.check.failed";
}

function fact(
  input: {
    readonly input: RiskAssessmentInput;
    readonly state: RiskState;
    readonly reasons: readonly RiskReason[];
    readonly environment: TradingEnvironment;
    readonly agentRunId: string;
    readonly configId: string | null;
  },
  id: string,
  type: TradingEventType,
  nextState: string,
  correlationId: string,
): TradingEvent | null {
  const prefix = type === "risk.check.started" ? "rs" : "rc";
  return tradingFact({
    type,
    eventId: `${prefix}.${id}`,
    at: input.input.assessedAt,
    agentRunId: input.agentRunId,
    correlationId,
    environment: input.environment,
    actor: "xauusd-risk",
    nextState,
    runtimeThreadId: input.input.runtimeThreadId,
    runtimeTurnId: input.input.runtimeTurnId,
    payload: {
      state: input.state,
      reasons: input.reasons,
      riskDecisionId: id,
      configId: input.configId,
      fact: riskInfrastructureFact(input.state),
    },
  });
}
