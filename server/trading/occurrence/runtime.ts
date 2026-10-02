import type { AutonomyLevel } from "../../../shared/trading/autonomy.ts";
import type { TradingEnvironment } from "../../../shared/trading/environment.ts";
import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { assertNoSecretFields, recordIdSchema, utcTimestampSchema } from "../../../shared/trading/ids.ts";
import type { XauUsdRoutineMarker } from "../../../shared/trading/routine-marker.ts";
import type { TradingPermission } from "../../../shared/trading/permissions.ts";
import type { XauUsdTurnGrant } from "../agent/grant.ts";
import type { XauUsdToolSession } from "../agent/session.ts";
import type { XauUsdMarketDataProvider } from "../infrastructure/market_data/provider.ts";
import { readXauUsdJobMount, XAUUSD_ENVIRONMENT_ENV, XAUUSD_STORE_PATH_ENV } from "../jobs/mount.ts";
import { routineAgentRunId, routineOccurrenceId } from "./identity.ts";
import type { TradingOccurrence } from "../persistence/occurrences.ts";
import { openTradingStore, type TradingStore } from "../persistence/store.ts";

/** Driver kinds whose turn loop is `createOpenAIChatRuntime`. The provider
 * creates the turn id, then this module can bind it. Every other driver
 * fails closed for an XAUUSD routine. */
export const XAUUSD_CHAT_DRIVER_KINDS = ["openai-compat", "grok", "minimax", "mistral"] as const;

const SUPPORTED_DRIVERS = new Set<string>(XAUUSD_CHAT_DRIVER_KINDS);

/** Same observation window the tool session already uses. This is not a
 * market-data provider and it does not choose SIMULATOR. */
const OBSERVATION_LIMITS = {
  staleAfterMs: 60_000,
  futureSkewMs: 2_000,
  abnormalLatencyMs: 5_000,
} as const;

const GRANT_SECRET_KEYS = new Set([
  "account",
  "accountid",
  "brokeraccount",
  "brokeraccountid",
  "brokertoken",
  "metaapitoken",
]);

export interface MarkedRoutineTurn {
  readonly routineId: string;
  readonly routineRunId: string;
  readonly marker: XauUsdRoutineMarker;
}

export interface XauUsdRoutineDispatch {
  readonly marker?: XauUsdRoutineMarker;
  readonly routineId: string;
  readonly routineRunId: string;
  readonly threadId: string;
  readonly driverKind: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly marketDataProvider: XauUsdMarketDataProvider | null;
  readonly startedAt: string;
  startTurn(): Promise<unknown>;
}

interface PendingRoutineTurn {
  readonly routineId: string;
  readonly routineRunId: string;
  readonly threadId: string;
  readonly occurrenceId: string;
  readonly agentRunId: string;
  readonly environment: TradingEnvironment;
  readonly autonomyLevel: AutonomyLevel;
  readonly permissions: readonly TradingPermission[];
  readonly provider: XauUsdMarketDataProvider;
  readonly store: TradingStore;
}

const pendingByThread = new Map<string, PendingRoutineTurn>();

let installedMarketDataProvider: XauUsdMarketDataProvider | null = null;

/** Production starts with no provider. A test or a later explicit installer
 * may set one. Nothing in this module invents a fixture. */
export function installXauUsdMarketDataProvider(provider: XauUsdMarketDataProvider | null): void {
  installedMarketDataProvider = provider;
}

export function readInstalledXauUsdMarketDataProvider(): XauUsdMarketDataProvider | null {
  return installedMarketDataProvider;
}

export function xauUsdRoutineTurnIsPending(threadId: string): boolean {
  return pendingByThread.has(threadId);
}

/** One active native run may carry the marker. Zero marked runs is an
 * ordinary turn. More than one match fails closed. */
export function markedRoutineForTurn(
  active: readonly { id: string; routineId: string }[],
  markerOf: (routineId: string) => XauUsdRoutineMarker | undefined,
): MarkedRoutineTurn | undefined {
  const marked: MarkedRoutineTurn[] = [];
  for (const run of active) {
    const marker = markerOf(run.routineId);
    if (marker) marked.push({ routineId: run.routineId, routineRunId: run.id, marker });
  }
  if (marked.length === 0) return undefined;
  if (marked.length !== 1 || active.length !== 1) {
    throw new TradingDomainError(
      "trading_store_rejected",
      "XAUUSD routine correlation was ambiguous. Failing closed.",
    );
  }
  return marked[0];
}

