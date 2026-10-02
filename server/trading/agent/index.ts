/** XAUUSD tools for the existing OpenMausBot tool loop.
 * This module does not start turns, own an event bus, or submit orders. */

export {
  FORBIDDEN_EXECUTION_TOOL_NAMES,
  TRADING_PERMISSIONS,
  XAUUSD_TOOL_CATALOG,
  XAUUSD_TOOL_CATALOG_VERSION,
  catalogSchemaKeys,
  describeTool,
  filterToolCatalog,
  isForbiddenExecutionTool,
} from "./catalog.ts";
export type { ToolGate, TradingPermission, XauUsdToolSpec } from "./catalog.ts";

export { EVIDENCE_FENCE, fenceExternalEvidence, releaseEvidence } from "./evidence-fence.ts";
export type { XauUsdTurnGrant } from "./grant.ts";
export { TRADING_TASK_CLASSES, selectTradingModel } from "./routing.ts";
export type { ModelRoutingPolicy, TradingTaskClass } from "./routing.ts";
export { XAUUSD_AGENT_PROMPT_VERSION, XAUUSD_RUNTIME_VERSION, createXauUsdToolSession } from "./session.ts";
export type { XauUsdToolSession } from "./session.ts";
