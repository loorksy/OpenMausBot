import { AUTONOMY_NAMES } from "../../../shared/trading/autonomy.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { assertNoSecretFields } from "../../../shared/trading/ids.ts";
import { parseTradingEvent, type TradingEvent } from "../../../shared/trading/events.ts";
import { parseDecision } from "../../../shared/trading/decision.ts";
import { reviseImmutable } from "../../../shared/trading/immutable.ts";
import { parseOrderIntent } from "../../../shared/trading/order-intent.ts";
import type { RuntimeEvent } from "../../../shared/runtime-events.ts";
import { redactMarketText } from "../infrastructure/market_data/model.ts";
import type { MarketRequest } from "../infrastructure/market_data/model.ts";
import { readXauUsdCandles, readXauUsdQuote } from "../infrastructure/market_data/read.ts";
import { buildXauUsdMarketContext, createXauUsdMarketSnapshot } from "../infrastructure/market_data/snapshot.ts";
import {
  describeTool,
  filterToolCatalog,
  isForbiddenExecutionTool,
  toolSpec,
  XAUUSD_TOOL_CATALOG,
  XAUUSD_TOOL_CATALOG_VERSION,
} from "./catalog.ts";
import { fenceExternalEvidence } from "./evidence-fence.ts";
import type { XauUsdSessionState } from "./state.ts";
import { assertToolSchema } from "./schema.ts";

export interface XauUsdToolCallResult {
  readonly ok: boolean;
  readonly body: Record<string, unknown>;
  readonly tradingEvents: readonly TradingEvent[];
  readonly runtimeEvents: readonly RuntimeEvent[];
}

class ToolCallError extends Error {
  readonly events: readonly TradingEvent[];