/** The native routine callback uses this. An unmarked run calls `startTurn`
 * immediately. A marked run reserves the occurrence, then uses the same
 * `startTurn`. */
export async function startNativeRoutineTurn(input: {
  readonly active: readonly { id: string; routineId: string }[];
  markerOf(routineId: string): XauUsdRoutineMarker | undefined;
  readonly threadId: string;
  readonly driverKind: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly marketDataProvider: XauUsdMarketDataProvider | null;
  readonly startedAt: string;
  startTurn(): Promise<unknown>;
}): Promise<void> {
  const marked = markedRoutineForTurn(input.active, input.markerOf);
  if (!marked) {
    await input.startTurn();
    return;
  }
  await dispatchXauUsdRoutineTurn({
    marker: marked.marker,
    routineId: marked.routineId,
    routineRunId: marked.routineRunId,
    threadId: input.threadId,
    driverKind: input.driverKind,
    env: input.env,
    marketDataProvider: input.marketDataProvider,
    startedAt: input.startedAt,
    startTurn: input.startTurn,
  });
}

/** Opens a trading store only when this routine turn is actually mounting
 * XAUUSD. Both configuration values absent leaves the turn ordinary. */
export async function dispatchXauUsdRoutineTurn(input: XauUsdRoutineDispatch): Promise<void> {
  if (!input.marker) {
    await input.startTurn();
    return;
  }
  const ticket = reserveXauUsdRoutineTurn(input);
  try {
    // A provider turn is already stored for this routine run. Starting
    // another one would be a second native turn on the same occurrence.
    if (!ticket.alreadyBound) await input.startTurn();
  } finally {
    ticket.release();
  }
}

/** Called by the OpenAI chat runtime after it has created `providerTurnId`
 * and emitted `turn.started`. Trading code does not mint that id. Absent
 * pending means this turn is ordinary and receives no grant. */
export function bindXauUsdProviderTurn(input: {
  readonly threadId: string;
  readonly providerTurnId: string;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly observedAt: string;
}): XauUsdTurnGrant | undefined {
  const pending = pendingByThread.get(input.threadId);
  if (!pending) return undefined;
  if (!recordIdSchema.safeParse(input.providerTurnId).success) {
    throw new TradingDomainError("trading_store_rejected", "Provider turn id was rejected. Failing closed.");
  }
  if (!utcTimestampSchema.safeParse(input.observedAt).success) {
    throw new TradingDomainError("trading_store_rejected", "XAUUSD observation time was rejected. Failing closed.");
  }
  const row = pending.store.occurrences.attachProviderTurn({
    routineId: pending.routineId,
    routineRunId: pending.routineRunId,
    threadId: pending.threadId,
    providerTurnId: input.providerTurnId,
  });
  if (row.agentRunId !== pending.agentRunId || row.occurrenceId !== pending.occurrenceId) {
    throw new TradingDomainError("agent_run_mismatch", "Trading occurrence identity changed. Failing closed.");
  }
  return assertXauUsdRuntimeGrant(grantFromPending(pending, input));
}

/** Writes the tool session's events and sealed decision onto the open
 * native occurrence. It does not assess risk, call the broker, or start
 * another turn. A session with no routine occurrence is left alone. */
