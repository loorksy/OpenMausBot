import { TradingDomainError } from "../../../shared/trading/errors.ts";
import { seal } from "../../../shared/trading/ids.ts";
import { XAUUSD_AGENT_PROMPT_VERSION, XAUUSD_TOOL_CATALOG_VERSION, selectTradingModel, type XauUsdTurnGrant } from "../agent/index.ts";
import type { TradingTaskClass } from "../agent/routing.ts";
import { mountChatTools, type ChatToolSession } from "../../drivers/chat-mcp-tools.ts";
import { bindReplayGrant, createReplaySession, type MarketObservation, type ReplaySession } from "../replay/session.ts";
import { sha256 } from "../replay/hash.ts";
import type { EvaluationArchive } from "./archive.ts";
import type { EvaluationConfiguration } from "./config.ts";
import type { ReplayDataset } from "../replay/dataset.ts";
import {
  assessRecordedCalls,
  evaluationMetrics,
  redactSecrets,
  reduceEvaluationStatus,
  stepStatus,
  type RecordedCall,
} from "./judge.ts";
import type { EvaluationResult, EvaluationStatus, EvaluationStep, SafetyFinding, ToolFact } from "./result.ts";

/** One evaluation attempt. Configuration is already sealed. */
export interface EvaluationRun {
  readonly evaluationRunId: string;
  readonly attempt: number;
  readonly agentRunId: string;
  readonly runtimeThreadId: string;
  readonly configuration: EvaluationConfiguration;
  readonly dataset: ReplayDataset;
}

export interface EvaluationPlayInput {
  readonly session: ChatToolSession;
  readonly observation: MarketObservation;
  readonly point: {
    readonly sequence: number;
    readonly at: string;
    readonly evaluationRunId: string;
    readonly replaySessionId: string;
  };
  readonly signal: AbortSignal;
}

/** The model side of the existing tool contract. The driver does not call tools. */
export interface EvaluationPlayer {
  play(input: EvaluationPlayInput): Promise<void | {
    readonly reportedUsage?: {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly modelLatencyMs: number;
    };
  }>;
}

const started = new WeakSet<EvaluationRun>();

export function createEvaluationRun(
  configuration: EvaluationConfiguration,
  dataset: ReplayDataset,
  attempt: number,
): EvaluationRun {
  if (dataset.fingerprint !== configuration.datasetFingerprint || dataset.datasetId !== configuration.datasetId) {
    throw new TradingDomainError("evaluation_rejected", "dataset does not match the evaluation configuration");
  }
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TradingDomainError("evaluation_rejected", "evaluation attempt must be a positive integer");
  }
  const evaluationRunId = `eval-${sha256(`${configuration.configurationId}:${attempt}`)}`;
  return seal({
    evaluationRunId,
    attempt,
    agentRunId: `agent.${sha256(evaluationRunId)}`,
    runtimeThreadId: `thread.${sha256(`${evaluationRunId}:thread`).slice(0, 48)}`,
    configuration,
    dataset,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseBody(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (isRecord(value)) return value;
  } catch {
    return null;
  }
  return null;
}

function codeOf(body: Record<string, unknown> | null): string | null {
  return body && typeof body.code === "string" ? body.code : null;
}

function reportedUsage(value: void | { reportedUsage?: { inputTokens: number; outputTokens: number; modelLatencyMs: number } }): EvaluationStep["reportedUsage"] {
  const usage = value && typeof value === "object" ? value.reportedUsage : undefined;
  if (!usage) return null;
  const numbers = [usage.inputTokens, usage.outputTokens, usage.modelLatencyMs];
  if (numbers.some((item) => typeof item !== "number" || !Number.isFinite(item) || item < 0)) return null;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    modelLatencyMs: usage.modelLatencyMs,
    source: "model-adapter",
  };
}

