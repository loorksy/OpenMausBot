import { FORBIDDEN_EXECUTION_TOOL_NAMES, isForbiddenExecutionTool, toolSpec } from "./catalog.ts";
import { fenceExternalEvidence } from "./evidence-fence.ts";
import { selectTradingModel, type ModelRoutingPolicy } from "./routing.ts";
import type { TradingEnvironment } from "../../../shared/trading/environment.ts";

/** A specialist result is evidence. It cannot carry an execution tool. */
export function admitSubagentResult(input: {
  readonly specialist: string;
  readonly text: string;
  readonly toolNames: readonly string[];
}): {
  readonly specialist: string;
  readonly executionAuthority: false;
  readonly admittedTools: readonly [];
  readonly rejectedTools: readonly string[];
  readonly untrusted: true;
} {
  const rejected = input.toolNames.filter((name) =>
    (FORBIDDEN_EXECUTION_TOOL_NAMES as readonly string[]).includes(name) || isForbiddenExecutionTool(name) || name.includes("close") || name.includes("submit") || name.includes("execute"),
  );
  return {
    specialist: input.specialist,
    executionAuthority: false,
    admittedTools: [],
    rejectedTools: rejected,
    untrusted: true,
  };
}

/** A discovered name is not an authorization. */
export function admitDiscoveredTool(name: string): { readonly name: string; readonly authorized: false; readonly reason: "forbidden" | "not_in_catalog" | "exists_is_not_authority" } {
  if (isForbiddenExecutionTool(name) || (FORBIDDEN_EXECUTION_TOOL_NAMES as readonly string[]).includes(name)) {
    return { name, authorized: false, reason: "forbidden" };
  }
  const spec = toolSpec(name);
  if (spec === undefined) return { name, authorized: false, reason: "not_in_catalog" };
  return { name, authorized: false, reason: "exists_is_not_authority" };
}

export function routeTradingModel(
  policy: ModelRoutingPolicy,
  taskClass: string,
  availableModelIds: readonly string[],
  requestedModelId: string,
) {
  const decision = selectTradingModel(policy, taskClass, availableModelIds, requestedModelId);
  return { ...decision, executionAuthority: false as const };
}

/** Browser and page text stays fenced. The fence cannot edit safety state. */
export function isolateExternalContent(input: {
  readonly id: string;
  readonly agentRunId: string;
  readonly environment: TradingEnvironment;
  readonly excerpt: string;
  readonly receivedAt: string;
  readonly createdAt: string;
  readonly sourceUrl?: string;
}) {
  const fenced = fenceExternalEvidence({ ...input, kind: "website" });
  return {
    evidenceId: fenced.evidence.id,
    fence: fenced.fence,
    executionAuthority: false as const,
  };
}
