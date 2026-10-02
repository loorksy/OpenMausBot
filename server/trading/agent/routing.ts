/** Versioned model choice for a trading task class.
 * Selection uses the approved list only. It does not read the user text,
 * and the result never grants broker execution. */

export const TRADING_TASK_CLASSES = [
  "scan",
  "monitoring",
  "analysis",
  "scenario",
  "high-impact",
  "research",
] as const;

export type TradingTaskClass = (typeof TRADING_TASK_CLASSES)[number];

export interface ModelClassRoute {
  readonly models: readonly string[];
  readonly fallback?: string;
}

export interface ModelRoutingPolicy {
  readonly version: string;
  readonly classes: Partial<Record<TradingTaskClass, ModelClassRoute>>;
}

export type ModelRoutingDecision =
  | {
    readonly ok: true;
    readonly modelId: string;
    readonly fallbackUsed: boolean;
    readonly policyVersion: string;
    readonly executionAuthority: false;
  }
  | {
    readonly ok: false;
    readonly reason: "unapproved_model" | "model_unavailable" | "no_approved_fallback" | "unknown_task_class";
    readonly executionAuthority: false;
  };

function denied(
  reason: "unapproved_model" | "model_unavailable" | "no_approved_fallback" | "unknown_task_class",
): ModelRoutingDecision {
  return { ok: false, reason, executionAuthority: false };
}

export function selectTradingModel(
  policy: ModelRoutingPolicy,
  taskClass: string,
  availableModelIds: readonly string[],
  requestedModelId: string,
): ModelRoutingDecision {
  if (!(TRADING_TASK_CLASSES as readonly string[]).includes(taskClass)) return denied("unknown_task_class");
  const route = policy.classes[taskClass as TradingTaskClass];
  if (!route || route.models.length === 0) return denied("no_approved_fallback");
  if (!route.models.includes(requestedModelId)) return denied("unapproved_model");
  const available = new Set(availableModelIds);
  if (available.has(requestedModelId)) {
    return {
      ok: true,
      modelId: requestedModelId,
      fallbackUsed: false,
      policyVersion: policy.version,
      executionAuthority: false,
    };
  }
  if (!route.fallback || route.fallback === requestedModelId || !route.models.includes(route.fallback) || !available.has(route.fallback)) {
    return denied("no_approved_fallback");
  }
  return {
    ok: true,
    modelId: route.fallback,
    fallbackUsed: true,
    policyVersion: policy.version,
    executionAuthority: false,
  };
}