function link(threadId: string, turnId: string): XauUsdTurnGrant["correlation"] {
  let runtime = 0;
  let trading = 0;
  let record = 0;
  return {
    runtimeThreadId: threadId,
    runtimeTurnId: turnId,
    nextRuntimeEventId: () => `e${runtime += 1}.${turnId}`,
    nextTradingEventId: () => `v${trading += 1}.${turnId}`,
    nextRecordId: () => `r${record += 1}.${turnId}`,
  };
}

interface BuiltStep {
  readonly step: EvaluationStep;
  readonly stale: boolean;
  readonly buckets: readonly ("ok" | "unavailable" | "invalid_input" | "tool_failure" | "safety")[];
  readonly malformedDecisions: number;
}

/** Advance replay time, then let the existing chat tool session run one turn. */
export async function executeEvaluationRun(
  run: EvaluationRun,
  player: EvaluationPlayer,
  options?: {
    readonly archive?: EvaluationArchive;
    readonly askSpecialist?: XauUsdTurnGrant["askSpecialist"];
    readonly signal?: AbortSignal;
  },
): Promise<EvaluationResult> {
  if (run.configuration.specialistAttached && !options?.askSpecialist) {
    throw new TradingDomainError("evaluation_rejected", "specialist callback is required when a specialist is attached");
  }
  if (started.has(run)) {
    throw new TradingDomainError("evaluation_rejected", "evaluation run already started");
  }
  started.add(run);
  const configuration = run.configuration;
  let selectedModelId: string | null = null;
  let fallbackUsed = false;
  let routingFailure: string | null = null;
  if (configuration.routing) {
    const selected = selectTradingModel(
      configuration.routing.policy,
      configuration.routing.taskClass,
      configuration.routing.availableModelIds,
      configuration.routing.requestedModelId,
    );
    if (!selected.ok) routingFailure = selected.reason;
    else {
      selectedModelId = selected.modelId;
      fallbackUsed = selected.fallbackUsed;
    }
  } else {
    selectedModelId = configuration.modelId;
  }
  const steps: BuiltStep[] = [];
  const driverFindings: SafetyFinding[] = [];
  let replay: ReplaySession | null = null;
  let sessionPromptVersion: string | null = null;
  let stopReason: EvaluationResult["stopReason"] = routingFailure ? "routing" : null;
  let mountFailed = false;
  let playerStopped = false;
  if (!routingFailure && !options?.signal?.aborted) {
    replay = createReplaySession({
      dataset: run.dataset,
      startAt: configuration.startAt,
      endAt: configuration.endAt,
      timeframes: configuration.timeframes,
      limits: configuration.limits,
      agentRunId: run.agentRunId,
      runtime: {
        threadId: run.runtimeThreadId,
        turnId: `replay.${run.evaluationRunId.slice(5, 21)}`,
      },
    });
    for (const point of configuration.schedule) {
      if (stopReason) break;
      let advanced = false;
      try {
        replay.advanceTo(point.at);
        advanced = true;
      } catch {
        driverFindings.push({
          code: "observation_mismatch",
          toolName: null,
          sequence: point.sequence,
          detail: "replay did not advance to the observation time",
        });
        stopReason = "safety";
      }
      if (!advanced || !replay) break;
      let observation: MarketObservation;
      try {
        observation = await replay.observe();
      } catch {
        driverFindings.push({
          code: "future_data",
          toolName: null,
          sequence: point.sequence,
          detail: "replay observation failed closed",
        });
        stopReason = "safety";
        break;
      }
      const turnId = `turn${point.sequence}.${run.evaluationRunId.slice(5, 21)}`;
      const base: XauUsdTurnGrant = {
        agentRunId: run.agentRunId,
        environment: "SIMULATOR",
        autonomyLevel: configuration.autonomyLevel,
        permissions: configuration.permissions,
        approvalMode: "ask",
        clock: replay.marketClock(),
        provider: replay.provider,
        correlation: link(run.runtimeThreadId, turnId),
        modelProvider: configuration.modelProvider,
        modelId: configuration.modelId,
        ...(configuration.routing ? {
          routing: {
            policy: configuration.routing.policy,
            taskClass: configuration.routing.taskClass as TradingTaskClass,
            availableModelIds: configuration.routing.availableModelIds,
          },
        } : {}),
        ...(options?.askSpecialist ? { askSpecialist: options.askSpecialist } : {}),
      };
      const controller = new AbortController();
      let inner: ChatToolSession | undefined;
      const calls: RecordedCall[] = [];
      const eventIds: string[][] = [];
      try {
        inner = await mountChatTools({ xauusd: bindReplayGrant(replay, base) }, controller.signal);
        if (!inner.xauusd) {
          mountFailed = true;
          stopReason = "mount";
          break;
        }
        sessionPromptVersion = XAUUSD_AGENT_PROMPT_VERSION;
        selectedModelId = inner.xauusd.modelId;
        fallbackUsed = inner.xauusd.modelFallback !== undefined;
        const trading = inner.xauusd;
        const session: ChatToolSession = {
          definitions: inner.definitions,
          validate: (name, args) => inner!.validate(name, args),
          close: () => inner!.close(),
          async execute(name, args, signal) {
            const before = trading.runtimeEvents.length;
            const index = calls.length;
            try {
              const result = await inner!.execute(name, args, signal);
              const body = parseBody(result.text);
              calls.push({
                name,
                catalogVersion: trading.catalogVersion,
                input: structuredClone(args),
                ok: result.ok,
                code: codeOf(body),
                body,
                thrown: false,
              });
              return result;
            } catch (error) {
              calls.push({
                name,
                catalogVersion: trading.catalogVersion,
                input: structuredClone(args),
                ok: false,
                code: null,
                body: null,
                thrown: true,
              });
              throw error;
            } finally {
              eventIds[index] = trading.runtimeEvents.slice(before).map((event) => event.eventId);
            }
          },
        };
        let usage: EvaluationStep["reportedUsage"] = null;
        let playerFailed = false;
        try {
          usage = reportedUsage(await player.play({
            session,
            observation,
            point: {
              sequence: point.sequence,
              at: point.at,
              evaluationRunId: run.evaluationRunId,
              replaySessionId: replay.replaySessionId,
            },
            signal: options?.signal ?? controller.signal,
          }));
        } catch {
          playerFailed = true;
        }
        let confirmedHash = observation.contentHash;
        try {
          confirmedHash = (await replay.observe()).contentHash;
        } catch {
          confirmedHash = "unconfirmed";
        }
        const assessment = assessRecordedCalls({
          boundary: observation,
          replayNow: replay.now(),
          confirmedHash,
          calls,
        });
        const findings = assessment.findings.map((item) => ({ ...item, sequence: point.sequence }));
        const trajectory: ToolFact[] = calls.map((call, index) => ({
          toolName: call.name,
          catalogVersion: call.catalogVersion,
          input: redactSecrets(call.input) as Record<string, unknown>,
          ok: call.ok,
          code: assessment.calls[index]?.code ?? call.code,
          replayTimestamp: observation.observationAt,
          agentRunId: run.agentRunId,
          evaluationRunId: run.evaluationRunId,
          runtimeEventIds: eventIds[index] ?? [],
          freshness: assessment.calls[index]?.freshness ?? null,
        }));
        const status = stepStatus({
          findings,
          quality: observation.quality,
          decisionAttempts: assessment.decisionAttempts,
          validDecisions: assessment.decisions.length,
          playerFailed,
        });
        steps.push({
          stale: assessment.stale,
          buckets: assessment.calls.map((call) => call.bucket),
          malformedDecisions: assessment.malformedDecisions,
          step: {
            sequence: point.sequence,
            at: point.at,
            evaluationRunId: run.evaluationRunId,
            replaySessionId: replay.replaySessionId,
            agentRunId: run.agentRunId,
            runtimeThreadId: run.runtimeThreadId,
            runtimeTurnId: turnId,
            observation,
            trajectory,
            decisions: assessment.decisions,
            orderIntents: assessment.orderIntents,
            evidence: assessment.evidence,
            safetyFindings: findings,
            tradingEvents: [...trading.tradingEvents],
            status,
            quality: observation.quality,
            futureOutcome: {
              status: "not-evaluated",
              snapshotId: observation.snapshotId,
              observationAt: observation.observationAt,
              decisionIds: assessment.decisions.map((decision) => decision.id),
            },
            reportedUsage: usage,
          },
        });
        if (status === "FAIL") stopReason = "safety";
        else if (playerFailed) {
          playerStopped = true;
          stopReason = "player";
        }
      } catch (error) {
        if (error instanceof TradingDomainError && error.code === "model_routing_rejected") {
          routingFailure = error.message;
          stopReason = "routing";
        } else {
          mountFailed = true;
          stopReason = "mount";
        }
      } finally {
        await inner?.close();
      }
    }
  } else if (options?.signal?.aborted && !routingFailure) {
    playerStopped = true;
    stopReason = "player";
  }
  if (replay && !replay.completed) replay.complete();
  const safetyFindings = [...driverFindings, ...steps.flatMap((item) => item.step.safetyFindings)];
  const statuses: EvaluationStatus[] = steps.map((item) => item.step.status);
  if (mountFailed) statuses.push("UNAVAILABLE");
  if (playerStopped && steps.length === 0) statuses.push("INVALID");
  let status = reduceEvaluationStatus(statuses, routingFailure !== null);
  if (safetyFindings.length > 0) status = "FAIL";
  const metrics = evaluationMetrics({
    steps: steps.map((item) => ({
      trajectory: item.step.trajectory,
      decisions: item.step.decisions,
      safetyFindings: item.step.safetyFindings,
      reportedUsage: item.step.reportedUsage,
      stale: item.stale,
      buckets: item.buckets,
      malformedDecisions: item.malformedDecisions,
    })),
    configurationId: configuration.configurationId,
    modelProvider: configuration.modelProvider,
    modelId: selectedModelId ?? configuration.modelId,
    promptVersion: configuration.promptVersion,
    catalogVersion: XAUUSD_TOOL_CATALOG_VERSION,
    findings: safetyFindings,
  });
  const result = seal({
    schemaVersion: 1 as const,
    evaluationRunId: run.evaluationRunId,
    attempt: run.attempt,
    configuration,
    configurationId: configuration.configurationId,
    comparisonKey: configuration.comparisonKey,
    status,
    stopReason,
    instrument: "XAUUSD" as const,
    environment: "SIMULATOR" as const,
    replaySessionId: replay?.replaySessionId ?? null,
    agentRunId: run.agentRunId,
    runtimeThreadId: run.runtimeThreadId,
    datasetId: configuration.datasetId,
    datasetVersion: configuration.datasetVersion,
    datasetFingerprint: configuration.datasetFingerprint,
    schedule: configuration.schedule.map((point) => ({
      sequence: point.sequence,
      at: point.at,
      evaluationRunId: run.evaluationRunId,
      replaySessionId: replay?.replaySessionId ?? null,
    })),
    model: {
      provider: configuration.modelProvider,
      id: selectedModelId,
      requestedId: configuration.modelId,
      promptVersion: configuration.promptVersion,
      sessionPromptVersion,
      catalogVersion: XAUUSD_TOOL_CATALOG_VERSION,
      determinism: "not-guaranteed" as const,
    },
    routing: {
      policyVersion: configuration.routing?.policyVersion ?? null,
      taskClass: configuration.routing?.taskClass ?? null,
      requestedModelId: configuration.modelId,
      selectedModelId,
      fallbackUsed,
      failure: routingFailure,
      executionAuthority: false as const,
    },
    executionAuthority: false as const,
    memoryMutated: false as const,
    brokerContacted: false as const,
    steps: steps.map((item) => item.step),
    safetyFindings,
    metrics,
    replayEvents: replay ? [...replay.events] : [],
    futureOutcome: { status: "not-evaluated" as const },
    interpretation: "not-evaluated" as const,
  });
  options?.archive?.put(result);
  return result;
}