export function sealNativeToolTurn(session: XauUsdToolSession): void {
  if (session.occurrenceId === null) return;
  const pending = pendingByThread.get(session.runtimeThreadId);
  if (pending === undefined || pending.occurrenceId !== session.occurrenceId || pending.agentRunId !== session.agentRunId) {
    throw new TradingDomainError(
      "trading_store_rejected",
      "Native trading records could not be sealed. Failing closed.",
    );
  }
  pending.store.appendEvents(session.tradingEvents);
  const decisions = session.decisions();
  for (const decision of decisions) pending.store.artifacts.writeDecision(decision);
  const latest = decisions[decisions.length - 1];
  if (latest === undefined) return;
  if (latest.agentRunId !== pending.agentRunId || latest.environment !== pending.environment) {
    throw new TradingDomainError("agent_run_mismatch", "Sealed decision does not match the occurrence. Failing closed.");
  }
  const intent = [...session.intents()].reverse().find((item) => item.decisionId === latest.id) ?? null;
  pending.store.occurrences.attachAuthoritativeRecords({
    occurrenceId: pending.occurrenceId,
    agentRunId: pending.agentRunId,
    environment: pending.environment,
    decisionId: latest.id,
    orderIntentId: intent?.id ?? null,
    riskDecisionId: null,
    policyDecisionId: null,
    approvalId: null,
    proposalBindingHash: null,
    failureCode: null,
    gateDecisionId: null,
    decision: latest,
    risk: null,
    policy: null,
    gate: null,
  });
}

export function assertXauUsdRuntimeGrant(value: XauUsdTurnGrant): XauUsdTurnGrant {
  assertNoSecretFields(value, "XAUUSD turn grant");
  rejectGrantSecrets(value, 0);
  if (value.correlation.runtimeTurnId === value.agentRunId) {
    throw new TradingDomainError("agent_run_mismatch", "A provider turn id is not an agent run id");
  }
  if (value.correlation.runtimeTurnId === value.correlation.runtimeThreadId) {
    throw new TradingDomainError("agent_run_mismatch", "A provider turn id is not a thread id");
  }
  if (value.correlation.runtimeTurnId === value.correlation.routineRunId) {
    throw new TradingDomainError("agent_run_mismatch", "A provider turn id is not a routine run id");
  }
  if (value.correlation.runtimeTurnId === value.correlation.occurrenceId) {
    throw new TradingDomainError("agent_run_mismatch", "A provider turn id is not an occurrence id");
  }
  return value;
}

function reserveXauUsdRoutineTurn(input: XauUsdRoutineDispatch): { release(): void; alreadyBound: boolean } {
  const marker = input.marker;
  if (!marker) return { release() {}, alreadyBound: false };
  const mount = readXauUsdJobMount(input.env);
  if (!mount.mounted) return { release() {}, alreadyBound: false };
  if (marker.environment !== mount.environment) {
    throw new TradingDomainError(
      "environment_isolation",
      "Routine environment does not match the configured XAUUSD environment. Failing closed.",
    );
  }
  if (!SUPPORTED_DRIVERS.has(input.driverKind)) {
    throw new TradingDomainError(
      "tool_unavailable",
      `XAUUSD runtime is not available for provider ${input.driverKind || "unknown"}. Failing closed.`,
    );
  }
  if (!input.marketDataProvider) {
    throw new TradingDomainError(
      "market_data_provider_unavailable",
      "XAUUSD market-data provider is not configured. Failing closed.",
    );
  }
  if (input.marketDataProvider.environment !== mount.environment) {
    throw new TradingDomainError(
      "environment_isolation",
      "Market-data provider environment does not match the XAUUSD runtime. Failing closed.",
    );
  }
  assertNoSecretFields(input.marketDataProvider, "XAUUSD market-data provider");
  rejectGrantSecrets(input.marketDataProvider, 0);
  if (!utcTimestampSchema.safeParse(input.startedAt).success) {
    throw new TradingDomainError("trading_store_rejected", "XAUUSD occurrence time was rejected. Failing closed.");
  }
  if (pendingByThread.has(input.threadId)) {
    throw new TradingDomainError(
      "trading_store_rejected",
      "XAUUSD routine correlation was ambiguous. Failing closed.",
    );
  }
  const store = openTradingStore({ path: mount.path, environment: mount.environment });
  try {
    const row = reuseOrInsertOccurrence(store, input, mount.environment);
    if (row.occurrenceId !== routineOccurrenceId(input.routineRunId) || row.agentRunId !== routineAgentRunId(input.routineRunId)) {
      throw new TradingDomainError("agent_run_mismatch", "Trading occurrence identity was rejected. Failing closed.");
    }
    const alreadyBound = row.providerTurnId !== null;
    if (!alreadyBound) pendingByThread.set(input.threadId, {
      routineId: input.routineId,
      routineRunId: input.routineRunId,
      threadId: input.threadId,
      occurrenceId: row.occurrenceId,
      agentRunId: row.agentRunId,
      environment: marker.environment,
      autonomyLevel: marker.autonomyLevel,
      permissions: [...marker.permissions],
      provider: input.marketDataProvider,
      store,
    });
    let released = false;
    return {
      alreadyBound,
      release() {
        if (released) return;
        released = true;
        const current = pendingByThread.get(input.threadId);
        if (current?.store === store) pendingByThread.delete(input.threadId);
        store.close();
      },
    };
  } catch (error) {
    store.close();
    pendingByThread.delete(input.threadId);
    throw error;
  }
}

