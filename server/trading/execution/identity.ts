import { contentHash } from "../replay/hash.ts";
import { EXECUTION_ENGINE_VERSION } from "./result.ts";

/** Stable attempt id. Sequence and state are part of it, so a later outcome
 * is a new id. This is not a broker order id. */
export function executionAttemptKey(input: {
  readonly executionIdentity: string;
  readonly executionRequestId: string;
  readonly sequence: number;
  readonly state: string;
}): string {
  return `exa.${contentHash({
    schema: EXECUTION_ENGINE_VERSION,
    role: "attempt",
    executionIdentity: input.executionIdentity,
    executionRequestId: input.executionRequestId,
    sequence: input.sequence,
    state: input.state,
  }).slice(0, 40)}`;
}