  constructor(
    message: string,
    readonly availability: "failed" | "unavailable" | "rejected",
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
    events: readonly TradingEvent[] = [],
  ) {
    super(message);
    this.name = "ToolCallError";
    this.events = events;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function marketRequest(state: XauUsdSessionState, runtimeEventId: string): MarketRequest {
  return {
    agentRunId: state.grant.agentRunId,
    correlationId: state.grant.correlation.runtimeTurnId,
    versionManifestId: state.manifest.id,
    clock: state.clock,
    runtime: {
      eventId: runtimeEventId,
      threadId: state.grant.correlation.runtimeThreadId,
      turnId: state.grant.correlation.runtimeTurnId,
    },
    nextEventId: () => state.grant.correlation.nextTradingEventId(),
  };
}

function tradingEvent(
  state: XauUsdSessionState,
  type: TradingEvent["type"],
  runtimeEventId: string,
  payload: Record<string, unknown>,
): TradingEvent {
  return parseTradingEvent({
    schemaVersion: 1,
    eventId: state.grant.correlation.nextTradingEventId(),
    type,
    source: "trading-domain",
    at: state.clock.processedAt,
    agentRunId: state.grant.agentRunId,
    correlationId: state.grant.correlation.runtimeTurnId,
    environment: state.grant.environment,
    instrument: "XAUUSD",
    actor: "xauusd-tools",
    runtimeEventId,
    runtimeThreadId: state.grant.correlation.runtimeThreadId,
    runtimeTurnId: state.grant.correlation.runtimeTurnId,
    payload,
  });
}

function runtimeItem(
  state: XauUsdSessionState,
  eventId: string,
  name: string,
  outcome?: { readonly ok: boolean; readonly output: string },
): RuntimeEvent {
  const base = {
    eventId,
    provider: state.grant.modelProvider,
    threadId: state.grant.correlation.runtimeThreadId,
    turnId: state.grant.correlation.runtimeTurnId,
    createdAt: state.clock.processedAt,
    itemId: eventId,
  };
  if (!outcome) {
    return { ...base, type: "item.started", itemType: "tool", title: name };
  }
  return { ...base, type: "item.completed", itemType: "tool", ok: outcome.ok, output: outcome.output };
}

function emitRuntime(state: XauUsdSessionState, event: RuntimeEvent, sink: RuntimeEvent[]): void {
  sink.push(event);
  state.grant.emitRuntime?.(event);
}

function failureBody(state: XauUsdSessionState, name: string, error: ToolCallError): Record<string, unknown> {
  return {
    ok: false,
    tool: name,
    instrument: "XAUUSD",
    agentRunId: state.grant.agentRunId,
    environment: state.grant.environment,
    availability: error.availability,
    code: error.code,
    message: redactMarketText(error.message),
    failClosed: true,
    ...error.extra,
  };
}

function assertNoControlFields(args: Record<string, unknown>): void {
  assertNoSecretFields(args, "tool arguments");
  for (const key of ["executable", "brokerSubmit", "submit", "place_order"]) {
    if (key in args) {
      throw new TradingDomainError("order_intent_not_executable", "a trading tool cannot carry execution authority");
    }
  }
  if ("probability" in args || "calibratedProbability" in args) {
    throw new ToolCallError(
      "A probability without a documented calibration mechanism is not stored",
      "rejected",
      "tool_rejected",
      { probabilityStored: false },
    );
  }
  if ("symbol" in args || "instrument" in args) {
    const named = "instrument" in args ? args.instrument : args.symbol;
    if (named !== "XAUUSD") {
      throw new TradingDomainError("instrument_rejected", "market data must be XAUUSD");
    }
    throw new TradingDomainError("tool_rejected", "XAUUSD tools do not accept a symbol argument");
  }
}

async function listTools(state: XauUsdSessionState): Promise<Record<string, unknown>> {
  const filtered = filterToolCatalog(XAUUSD_TOOL_CATALOG, state.gate);
  return {
    ok: true,
    tool: "list_xauusd_tools",
    catalogVersion: XAUUSD_TOOL_CATALOG_VERSION,
    instrument: "XAUUSD",
    agentRunId: state.grant.agentRunId,
    environment: state.grant.environment,
    autonomyLevel: state.grant.autonomyLevel,
    autonomyName: AUTONOMY_NAMES[state.grant.autonomyLevel],
    approvalModeIsNotTradingAuthorization: true,
    tools: filtered.available.map(describeTool),
    unavailable: filtered.unavailable.map(({ spec, reason }) => ({
      name: spec.name,
      availability: "unavailable" as const,
      reason,
    })),
    executionTools: [],
  };
}

async function readQuote(state: XauUsdSessionState, runtimeEventId: string): Promise<{ body: Record<string, unknown>; events: TradingEvent[] }> {
  const result = await readXauUsdQuote(state.grant.provider, marketRequest(state, runtimeEventId));
  if (!result.ok) {
    throw new ToolCallError(result.message, "failed", result.failure, {
      provenance: result.provenance,
      freshness: result.freshness,
    }, result.events);
  }
  const sealed = createXauUsdMarketSnapshot({
    id: state.grant.correlation.nextRecordId(),
    request: marketRequest(state, runtimeEventId),
    quote: result.data,
  });
  const context = buildXauUsdMarketContext(sealed.snapshot, {
    id: state.grant.correlation.nextRecordId(),
  });
  state.snapshots.set(sealed.snapshot.id, sealed.snapshot);
  state.contexts.set(context.id, context);
  const quote = result.data;
  return {
    events: [...result.events, ...sealed.events],
    body: {
      ok: true,
      tool: "get_xauusd_quote",
      instrument: "XAUUSD",
      agentRunId: state.grant.agentRunId,
      environment: state.grant.environment,
      provenance: quote.provenance,
      freshness: quote.freshness,
      snapshotId: sealed.snapshot.id,
      contextId: context.id,
      providerId: quote.providerId,
      providerTimestamp: quote.providerTimestamp,
      receivedAt: quote.receivedAt,
      processedAt: quote.processedAt,
      latencyMs: quote.latencyMs,
      skewMs: quote.skewMs,
      abnormalLatency: quote.abnormalLatency,
      normalizations: quote.normalizations,
      quote: { bid: quote.bid, ask: quote.ask, spread: quote.spread },
    },
  };
}

async function readCandles(
  state: XauUsdSessionState,
  args: Record<string, unknown>,
  runtimeEventId: string,
): Promise<{ body: Record<string, unknown>; events: TradingEvent[] }> {
  const result = await readXauUsdCandles(
    state.grant.provider,
    args.timeframe,
    { from: String(args.from), to: String(args.to) },
    marketRequest(state, runtimeEventId),
  );
  if (!result.ok) {
    throw new ToolCallError(result.message, "failed", result.failure, {
      provenance: result.provenance,
      freshness: result.freshness,
    }, result.events);
  }
  const sealed = createXauUsdMarketSnapshot({
    id: state.grant.correlation.nextRecordId(),
    request: marketRequest(state, runtimeEventId),
    series: result.data,
  });
  const context = buildXauUsdMarketContext(sealed.snapshot, {
    id: state.grant.correlation.nextRecordId(),
  });
  state.snapshots.set(sealed.snapshot.id, sealed.snapshot);
  state.contexts.set(context.id, context);
  const series = result.data;
  return {
    events: [...result.events, ...sealed.events],
    body: {
      ok: true,
      tool: "get_xauusd_candles",
      instrument: "XAUUSD",
      agentRunId: state.grant.agentRunId,
      environment: state.grant.environment,
      timeframe: series.timeframe,
      provenance: series.provenance,
      freshness: series.freshness,
      snapshotId: sealed.snapshot.id,
      contextId: context.id,
      providerTimestamp: series.providerTimestamp,
      receivedAt: series.receivedAt,
      processedAt: series.processedAt,
      normalizations: series.normalizations,
      candles: series.candles.map((candle) => ({ ...candle })),
    },
  };
}

function requireKnownIds(state: XauUsdSessionState, ids: readonly string[], label: string): void {
  for (const id of ids) {
    if (!state.evidence.has(id)) {
      throw new TradingDomainError("tool_rejected", `${label} ${id} is not evidence in this run`);
    }
  }
}

async function proposeDecision(state: XauUsdSessionState, args: Record<string, unknown>): Promise<{ body: Record<string, unknown>; events: TradingEvent[] }> {
  const evidenceIds = args.evidenceIds as string[];
  const supporting = args.supportingEvidenceIds as string[];
  const contradicting = args.contradictingEvidenceIds as string[];
  requireKnownIds(state, evidenceIds, "evidence");
  for (const id of [...supporting, ...contradicting]) {
    if (!evidenceIds.includes(id)) {
      throw new TradingDomainError("tool_rejected", "cited evidence must also be listed on the decision");
    }
  }
  const snapshot = state.snapshots.get(String(args.snapshotId));
  const context = state.contexts.get(String(args.contextId));
  if (!snapshot || snapshot.agentRunId !== state.grant.agentRunId) {
    throw new TradingDomainError("tool_rejected", "snapshot is not part of this run");
  }
  if (!context || context.agentRunId !== state.grant.agentRunId || context.snapshotId !== snapshot.id) {
    throw new TradingDomainError("tool_rejected", "context does not match the snapshot in this run");
  }
  const id = state.grant.correlation.nextRecordId();
  const supersedes = typeof args.supersedes === "string" ? args.supersedes : undefined;
  const previous = supersedes ? state.decisions.get(supersedes) : undefined;
  if (supersedes && !previous) {
    throw new TradingDomainError("tool_rejected", "supersedes does not name a decision in this run");
  }
  const drafted = parseDecision({
    schemaVersion: 1,
    id,
    agentRunId: state.grant.agentRunId,
    environment: state.grant.environment,
    instrument: "XAUUSD",
    createdAt: state.clock.processedAt,
    status: "DRAFT",
    thesis: args.thesis,
    contextId: context.id,
    snapshotId: snapshot.id,
    evidenceIds,
    supportingEvidenceIds: supporting,
    contradictingEvidenceIds: contradicting,
    missingInformation: args.missingInformation,
    ...(typeof args.regimeId === "string" ? { regimeId: args.regimeId } : {}),
    ...(typeof args.scenarioId === "string" ? { scenarioId: args.scenarioId } : {}),
    direction: args.direction,
    ...(typeof args.trigger === "string" ? { trigger: args.trigger } : {}),
    ...(typeof args.entryConditions === "string" ? { entryConditions: args.entryConditions } : {}),
    ...(typeof args.invalidation === "string" ? { invalidation: args.invalidation } : {}),
    ...(typeof args.stop === "number" ? { stop: args.stop } : {}),
    targets: args.targets,
    ...(typeof args.riskIntent === "string" ? { riskIntent: args.riskIntent } : {}),
    ...(typeof args.policyConditions === "string" ? { policyConditions: args.policyConditions } : {}),
    expiry: args.expiry,
    evidenceQuality: args.evidenceQuality,
    versionManifestId: state.manifest.id,
    ...(typeof args.supersedes === "string" ? { supersedes: args.supersedes } : {}),
  });
  const stored = previous ? reviseImmutable(previous, drafted) : drafted;
  state.decisions.set(stored.id, stored);
  return {
    events: [tradingEvent(state, "decision.created", state.activeRuntimeEventId, {
      decisionId: stored.id,
      direction: stored.direction,
      snapshotId: stored.snapshotId,
    })],
    body: {
      ok: true,
      tool: "propose_decision",
      agentRunId: state.grant.agentRunId,
      probabilityStored: false,
      decision: stored,
    },
  };
}

async function proposeIntent(state: XauUsdSessionState, args: Record<string, unknown>): Promise<{ body: Record<string, unknown>; events: TradingEvent[] }> {
  const decision = state.decisions.get(String(args.decisionId));
  if (!decision || decision.agentRunId !== state.grant.agentRunId) {
    throw new TradingDomainError("tool_rejected", "order intent requires a decision from this run");
  }
  if (decision.direction !== args.direction) {
    throw new TradingDomainError("tool_rejected", "order intent direction must match the decision");
  }
  const intent = parseOrderIntent({
    schemaVersion: 1,
    kind: "order-intent",
    id: state.grant.correlation.nextRecordId(),
    agentRunId: state.grant.agentRunId,
    environment: state.grant.environment,
    instrument: "XAUUSD",
    decisionId: decision.id,
    createdAt: state.clock.processedAt,
    direction: args.direction,
    executable: false,
    brokerSubmit: false,
    ...(typeof args.entry === "number" ? { entry: args.entry } : {}),
    ...(typeof args.stop === "number" ? { stop: args.stop } : {}),
    targets: args.targets,
  });
  state.intents.set(intent.id, intent);
  return {
    events: [tradingEvent(state, "order.intent.created", state.activeRuntimeEventId, {
      orderIntentId: intent.id,
      decisionId: decision.id,
      executable: false,
      brokerContacted: false,
    })],
    body: {
      ok: true,
      tool: "propose_order_intent",
      executed: false,
      brokerContacted: false,
      orderIntent: intent,
    },
  };
}

async function consult(state: XauUsdSessionState, args: Record<string, unknown>): Promise<{ body: Record<string, unknown>; events: TradingEvent[] }> {
  const ask = state.grant.askSpecialist;
  if (!ask) throw new TradingDomainError("tool_unavailable", "no specialist consultant is attached");
  const reply = await ask({
    specialty: args.specialty as "technical" | "macro" | "regime" | "trade_management",
    question: String(args.question),
  });
  if (typeof reply?.text !== "string" || reply.text.trim() === "") {
    throw new TradingDomainError("tool_rejected", "specialist returned an empty result");
  }
  const fenced = fenceExternalEvidence({
    id: state.grant.correlation.nextRecordId(),
    agentRunId: state.grant.agentRunId,
    environment: state.grant.environment,
    kind: "tool_output",
    excerpt: reply.text,
    receivedAt: state.clock.receivedAt,
    createdAt: state.clock.processedAt,
    provider: "specialist",
  });
  state.evidence.set(fenced.evidence.id, fenced.evidence);
  return {
    events: [],
    body: {
      ok: true,
      tool: "consult_specialist",
      agentRunId: state.grant.agentRunId,
      evidence: fenced.evidence,
      fence: fenced.fence,
    },
  };
}

/** Run the single tool the caller named. This function does not pick a next tool. */
export async function invokeXauUsdTool(
  state: XauUsdSessionState,
  name: string,
  args: unknown,
  signal: AbortSignal,
): Promise<XauUsdToolCallResult> {
  if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
  const tradingEvents: TradingEvent[] = [];
  const runtimeEvents: RuntimeEvent[] = [];
  const startedId = state.grant.correlation.nextRuntimeEventId();
  state.activeRuntimeEventId = startedId;
  emitRuntime(state, runtimeItem(state, startedId, name), runtimeEvents);
  tradingEvents.push(tradingEvent(state, "agent.tool.started", startedId, {
    tool: name,
    catalogVersion: XAUUSD_TOOL_CATALOG_VERSION,
  }));
  try {
    if (!isRecord(args)) throw new TradingDomainError("tool_rejected", "tool arguments must be an object");
    assertNoControlFields(args);
    if (isForbiddenExecutionTool(name)) {
      throw new TradingDomainError("tool_rejected", "execution tools are not model-accessible");
    }
    const spec = toolSpec(name);
    if (!spec) throw new TradingDomainError("tool_rejected", "unknown trading tool");
    const withheld = filterToolCatalog([spec], state.gate).unavailable[0];
    if (withheld) throw new TradingDomainError("tool_unavailable", withheld.reason ?? "unavailable");
    assertToolSchema(spec.inputSchema, args);
    let produced: { body: Record<string, unknown>; events: TradingEvent[] };
    if (name === "list_xauusd_tools") produced = { body: await listTools(state), events: [] };
    else if (name === "get_xauusd_quote") produced = await readQuote(state, startedId);
    else if (name === "get_xauusd_candles") produced = await readCandles(state, args, startedId);
    else if (name === "propose_decision") produced = await proposeDecision(state, args);
    else if (name === "propose_order_intent") produced = await proposeIntent(state, args);
    else if (name === "consult_specialist") produced = await consult(state, args);
    else throw new TradingDomainError("tool_unavailable", spec.unavailableReason ?? "unavailable");
    tradingEvents.push(...produced.events);
    const completedId = state.grant.correlation.nextRuntimeEventId();
    emitRuntime(state, runtimeItem(state, completedId, name, { ok: true, output: `ok:${name}` }), runtimeEvents);
    tradingEvents.push(tradingEvent(state, "agent.tool.completed", completedId, { tool: name, ok: true }));
    return { ok: true, body: produced.body, tradingEvents, runtimeEvents };
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    const toolError = error instanceof ToolCallError
      ? error
      : error instanceof TradingDomainError
        ? new ToolCallError(error.message, error.code === "tool_unavailable" ? "unavailable" : "rejected", error.code)
        : new ToolCallError(error instanceof Error ? error.message : "tool failed", "failed", "tool_rejected");
    tradingEvents.push(...toolError.events);
    const completedId = state.grant.correlation.nextRuntimeEventId();
    const body = failureBody(state, name, toolError);
    emitRuntime(state, runtimeItem(state, completedId, name, { ok: false, output: `failed:${toolError.code}` }), runtimeEvents);
    tradingEvents.push(tradingEvent(state, "agent.failed", completedId, {
      tool: name,
      code: toolError.code,
      message: String(body.message),
    }));
    return { ok: false, body, tradingEvents, runtimeEvents };
  }
}
