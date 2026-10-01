export { parseGateConfig, GATE_ENGINE_VERSION } from "./config.ts";
export type { GateConfig } from "./config.ts";
export { evaluateFireTimeGate } from "./evaluate.ts";
export type { FireTimeGateInput, GateMarketFact } from "./evaluate.ts";
export { GATE_REASON_CODES, GATE_STATES, gateInfrastructureFact } from "./result.ts";
export type { GateDecision, GateReason, GateState } from "./result.ts";
