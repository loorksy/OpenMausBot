import { TradingDomainError } from "./errors.ts";
import { seal } from "./ids.ts";
import type { TradingEnvironment } from "./environment.ts";
import type { XauUsdInstrument } from "./instrument.ts";

/** Identity shared by records whose history must not be rewritten. */
export interface ImmutableIdentity {
  readonly id: string;
  readonly supersedes?: string;
  readonly agentRunId: string;
  readonly environment: TradingEnvironment;
  readonly instrument?: XauUsdInstrument;
}

/** A revision is a new record. The previous object is left unchanged. */
export function reviseImmutable<T extends ImmutableIdentity>(previous: T, next: T): T {
  if (next.id === previous.id) {
    throw new TradingDomainError("immutable_revision", "A revision must allocate a new id");
  }
  if (next.supersedes !== previous.id) {
    throw new TradingDomainError("immutable_revision", "A revision must set supersedes to the previous id");
  }
  if (next.agentRunId !== previous.agentRunId) {
    throw new TradingDomainError("agent_run_mismatch", "A revision stays on the same agent_run_id");
  }
  if (next.environment !== previous.environment) {
    throw new TradingDomainError("environment_transition_rejected", "A revision cannot change environment");
  }
  if (previous.instrument !== undefined && next.instrument !== previous.instrument) {
    throw new TradingDomainError("instrument_rejected", "A revision cannot change the instrument");
  }
  return seal({ ...next });
}

export function requireAgentRun<T extends { readonly agentRunId: string }>(agentRunId: string, record: T): T {
  if (!agentRunId) {
    throw new TradingDomainError("agent_run_required", "agent_run_id is required");
  }
  if (record.agentRunId !== agentRunId) {
    throw new TradingDomainError("agent_run_mismatch", "Record agent_run_id does not match the active run");
  }
  return record;
}
