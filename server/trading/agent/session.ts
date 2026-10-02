import type { Decision } from "../../../shared/trading/decision.ts";
import type { OrderIntent } from "../../../shared/trading/order-intent.ts";
import { AUTONOMY_LEVELS } from "../../../shared/trading/autonomy.ts";
import { assertProvenanceForEnvironment, parseTradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { recordIdSchema } from "../../../shared/trading/ids.ts";
import { parseTradingEvent, type TradingEvent } from "../../../shared/trading/events.ts";
import { assertReplayDataset, parseVersionManifest } from "../../../shared/trading/version-manifest.ts";
import type { RuntimeEvent } from "../../../shared/runtime-events.ts";
import { assessClock, assertClockLimits, canonicalizeUtc } from "../infrastructure/market_data/clock.ts";
import type { MarketClock } from "../infrastructure/market_data/model.ts";
import {
  TRADING_PERMISSIONS,
  XAUUSD_TOOL_CATALOG,
  XAUUSD_TOOL_CATALOG_VERSION,
  filterToolCatalog,
  type TradingPermission,
} from "./catalog.ts";
import type { XauUsdTurnGrant } from "./grant.ts";
import { invokeXauUsdTool } from "./invoke.ts";
import { selectTradingModel } from "./routing.ts";
import type { XauUsdSessionState } from "./state.ts";

export const XAUUSD_RUNTIME_VERSION = "0.1.92";
export const XAUUSD_AGENT_PROMPT_VERSION = "xauusd-agent-1";

export interface XauUsdToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface XauUsdToolResult {
  readonly text: string;
  readonly ok: boolean;
}

/** Same shape the chat-completions tool loop already executes. */
export interface XauUsdToolSession {
  readonly definitions: XauUsdToolDefinition[];
  readonly agentRunId: string;
  readonly catalogVersion: string;
  readonly environment: XauUsdTurnGrant["environment"];
  readonly autonomyLevel: XauUsdTurnGrant["autonomyLevel"];
  readonly modelId: string;
  readonly modelFallback?: XauUsdSessionState["modelFallback"];
  readonly ignoredApprovalMode: XauUsdTurnGrant["approvalMode"];
  readonly executionAuthority: false;
  readonly occurrenceId: string | null;
  readonly runtimeThreadId: string;
  readonly invocations: readonly string[];
  readonly tradingEvents: readonly TradingEvent[];
  readonly runtimeEvents: readonly RuntimeEvent[];
  decisions(): readonly Decision[];
  intents(): readonly OrderIntent[];
  validate(name: string, args: unknown): void;
  execute(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<XauUsdToolResult>;
  close(): Promise<void>;
  snapshot(id: string): XauUsdSessionState["snapshots"] extends Map<string, infer V> ? V | undefined : never;
  decision(id: string): XauUsdSessionState["decisions"] extends Map<string, infer V> ? V | undefined : never;
  intent(id: string): XauUsdSessionState["intents"] extends Map<string, infer V> ? V | undefined : never;
  evidence(id: string): XauUsdSessionState["evidence"] extends Map<string, infer V> ? V | undefined : never;
}

function requireId(value: string, label: string): void {
  if (!recordIdSchema.safeParse(value).success) {
    throw new TradingDomainError("tool_rejected", `${label} is not a valid id`);
  }
}

function requireVersion(value: string, label: string): string {
  const text = value.trim();
  if (!text || text.length > 128) throw new TradingDomainError("tool_rejected", `${label} is missing`);
  return text;
}

function canonicalClock(clock: MarketClock): MarketClock {
  assertClockLimits(clock.limits);
  const received = canonicalizeUtc(clock.receivedAt);
  const processed = canonicalizeUtc(clock.processedAt);
  const canonical = { receivedAt: received.iso, processedAt: processed.iso, limits: clock.limits };
  assessClock(canonical.receivedAt, canonical);
  return canonical;
}

/** Open one XAUUSD investigation on the current OpenMausBot turn.
 * Construction does not call any tool. */
export function createXauUsdToolSession(grant: XauUsdTurnGrant): XauUsdToolSession {
  requireId(grant.agentRunId, "agentRunId");
  requireId(grant.correlation.runtimeThreadId, "runtimeThreadId");
  requireId(grant.correlation.runtimeTurnId, "runtimeTurnId");
  const environment = parseTradingEnvironment(grant.environment);
  if (!(AUTONOMY_LEVELS as readonly number[]).includes(grant.autonomyLevel)) {
    throw new TradingDomainError("autonomy_rejected", "autonomy level is not 0 through 5");
  }
  const permissions: TradingPermission[] = [];
  for (const permission of grant.permissions) {
    if (!(TRADING_PERMISSIONS as readonly string[]).includes(permission)) {
      throw new TradingDomainError("tool_rejected", "unknown trading permission");
    }
    if (!permissions.includes(permission)) permissions.push(permission);
  }
  if (grant.replay) {
    if (environment !== "SIMULATOR") {
      throw new TradingDomainError("environment_isolation", "replay cannot bind to PAPER or LIVE");
    }
    if (grant.provider !== grant.replay.provider) {
      throw new TradingDomainError("environment_isolation", "replay grant must use the replay provider");
    }
  }
  if (grant.provider.environment !== environment) {
    throw new TradingDomainError("environment_isolation", "provider environment does not match the trading run");
  }
  assertProvenanceForEnvironment(environment, grant.provider.successProvenance);
  const clock = canonicalClock(grant.replay ? grant.replay.marketClock() : grant.clock);
  let modelId = requireVersion(grant.modelId, "modelId");
  const modelProvider = requireVersion(grant.modelProvider, "modelProvider");
  let modelFallback: XauUsdSessionState["modelFallback"];
  if (grant.routing) {
    const selected = selectTradingModel(
      grant.routing.policy,
      grant.routing.taskClass,
      grant.routing.availableModelIds,
      modelId,
    );
    if (!selected.ok) throw new TradingDomainError("model_routing_rejected", selected.reason);
    if (selected.fallbackUsed) {
      modelFallback = { from: modelId, to: selected.modelId, policyVersion: selected.policyVersion };
    }
    modelId = selected.modelId;
  }
  const manifest = parseVersionManifest({
    schemaVersion: 1,
    id: grant.correlation.nextRecordId(),
    agentRunId: grant.agentRunId,
    environment,
    createdAt: clock.processedAt,
    runtimeVersion: XAUUSD_RUNTIME_VERSION,
    modelProvider,
    modelId,
    promptVersion: XAUUSD_AGENT_PROMPT_VERSION,
    toolCatalogVersion: XAUUSD_TOOL_CATALOG_VERSION,
    riskVersion: "not-implemented",
    policyVersion: "not-implemented",
    featureDataVersion: grant.replay ? "xauusd-replay-1" : "phase-3",
    ...(grant.replay ? { datasetVersion: grant.replay.datasetVersion } : {}),
  });
  if (grant.replay) assertReplayDataset(manifest);
  const state: XauUsdSessionState = {
    grant,
    manifest,
    clock,
    now() {
      return grant.replay ? canonicalClock(grant.replay.marketClock()) : clock;
    },
    gate: {
      environment,
      autonomyLevel: grant.autonomyLevel,
      permissions,
      specialistAttached: typeof grant.askSpecialist === "function",
      replayAttached: Boolean(grant.replay),
    },
    modelId,
    ...(modelFallback ? { modelFallback } : {}),
    activeRuntimeEventId: "",
    snapshots: new Map(),
    contexts: new Map(),
    evidence: new Map(),
    decisions: new Map(),
    intents: new Map(),
  };
  const filtered = filterToolCatalog(XAUUSD_TOOL_CATALOG, state.gate);
  const advertised = new Set(filtered.available.map((spec) => spec.name));
  const definitions: XauUsdToolDefinition[] = filtered.available.map((spec) => ({
    type: "function",
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.inputSchema as unknown as Record<string, unknown>,
    },
  }));
  const invocations: string[] = [];
  const tradingEvents: TradingEvent[] = [parseTradingEvent({
    schemaVersion: 1,
    eventId: grant.correlation.nextTradingEventId(),
    type: "agent.started",
    source: "trading-domain",
    at: clock.processedAt,
    agentRunId: grant.agentRunId,
    correlationId: grant.correlation.runtimeTurnId,
    environment,
    instrument: "XAUUSD",
    actor: "xauusd-tools",
    runtimeThreadId: grant.correlation.runtimeThreadId,
    runtimeTurnId: grant.correlation.runtimeTurnId,
    payload: {
      catalogVersion: XAUUSD_TOOL_CATALOG_VERSION,
      modelId,
      autonomyLevel: grant.autonomyLevel,
    },
  })];
  const runtimeEvents: RuntimeEvent[] = [];
  let closed = false;
  return {
    definitions,
    agentRunId: grant.agentRunId,
    catalogVersion: XAUUSD_TOOL_CATALOG_VERSION,
    environment,
    autonomyLevel: grant.autonomyLevel,
    modelId,
    ...(modelFallback ? { modelFallback } : {}),
    ignoredApprovalMode: grant.approvalMode,
    executionAuthority: false,
    occurrenceId: grant.correlation.occurrenceId ?? null,
    runtimeThreadId: grant.correlation.runtimeThreadId,
    invocations,
    tradingEvents,
    runtimeEvents,
    decisions: () => [...state.decisions.values()],
    intents: () => [...state.intents.values()],
    validate(name, args) {
      if (closed) throw new Error("XAUUSD tool session is closed");
      if (!advertised.has(name)) throw new Error(`tool ${name} is not available`);
      if (args === null || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("tool arguments must be an object");
      }
    },
    async execute(name, args, signal) {
      if (closed) throw new Error("XAUUSD tool session is closed");
      invocations.push(name);
      const result = await invokeXauUsdTool(state, name, args, signal);
      tradingEvents.push(...result.tradingEvents);
      runtimeEvents.push(...result.runtimeEvents);
      return { ok: result.ok, text: JSON.stringify(result.body) };
    },
    async close() {
      closed = true;
    },
    snapshot: (id) => state.snapshots.get(id),
    decision: (id) => state.decisions.get(id),
    intent: (id) => state.intents.get(id),
    evidence: (id) => state.evidence.get(id),
  };
}