function reuseOrInsertOccurrence(
  store: TradingStore,
  input: XauUsdRoutineDispatch,
  environment: TradingEnvironment,
): TradingOccurrence {
  const existing = store.occurrences.readByRoutineRun(input.routineRunId);
  if (existing) {
    assertReusableOccurrence(existing, input, environment);
    return existing;
  }
  try {
    const row = store.occurrences.insertRoutineOccurrence({
      routineId: input.routineId,
      routineRunId: input.routineRunId,
      threadId: input.threadId,
      environment,
      startedAt: input.startedAt,
    });
    if (row.providerTurnId !== null) {
      throw new TradingDomainError("trading_store_rejected", "A new occurrence already has a provider turn. Failing closed.");
    }
    return row;
  } catch (error) {
    const raced = store.occurrences.readByRoutineRun(input.routineRunId);
    if (!raced) throw error;
    assertReusableOccurrence(raced, input, environment);
    return raced;
  }
}

function assertReusableOccurrence(
  row: TradingOccurrence,
  input: XauUsdRoutineDispatch,
  environment: TradingEnvironment,
): void {
  if (
    row.routineId !== input.routineId
    || row.threadId !== input.threadId
    || row.environment !== environment
    || row.occurrenceId !== routineOccurrenceId(input.routineRunId)
    || row.agentRunId !== routineAgentRunId(input.routineRunId)
  ) {
    throw new TradingDomainError(
      "trading_store_rejected",
      "XAUUSD routine correlation did not match exactly one occurrence. Failing closed.",
    );
  }
}

function grantFromPending(
  pending: PendingRoutineTurn,
  input: { readonly providerTurnId: string; readonly modelProvider: string; readonly modelId: string; readonly observedAt: string },
): XauUsdTurnGrant {
  let runtime = 0;
  let trading = 0;
  let record = 0;
  const occurrenceId = pending.occurrenceId;
  return {
    agentRunId: pending.agentRunId,
    environment: pending.environment,
    autonomyLevel: pending.autonomyLevel,
    permissions: [...pending.permissions],
    clock: {
      receivedAt: input.observedAt,
      processedAt: input.observedAt,
      limits: OBSERVATION_LIMITS,
    },
    provider: pending.provider,
    correlation: {
      runtimeThreadId: pending.threadId,
      runtimeTurnId: input.providerTurnId,
      routineId: pending.routineId,
      routineRunId: pending.routineRunId,
      occurrenceId,
      nextRuntimeEventId: () => sequencedId("e", runtime += 1, occurrenceId),
      nextTradingEventId: () => sequencedId("v", trading += 1, occurrenceId),
      nextRecordId: () => sequencedId("r", record += 1, occurrenceId),
    },
    modelProvider: input.modelProvider,
    modelId: input.modelId,
  };
}

function sequencedId(prefix: string, sequence: number, occurrenceId: string): string {
  return `${prefix}${sequence}.${occurrenceId}`;
}

function rejectGrantSecrets(value: unknown, depth: number): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) rejectGrantSecrets(item, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (GRANT_SECRET_KEYS.has(key.toLowerCase().replace(/[_-]/g, ""))) {
      throw new TradingDomainError(
        "credentials_forbidden",
        "XAUUSD turn grant cannot carry broker credentials or secret fields",
      );
    }
    rejectGrantSecrets(child, depth + 1);
  }
}

export { XAUUSD_ENVIRONMENT_ENV, XAUUSD_STORE_PATH_ENV };
